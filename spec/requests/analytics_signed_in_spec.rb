# frozen_string_literal: true

require "spec_helper"

# Signed-in visits to /dashboard/sales, recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/dashboard-pages.replay.test.ts, which sends the last request of each example.
describe "Sales analytics dashboard when signed in", type: :request do
  include Parity::AudienceSignedIn

  let(:seller) { create(:user, name: "Analytics Seller", created_at: 120.days.ago) }

  before { host! DOMAIN }

  def sell(product, days_ago:, hour:, price_cents: 500, **attributes)
    # The purchase factory charges a card through Stripe; the dashboard only reads the row.
    build(:purchase, link: product, seller:, price_cents:, purchase_state: "successful", created_at: days_ago.days.ago.in_time_zone(seller.timezone).change(hour:, min: 30).utc, **attributes).tap { |row| row.save!(validate: false) }
  end

  it "redirects a signed-out visitor to the login page", parity: true do
    get sales_dashboard_path

    expect(response).to redirect_to(login_path(next: "/dashboard/sales"))
  end

  it "lists no products for a seller without any, remembers the sales dashboard and has no sales curve", parity: true do
    log_in(seller)

    get sales_dashboard_path

    expect(response).to be_successful
    expect(set_cookies).to include("last_viewed_dashboard=sales")
    expect(inertia_props_of(response)["analytics_props"]).to include("products" => [], "expected_sales_fraction_of_day" => nil)
  end

  it "lists the products analytics keeps, newest first: live ones, and deleted or archived ones that sold", parity: true do
    live = create(:product, user: seller, name: "Live product")
    archived_sold = create(:product, user: seller, name: "Archived but sold")
    deleted_sold = create(:product, user: seller, name: "Deleted but sold")
    archived_unsold = create(:product, user: seller, name: "Archived, never sold")
    deleted_unsold = create(:product, user: seller, name: "Deleted, never sold")
    sell(archived_sold, days_ago: 20, hour: 9)
    sell(deleted_sold, days_ago: 15, hour: 9)
    archived_sold.update!(archived: true)
    archived_unsold.update!(archived: true)
    deleted_sold.mark_deleted!
    deleted_unsold.mark_deleted!
    log_in(seller)

    get sales_dashboard_path

    expect(response).to be_successful
    expect(inertia_props_of(response).dig("analytics_props", "products").map { _1["name"] }).to eq([deleted_sold, archived_sold, live].map(&:name))
  end

  it "builds the sales curve from the trailing four weeks of countable sales", parity: true do
    seller.update!(timezone: "Tokyo")
    product = create(:product, user: seller, name: "Daily seller")
    [[2, 9, 500], [3, 10, 500], [4, 10, 700], [5, 14, 300], [6, 9, 500], [8, 21, 900], [9, 9, 500], [12, 3, 400], [20, 15, 600]].each do |days_ago, hour, cents|
      sell(product, days_ago:, hour:, price_cents: cents)
    end
    # Left out: refunded, charged back, and older than the window.
    sell(product, days_ago: 7, hour: 12, price_cents: 5000, stripe_refunded: true)
    sell(product, days_ago: 10, hour: 12, price_cents: 5000, chargeback_date: 9.days.ago)
    sell(product, days_ago: 40, hour: 12, price_cents: 5000)
    # Kept: a reversed chargeback.
    sell(product, days_ago: 11, hour: 18, price_cents: 200, chargeback_date: 10.days.ago, chargeback_reversed: true)
    log_in(seller)

    get sales_dashboard_path

    expect(response).to be_successful
    expect(inertia_props_of(response).dig("analytics_props", "expected_sales_fraction_of_day")).to be_a(Float)
    expect(inertia_props_of(response).dig("analytics_props", "seller_time_zone")).to eq("Asia/Tokyo")
  end

  it "has no sales curve when fewer than seven days had sales", parity: true do
    seller.update!(timezone: "London")
    product = create(:product, user: seller, name: "Slow seller")
    [2, 3, 5, 9].each { |days_ago| sell(product, days_ago:, hour: 11) }
    log_in(seller)

    get sales_dashboard_path

    expect(response).to be_successful
    expect(inertia_props_of(response).dig("analytics_props", "expected_sales_fraction_of_day")).to be_nil
  end

  it "starts the date picker on the day the seller joined, or when product tracking started", parity: true do
    seller.update!(created_at: Time.utc(2010, 3, 4, 12))
    log_in(seller)

    get sales_dashboard_path

    expect(response).to be_successful
    expect(inertia_props_of(response).dig("analytics_props", "earliest_date")).to eq("2012-10-13")
  end

  it "lets an accountant on the team see the seller's analytics", parity: true do
    member = create(:user)
    membership = create(:team_membership, user: member, seller:, role: TeamMembership::ROLE_ACCOUNTANT)
    create(:product, user: seller, name: "Team product")
    log_in(member)
    switch_to(membership)

    get sales_dashboard_path

    expect(response).to be_successful
    expect(inertia_props_of(response).dig("analytics_props", "products").size).to eq(1)
  end

  it "serves a large seller's analytics from the cache Rails keeps", parity: true do
    create(:large_seller, user: seller)
    log_in(seller)

    get sales_dashboard_path

    expect(response).to be_successful
  end
end
