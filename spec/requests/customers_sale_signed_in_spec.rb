# frozen_string_literal: true

require "spec_helper"

# The sale panel of the customers page, recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/customers-sale.replay.test.ts, which sends the last request of each example: GET /customers/sale/:purchase_id
# and the JSON it fetches (charges, customer_emails, missed_posts, product_purchases).
describe "Customers sale panel when signed in", type: :request, elasticsearch_wait_for_refresh: true do
  include Parity::AudienceSignedIn

  JSON_HEADERS = { "Accept" => "application/json" }.freeze

  let(:seller) { create(:user, name: "Sale Seller", created_at: 120.days.ago) }
  let(:product) { create(:product, user: seller, name: "Alpha") }

  before do
    host! DOMAIN
    Purchase.__elasticsearch__.create_index!(force: true)
  end

  # Midday, so the replay clock (whole hours) cannot move a sale across the seller's day boundary.
  def at_midday(days_ago) = days_ago.days.ago.in_time_zone(seller.timezone).change(hour: 12).utc

  def sell(link, days_ago:, **attributes)
    # The purchase factory charges a card through Stripe; the panel only reads the row.
    build(:purchase, link:, seller:, created_at: at_midday(days_ago), purchase_state: "successful", **attributes).tap { _1.save!(validate: false) }
  end

  def sell_membership(days_ago:, **attributes)
    membership = create(:membership_product, user: seller, name: "Club", price_cents: 500)
    subscription = create(:subscription, link: membership, user: nil)
    sell(membership, days_ago:, subscription:, is_original_subscription_purchase: true, price: membership.prices.alive.first, price_cents: 500, email: "member@example.com", **attributes)
  end

  def renew(first, days_ago:, **attributes)
    sell(first.link, days_ago:, subscription: first.subscription, price: first.price, price_cents: 500, email: first.email, **attributes)
  end

  def post_for(purchase, days_ago:, sent_days_ago: days_ago, **attributes)
    post = create(:published_installment, link: product, seller:, installment_type: "product", name: "Update #{days_ago}", published_at: at_midday(days_ago), **attributes)
    create(:creator_contacting_customers_email_info_delivered, purchase:, installment: post, sent_at: at_midday(sent_days_ago), delivered_at: at_midday(sent_days_ago))
    post
  end

  def page_props(response) = inertia_props_of(response)

  def fetch_json(path, params = {}) = get(path, params:, headers: JSON_HEADERS)

  it "redirects a signed-out visitor to the login page", parity: true do
    purchase = sell(product, days_ago: 3)

    get customer_sale_path(purchase.external_id)

    expect(response).to redirect_to(login_path(next: "/customers/sale/#{purchase.external_id}"))
  end

  it "renders the panel of a plain sale", parity: true do
    purchase = sell(product, days_ago: 3, full_name: "Ada Lovelace", email: "ada@example.com")
    log_in(seller)

    get customer_sale_path(purchase.external_id)

    expect(response).to be_successful
    props = page_props(response)
    expect(props["customer"]["email"]).to eq("ada@example.com")
    expect(props["charges"]).to eq([])
    expect(props["product_purchases"]).to eq([])
    expect(props["emails"].map { _1["type"] }).to eq(["receipt"])
  end

  it "answers 404 for the sale of another seller", parity: true do
    purchase = sell(product, days_ago: 3)
    purchase.update_columns(seller_id: create(:user).id)
    log_in(seller)

    get customer_sale_path(purchase.external_id)

    expect(response).to have_http_status(:not_found)
  end

  it "lists the receipts and charges of every payment of a member", parity: true do
    first = sell_membership(days_ago: 40)
    renew(first, days_ago: 10, stripe_partially_refunded: true)
    log_in(seller)

    get customer_sale_path(first.external_id)

    expect(response).to be_successful
    props = page_props(response)
    expect(props["charges"].size).to eq(2)
    expect(props["emails"].count { _1["type"] == "receipt" }).to eq(2)
  end

  it "lists the posts a customer was sent among the emails", parity: true do
    purchase = sell(product, days_ago: 20, email: "reader@example.com")
    create(:customer_email_info_delivered, purchase:, sent_at: at_midday(20), delivered_at: at_midday(20))
    post_for(purchase, days_ago: 9)
    post_for(purchase, days_ago: 4)
    log_in(seller)

    get customer_sale_path(purchase.external_id)

    expect(response).to be_successful
    expect(page_props(response)["emails"].map { _1["type"] }).to eq(%w[receipt post post])
  end

  it "lists the products of a bundle sale", parity: true do
    bundle = create(:product, :bundle, user: seller, name: "Bundle")
    bundle_purchase = sell(bundle, days_ago: 5, is_bundle_purchase: true, email: "bundler@example.com")
    inner = create(:product, user: seller, name: "Inner")
    product_purchase = sell(inner, days_ago: 5, is_bundle_product_purchase: true, email: "bundler@example.com")
    BundleProductPurchase.create!(bundle_purchase:, product_purchase:)
    log_in(seller)

    get customer_sale_path(bundle_purchase.external_id)

    expect(response).to be_successful
    expect(page_props(response)["product_purchases"].map { _1["product"]["name"] }).to eq(["Inner"])
  end

  it "charges a commission deposit and its completion", parity: true do
    commission_product = create(:commission_product, user: seller, name: "Portrait")
    deposit = sell(commission_product, days_ago: 6, is_commission_deposit_purchase: true, email: "patron@example.com")
    completion = sell(commission_product, days_ago: 2, is_commission_completion_purchase: true, email: "patron@example.com")
    commission = Commission.find_or_create_by!(deposit_purchase: deposit) { _1.status = Commission::STATUS_IN_PROGRESS }
    commission.update_columns(completion_purchase_id: completion.id, status: Commission::STATUS_COMPLETED)
    log_in(seller)

    get customer_sale_path(deposit.external_id)

    expect(response).to be_successful
    expect(page_props(response)["charges"].size).to eq(2)
  end

  it "lists the charges of a member by the email on the sale", parity: true do
    first = sell_membership(days_ago: 40)
    renew(first, days_ago: 10, stripe_refunded: true)
    log_in(seller)

    fetch_json(customer_charges_path(first.external_id), purchase_email: "member@example.com")

    expect(response).to be_successful
    expect(response.parsed_body.size).to eq(2)
  end

  it "lists no charges for a one-off sale", parity: true do
    purchase = sell(product, days_ago: 3, email: "ada@example.com")
    log_in(seller)

    fetch_json(customer_charges_path(purchase.external_id), purchase_email: "ada@example.com")

    expect(response).to be_successful
    expect(response.parsed_body).to eq([])
  end

  it "answers 404 for the charges of a sale under another email", parity: true do
    purchase = sell(product, days_ago: 3, email: "ada@example.com")
    log_in(seller)

    fetch_json(customer_charges_path(purchase.external_id), purchase_email: "someone@example.com")

    expect(response).to have_http_status(:not_found)
  end

  it "charges a commission deposit and its completion by email", parity: true do
    commission_product = create(:commission_product, user: seller, name: "Portrait")
    deposit = sell(commission_product, days_ago: 6, is_commission_deposit_purchase: true, email: "patron@example.com")
    completion = sell(commission_product, days_ago: 2, is_commission_completion_purchase: true, email: "patron@example.com", chargeback_date: at_midday(1))
    Commission.find_or_create_by!(deposit_purchase: deposit) { _1.status = Commission::STATUS_COMPLETED }.update_columns(completion_purchase_id: completion.id)
    log_in(seller)

    fetch_json(customer_charges_path(deposit.external_id), purchase_email: "patron@example.com")

    expect(response.parsed_body.map { _1["chargedback"] }).to eq([false, true])
  end

  it "lists the emails of a sale with its receipt and posts", parity: true do
    purchase = sell(product, days_ago: 20, email: "reader@example.com")
    create(:customer_email_info_opened, purchase:, sent_at: at_midday(20), delivered_at: at_midday(20), opened_at: at_midday(19))
    post_for(purchase, days_ago: 9)
    post_for(purchase, days_ago: 4)
    log_in(seller)

    fetch_json(customer_emails_path(purchase.external_id))

    expect(response).to be_successful
    expect(response.parsed_body.map { _1["type"] }).to eq(%w[receipt post post])
  end

  it "lists the receipts of every payment of a member", parity: true do
    first = sell_membership(days_ago: 40)
    renew(first, days_ago: 10)
    log_in(seller)

    fetch_json(customer_emails_path(first.external_id))

    expect(response.parsed_body.map { _1["type"] }).to eq(%w[receipt receipt])
  end

  it "answers 404 for the emails of the sale of another seller", parity: true do
    purchase = sell(product, days_ago: 3)
    purchase.update_columns(seller_id: create(:user).id)
    log_in(seller)

    fetch_json(customer_emails_path(purchase.external_id))

    expect(response).to have_http_status(:not_found)
  end

  it "hands a sale whose posts went out in the same second to Rails", parity: true do
    purchase = sell(product, days_ago: 20, email: "reader@example.com")
    post_for(purchase, days_ago: 9, name: "First")
    post_for(purchase, days_ago: 9, name: "Second")
    log_in(seller)

    fetch_json(customer_emails_path(purchase.external_id))

    expect(response).to be_successful
  end

  it "lists the receipt of a sale whose charge belongs to an order that has no receipt record", parity: true do
    purchase = sell(product, days_ago: 3)
    charge = create(:charge, seller:, purchases: [purchase])
    charge.order.purchases << purchase
    log_in(seller)

    fetch_json(customer_emails_path(purchase.external_id))

    expect(response.parsed_body.map { _1["type"] }).to eq(%w[receipt])
    expect(response.parsed_body.first["state"]).to eq("Delivered")
  end

  it "lists the receipt of a sale that belongs to an order without a charge", parity: true do
    purchase = sell(product, days_ago: 3)
    create(:order, purchases: [purchase])
    create(:customer_email_info_opened, purchase:, sent_at: at_midday(3), delivered_at: at_midday(3), opened_at: at_midday(2))
    log_in(seller)

    fetch_json(customer_emails_path(purchase.external_id))

    expect(response.parsed_body.map { _1["type"] }).to eq(%w[receipt])
    expect(response.parsed_body.first["state"]).to eq("Opened")
  end

  it "lists the posts a customer has not been sent", parity: true do
    purchase = sell(product, days_ago: 20, email: "reader@example.com")
    sent = post_for(purchase, days_ago: 9)
    older = create(:published_installment, link: product, seller:, installment_type: "product", name: "Older", published_at: at_midday(15))
    newer = create(:published_installment, link: product, seller:, installment_type: "product", name: "Newer", published_at: at_midday(5))
    log_in(seller)

    fetch_json(missed_posts_path(purchase.external_id), purchase_email: "reader@example.com")

    expect(response).to be_successful
    expect(response.parsed_body.map { _1["name"] }).to eq([newer.name, older.name])
    expect(response.parsed_body.map { _1["id"] }).not_to include(sent.external_id)
  end

  it "lists a post of another product and skips one that cannot be emailed", parity: true do
    purchase = sell(product, days_ago: 20, email: "reader@example.com")
    other = create(:product, user: seller, name: "Other")
    other_post = create(:published_installment, link: other, seller:, installment_type: "product", name: "For another product", published_at: at_midday(5))
    create(:published_installment, link: product, seller:, installment_type: "product", name: "Draft only for customers", published_at: at_midday(6), send_emails: false, shown_on_profile: true)
    seller_post = create(:published_installment, seller:, link: nil, installment_type: "seller", name: "To everyone", published_at: at_midday(7))
    log_in(seller)

    fetch_json(missed_posts_path(purchase.external_id), purchase_email: "reader@example.com")

    expect(response.parsed_body.map { _1["id"] }).to eq([other_post.external_id, seller_post.external_id])
  end

  it "lists no missed posts for a customer who unsubscribed", parity: true do
    purchase = sell(product, days_ago: 20, email: "reader@example.com", can_contact: false)
    create(:published_installment, link: product, seller:, installment_type: "product", published_at: at_midday(5))
    log_in(seller)

    fetch_json(missed_posts_path(purchase.external_id), purchase_email: "reader@example.com")

    expect(response.parsed_body).to eq([])
  end

  it "answers 404 for the missed posts of a sale under another email", parity: true do
    purchase = sell(product, days_ago: 20, email: "reader@example.com")
    log_in(seller)

    fetch_json(missed_posts_path(purchase.external_id), purchase_email: "other@example.com")

    expect(response).to have_http_status(:not_found)
  end

  it "lists the customers behind the products of a bundle", parity: true do
    bundle = create(:product, :bundle, user: seller, name: "Bundle")
    bundle_purchase = sell(bundle, days_ago: 5, is_bundle_purchase: true, email: "bundler@example.com")
    %w[One Two].each do |name|
      product_purchase = sell(create(:product, user: seller, name:), days_ago: 5, is_bundle_product_purchase: true, email: "bundler@example.com")
      BundleProductPurchase.create!(bundle_purchase:, product_purchase:)
    end
    log_in(seller)

    fetch_json(product_purchases_path(bundle_purchase.external_id))

    expect(response.parsed_body.map { _1["product"]["name"] }).to eq(%w[One Two])
  end

  it "lists no product purchases for a sale that is not a bundle", parity: true do
    purchase = sell(product, days_ago: 3)
    log_in(seller)

    fetch_json(product_purchases_path(purchase.external_id))

    expect(response.parsed_body).to eq([])
  end

  it "answers 404 for the product purchases of the sale of another seller", parity: true do
    purchase = sell(product, days_ago: 3)
    purchase.update_columns(seller_id: create(:user).id)
    log_in(seller)

    fetch_json(product_purchases_path(purchase.external_id))

    expect(response).to have_http_status(:not_found)
  end
end
