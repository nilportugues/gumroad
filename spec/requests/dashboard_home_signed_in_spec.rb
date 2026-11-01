# frozen_string_literal: true

require "spec_helper"

# Signed-in visits to /dashboard, recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/dashboard-home.replay.test.ts, which sends the last request of each example and
# rebuilds the purchases and follower event indices from the rows and documents the recorder captured.
describe "Dashboard home when signed in", type: :request, elasticsearch_wait_for_refresh: true do
  include Parity::AudienceSignedIn

  let(:seller) { create(:user, name: "Home Seller", created_at: 120.days.ago) }

  before do
    host! DOMAIN
    Purchase.__elasticsearch__.create_index!(force: true)
    ProductPageView.__elasticsearch__.create_index!(force: true)
    ConfirmedFollowerEvent.__elasticsearch__.create_index!(force: true)
  end

  def sign_in_with_indexed_sales
    index_model_records(Purchase)
    log_in(seller)
  end

  # Midday, so the replay clock (whole hours) cannot move a sale across the seller's day boundary.
  def at_midday(days_ago) = days_ago.days.ago.in_time_zone(seller.timezone).change(hour: 12).utc

  def sell(product, days_ago:, price_cents: 500, **attributes)
    create(:purchase, link: product, seller:, price_cents:, created_at: at_midday(days_ago), **attributes)
  end

  def follow(email, days_ago:)
    follower = create(:follower, user: seller, email:, confirmed_at: nil)
    follower.update!(confirmed_at: at_midday(days_ago))
    ElasticsearchIndexerWorker.drain
    ConfirmedFollowerEvent.__elasticsearch__.refresh_index!
  end

  it "redirects a signed-out visitor to the login page", parity: true do
    get dashboard_path

    expect(response).to redirect_to(login_path(next: "/dashboard"))
  end

  it "shows the getting started checklist to a seller with nothing yet", parity: true do
    log_in(seller)

    get dashboard_path

    expect(response).to be_successful
    expect(inertia_props_of(response).dig("creator_home", "has_sale")).to eq(false)
  end

  it "records which social connections were offered, once", parity: true do
    log_in(seller)

    get dashboard_path
    get dashboard_path

    expect(response).to be_successful
    expect(Event.where(event_name: "social_connect_offered").count).to eq(1)
  end

  it "does not offer a connection the seller already made", parity: true do
    seller.update!(twitter_user_id: "12345")
    log_in(seller)

    get dashboard_path

    expect(inertia_props_of(response).dig("creator_home", "social_connections")).to eq([{ "name" => "X", "connected" => true }])
  end

  it "offers the connections whose feature is active for the seller", parity: true do
    Feature.activate_user(:youtube_connect, seller)
    Feature.activate_user(:tiktok_connect, seller)
    log_in(seller)

    get dashboard_path

    expect(inertia_props_of(response).dig("creator_home", "social_connections").map { _1["name"] }).to eq(%w[X YouTube TikTok])
  end

  it "leaves the social connections out once the checklist is dismissed", parity: true do
    seller.update!(has_dismissed_getting_started_checklist: true)
    create(:product, user: seller)
    log_in(seller)

    get dashboard_path

    expect(inertia_props_of(response)["creator_home"]).to include("getting_started_dismissed" => true, "getting_started_stats" => { "first_product" => true })
    expect(inertia_props_of(response)["creator_home"]).not_to have_key("social_connections")
  end

  it "ticks off the checklist steps the seller completed", parity: true do
    create(:user_compliance_info, user: seller)
    product = create(:product, user: seller)
    sell(product, days_ago: 3)
    follow("fan@example.com", days_ago: 2)
    create(:installment, seller:, link: product, send_emails: true, published_at: 1.day.ago)
    seller.update!(payment_address: "seller@example.com")
    sign_in_with_indexed_sales

    get dashboard_path

    expect(response).to be_successful
    expect(inertia_props_of(response).dig("creator_home", "getting_started_stats")).to include("first_sale" => true, "first_follower" => true, "first_email" => true)
  end

  it "ranks the three best selling products and lists the sales and followers as activity", parity: true do
    alpha = create(:product, user: seller, name: "Alpha", price_cents: 500)
    beta = create(:product, user: seller, name: "Beta", price_cents: 700)
    gamma = create(:product, user: seller, name: "Gamma", price_cents: 300)
    delta = create(:product, user: seller, name: "Delta", price_cents: 900)
    sell(alpha, days_ago: 0, price_cents: 500)
    sell(alpha, days_ago: 4, price_cents: 500)
    sell(alpha, days_ago: 20, price_cents: 500)
    sell(beta, days_ago: 2, price_cents: 700)
    sell(beta, days_ago: 9, price_cents: 700)
    sell(gamma, days_ago: 12, price_cents: 300)
    sell(delta, days_ago: 40, price_cents: 900)
    follow("fan@example.com", days_ago: 1)
    sign_in_with_indexed_sales

    get dashboard_path

    expect(response).to be_successful
    expect(inertia_props_of(response).dig("creator_home", "sales").map { _1["name"] }).to eq(%w[Alpha Beta Gamma])
  end

  it "fills spare slots with the newest products analytics lists", parity: true do
    create(:product, user: seller, name: "Unsold one")
    create(:product, user: seller, name: "Unsold two")
    sign_in_with_indexed_sales

    get dashboard_path

    expect(inertia_props_of(response).dig("creator_home", "sales").map { _1["name"] }).to eq(["Unsold two", "Unsold one"])
  end

  it "counts a deleted product that sold in the ranking but does not show it", parity: true do
    gone = create(:product, user: seller, name: "Gone")
    kept = create(:product, user: seller, name: "Kept")
    sell(gone, days_ago: 3)
    sell(gone, days_ago: 4)
    sell(kept, days_ago: 5)
    gone.mark_deleted!
    sign_in_with_indexed_sales

    get dashboard_path

    expect(inertia_props_of(response).dig("creator_home", "sales").map { _1["name"] }).to eq(["Kept"])
  end

  it "reports the balance and the sales totals", parity: true do
    product = create(:product, user: seller)
    sell(product, days_ago: 2, price_cents: 1000)
    sell(product, days_ago: 15, price_cents: 2000)
    sell(product, days_ago: 60, price_cents: 3000)
    create(:balance, user: seller, amount_cents: 4200)
    sign_in_with_indexed_sales

    get dashboard_path

    expect(inertia_props_of(response).dig("creator_home", "balances")).to include("balance" => "$42")
  end

  it "shows the currency when the seller sells in another currency", parity: true do
    seller.update!(currency_type: "eur")
    log_in(seller)

    get dashboard_path

    expect(inertia_props_of(response).dig("creator_home", "balances", "balance")).to include("USD")
  end

  it "asks an unconfirmed owner to confirm the email address", parity: true do
    seller.update_columns(confirmed_at: nil, unconfirmed_email: "new-address@example.com")
    log_in(seller)

    get dashboard_path

    expect(inertia_props_of(response).dig("creator_home", "email_confirmation")).to eq("email" => "new-address@example.com", "can_resend" => true)
  end

  it "shows a team member the email notice without the resend call to action", parity: true do
    seller.update_columns(confirmed_at: nil)
    member = create(:user)
    membership = create(:team_membership, user: member, seller:, role: TeamMembership::ROLE_ADMIN)
    log_in(member)
    switch_to(membership)

    get dashboard_path

    expect(inertia_props_of(response).dig("creator_home", "email_confirmation", "can_resend")).to eq(false)
  end

  it "lets a support team member see the seller's dashboard", parity: true do
    member = create(:user)
    membership = create(:team_membership, user: member, seller:, role: TeamMembership::ROLE_SUPPORT)
    log_in(member)
    switch_to(membership)

    get dashboard_path

    expect(response).to be_successful
  end

  it "redirects a seller suspended for a terms violation to the products page", parity: true do
    seller.update_columns(user_risk_state: "suspended_for_tos_violation")
    log_in(seller)

    get dashboard_path

    expect(response).to redirect_to(products_url)
  end

  it "leaves the tax forms empty for a seller outside the US and has no 1099 notice", parity: true do
    create(:user_compliance_info, user: seller, country: "Canada")
    log_in(seller)

    get dashboard_path

    expect(inertia_props_of(response)["creator_home"]).to include("tax_center_enabled" => false, "tax_forms" => {}, "show_1099_download_notice" => false)
  end

  it "points a US seller to the tax center and shows the notice when last year's form exists", parity: true do
    create(:user_compliance_info, user: seller)
    create(:user_tax_form, user: seller, tax_year: Time.current.year - 1, tax_form_type: "us_1099_k")
    log_in(seller)

    get dashboard_path

    expect(inertia_props_of(response)["creator_home"]).to include("tax_center_enabled" => true, "tax_forms" => [], "show_1099_download_notice" => true)
  end

  it "reads the seller's first name from the compliance info", parity: true do
    create(:user_compliance_info, user: seller, first_name: "Alexandra")
    log_in(seller)

    get dashboard_path

    expect(inertia_props_of(response).dig("creator_home", "name")).to eq("Alexandra")
  end
end
