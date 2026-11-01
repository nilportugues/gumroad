# frozen_string_literal: true

require "spec_helper"

# Signed-in visits to the help center, recorded for the Next.js port (PARITY_RECORD=1): the shared
# props and filters a signed-in request goes through, with the real Rack stack and a real login so
# the session and remember cookies are the ones a browser holds. Replayed by
# nextjs/parity/__tests__/help-center-signed-in.replay.test.ts, which sends the last request of each
# example.
describe "Help center when signed in", type: :request do
  include ActiveSupport::Testing::TimeHelpers

  let(:seller) { create(:user, name: "Signed In Seller") }
  let(:article_path) { help_center_article_path(HelpCenter::Article.first) }

  before { host! DOMAIN }

  # Forgery protection is on in the test environment, so a page's token is fetched first. The login
  # page redirects a signed-in visitor, so any page will do.
  def csrf_token
    get help_center_category_path(HelpCenter::Category.first)
    inertia_props_of(response).fetch("authenticity_token")
  end

  def log_in(user)
    post login_path, params: { authenticity_token: csrf_token, user: { login_identifier: user.email, password: user.password } }
    expect(response).to have_http_status(:found)
    expect(set_cookies).to include("remember_user_token=")
  end

  def switch_to(team_membership)
    post sellers_switch_path, params: { authenticity_token: csrf_token, team_membership_id: team_membership.external_id }
    expect(response).to have_http_status(:no_content)
  end

  it "renders the article for a seller", parity: true do
    log_in(seller)

    get article_path

    expect(response).to be_successful
    expect(inertia_props_of(response)["logged_in_user"]).to include("email" => seller.email)
  end

  it "renders the index for a seller who sells and has a payout method", parity: true do
    seller.update!(payment_address: "seller@example.com")
    create(:product, user: seller)
    log_in(seller)

    get help_center_root_path

    expect(response).to be_successful
    expect(inertia_props_of(response)["current_seller"]).to include("can_publish_products" => true, "has_published_products" => true)
  end

  it "renders a category for a seller", parity: true do
    log_in(seller)

    get help_center_category_path(HelpCenter::Category.first)

    expect(response).to be_successful
  end

  it "answers an Inertia visit with the page as JSON", parity: true do
    log_in(seller)

    get article_path, headers: { "X-Inertia" => "true", "X-Requested-With" => "XMLHttpRequest" }

    expect(response).to be_successful
    expect(response.parsed_body["props"]).to include("logged_in_user", "current_seller", "current_user", "prompt_passkey_setup")
  end

  it "redirects an unknown article to the help center root", parity: true do
    log_in(seller)

    get help_center_article_path("no-such-article")

    expect(response).to redirect_to(help_center_root_path)
  end

  it "seeds the dashboard nav items of a seller who already has content once", parity: true do
    create(:product, user: seller)
    create(:free_purchase, purchaser: seller)
    log_in(seller)

    get article_path
    expect(DashboardNavPromotion.where(user_id: seller.id).pluck(:nav_item)).to include("seeded", "profile", "library")

    get help_center_root_path
    expect(DashboardNavPromotion.where(user_id: seller.id).count).to eq(DashboardNavPromotion.where(user_id: seller.id).distinct.count(:nav_item))
  end

  it "shows a team member the account they switched into", parity: true do
    member = create(:user, name: "Team Member")
    membership = create(:team_membership, user: member, seller:, role: TeamMembership::ROLE_SUPPORT)
    log_in(member)
    switch_to(membership)

    get article_path

    expect(response).to be_successful
    props = inertia_props_of(response)
    expect(props["current_seller"]).to include("email" => seller.email)
    expect(props["logged_in_user"]).to include("email" => member.email)
  end

  it "drops a current seller the member can no longer act for", parity: true do
    member = create(:user, name: "Former Team Member")
    membership = create(:team_membership, user: member, seller:, role: TeamMembership::ROLE_ADMIN)
    log_in(member)
    switch_to(membership)
    membership.update_column(:deleted_at, Time.current)

    get article_path

    expect(response).to be_successful
    expect(set_cookies).to include("current_seller_id=;")
    expect(inertia_props_of(response)["current_seller"]).to include("email" => member.email)
  end

  it "shows an admin the user they impersonate", parity: true do
    admin = create(:admin_user, name: "Gumroad Admin")
    log_in(admin)
    $redis.set(RedisKey.impersonated_user(admin.id), seller.id)

    get article_path

    expect(response).to be_successful
    props = inertia_props_of(response)
    expect(props["logged_in_user"]).to include("email" => seller.email)
    expect(props["current_user"]).to include("name" => "Gumroad Admin", "impersonated_user" => include("name" => "Signed In Seller"))
    expect(props["prompt_passkey_setup"]).to eq(false)
  end

  it "ends a session that was invalidated after it started", parity: true do
    log_in(seller)
    travel_to(2.seconds.from_now) { seller.invalidate_active_sessions! }

    get article_path

    expect(response).to redirect_to(login_path)
    expect(flash[:warning]).to eq("We're sorry; you have been logged out. Please login again.")
    expect(set_cookies).to include("remember_user_token=;")
  end

  def set_cookies = Array(response.headers["Set-Cookie"]).join("\n")

  def inertia_props_of(response)
    page = response.body[/<script[^>]*data-page="[^"]*"[^>]*>(.*?)<\/script>/m, 1] || CGI.unescapeHTML(response.body[/\sdata-page="([^"]*)"/, 1])
    JSON.parse(page)["props"]
  end
end
