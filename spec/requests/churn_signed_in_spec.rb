# frozen_string_literal: true

require "spec_helper"

# Signed-in visits to /dashboard/churn, recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/dashboard-pages.replay.test.ts, which sends the last request of each example and
# rebuilds the purchases index from the rows it seeds.
describe "Churn dashboard when signed in", type: :request, elasticsearch_wait_for_refresh: true do
  include Parity::AudienceSignedIn

  let(:seller) { create(:user, name: "Churn Seller", created_at: 120.days.ago) }

  before do
    host! DOMAIN
    Purchase.__elasticsearch__.create_index!(force: true)
  end

  # The purchases the example created, in the index the page searches.
  def sign_in_with_indexed_sales
    index_model_records(Purchase)
    log_in(seller)
  end

  # Midday, so the replay clock (whole hours) cannot move a sale across the seller's day boundary.
  def at_midday(days_ago) = days_ago.days.ago.in_time_zone(seller.timezone).change(hour: 12).utc

  def subscribe(product, created_days_ago:, cancelled_days_ago: nil, deactivated_days_ago: nil, price_cents: 500)
    price = create(:price, link: product, price_cents:, recurrence: BasePrice::Recurrence::MONTHLY)
    subscription = create(
      :subscription,
      link: product,
      user: seller,
      cancelled_at: cancelled_days_ago && at_midday(cancelled_days_ago),
      deactivated_at: deactivated_days_ago && at_midday(deactivated_days_ago),
      price:
    )
    create(:purchase, link: product, seller:, subscription:, is_original_subscription_purchase: true, created_at: at_midday(created_days_ago), price_cents:)
  end

  it "redirects a signed-out visitor to the login page", parity: true do
    get churn_dashboard_path

    expect(response).to redirect_to(login_path(next: "/dashboard/churn"))
  end

  it "has no churn to report for a seller without subscription products", parity: true do
    create(:product, user: seller, name: "One-off")
    create(:purchase, link: Link.last, seller:, created_at: at_midday(40))
    sign_in_with_indexed_sales

    get churn_dashboard_path

    expect(response).to be_successful
    expect(inertia_props_of(response).dig("churn", "metadata", "products")).to eq([])
  end

  it "counts cancellations, new subscribers and the active base per product and day", parity: true do
    alpha = create(:product, :is_subscription, user: seller, name: "Alpha membership")
    beta = create(:product, :is_subscription, user: seller, name: "Beta membership")
    subscribe(alpha, created_days_ago: 70)
    subscribe(alpha, created_days_ago: 50, cancelled_days_ago: 12, deactivated_days_ago: 12)
    subscribe(alpha, created_days_ago: 20)
    subscribe(alpha, created_days_ago: 9, cancelled_days_ago: 3, deactivated_days_ago: 3)
    subscribe(beta, created_days_ago: 45, cancelled_days_ago: 25, deactivated_days_ago: 25, price_cents: 1200)
    subscribe(beta, created_days_ago: 8)
    subscribe(beta, created_days_ago: 5, cancelled_days_ago: 1, deactivated_days_ago: 1, price_cents: 1200)
    sign_in_with_indexed_sales

    get churn_dashboard_path

    expect(response).to be_successful
    expect(inertia_props_of(response).dig("churn", "data", "current_period", "summary", "total", "churned_customers_count")).to be > 0
  end

  it "reads the date range the seller picked and compares it with the period before", parity: true do
    alpha = create(:product, :is_subscription, user: seller, name: "Alpha membership")
    subscribe(alpha, created_days_ago: 70)
    subscribe(alpha, created_days_ago: 50, cancelled_days_ago: 12, deactivated_days_ago: 12)
    subscribe(alpha, created_days_ago: 20, cancelled_days_ago: 6, deactivated_days_ago: 6)
    subscribe(alpha, created_days_ago: 9)
    sign_in_with_indexed_sales

    get churn_dashboard_path(from: 14.days.ago.to_date.to_s, to: 2.days.ago.to_date.to_s)

    expect(response).to be_successful
    expect(inertia_props_of(response).dig("churn", "metadata", "previous_period")).to be_present
  end

  it "clamps a range that starts before the seller's first sale and drops the previous period", parity: true do
    alpha = create(:product, :is_subscription, user: seller, name: "Alpha membership")
    subscribe(alpha, created_days_ago: 30, cancelled_days_ago: 4, deactivated_days_ago: 4)
    sign_in_with_indexed_sales

    get churn_dashboard_path(from: 400.days.ago.to_date.to_s, to: 1.day.from_now.to_date.to_s)

    expect(response).to be_successful
    expect(inertia_props_of(response).dig("churn", "metadata", "previous_period")).to be_nil
  end

  it "falls back to the default range when the dates cannot be parsed", parity: true do
    alpha = create(:product, :is_subscription, user: seller, name: "Alpha membership")
    subscribe(alpha, created_days_ago: 30, cancelled_days_ago: 4, deactivated_days_ago: 4)
    sign_in_with_indexed_sales

    get churn_dashboard_path(from: "nonsense", to: "x")

    expect(response).to be_successful
  end

  it "lets a support team member see the seller's churn", parity: true do
    member = create(:user)
    membership = create(:team_membership, user: member, seller:, role: TeamMembership::ROLE_SUPPORT)
    alpha = create(:product, :is_subscription, user: seller, name: "Alpha membership")
    subscribe(alpha, created_days_ago: 30, cancelled_days_ago: 4, deactivated_days_ago: 4)
    index_model_records(Purchase)
    log_in(member)
    switch_to(membership)

    get churn_dashboard_path

    expect(response).to be_successful
  end

  it "serves a large seller's ranges from the analytics cache Rails keeps", parity: true do
    create(:large_seller, user: seller)
    alpha = create(:product, :is_subscription, user: seller, name: "Alpha membership")
    subscribe(alpha, created_days_ago: 30, cancelled_days_ago: 4, deactivated_days_ago: 4)
    sign_in_with_indexed_sales

    get churn_dashboard_path

    expect(response).to be_successful
  end

  it "counts a subscription product that was archived after it sold", parity: true do
    alpha = create(:product, :is_subscription, user: seller, name: "Alpha membership")
    subscribe(alpha, created_days_ago: 30, cancelled_days_ago: 4, deactivated_days_ago: 4)
    alpha.update!(archived: true)
    create(:product, :is_subscription, user: seller, name: "Archived and unsold").update!(archived: true)
    sign_in_with_indexed_sales

    get churn_dashboard_path

    expect(response).to be_successful
    expect(inertia_props_of(response).dig("churn", "metadata", "products").map { _1["name"] }).to eq(["Alpha membership"])
  end
end
