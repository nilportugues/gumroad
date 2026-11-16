# frozen_string_literal: true

require "spec_helper"

# The large-seller paths of /dashboard/churn and /dashboard/sales (LargeSeller.create_if_warranted and the
# ComputedSalesAnalyticsDay cache), recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/analytics-data.replay.test.ts, which sends the last request of each example. The clock is
# frozen because the cache keys are made of dates.
describe "Churn and sales dashboards for large sellers when signed in", type: :request, elasticsearch_wait_for_refresh: true do
  include Parity::AudienceSignedIn

  let(:seller) { create(:user, name: "Large Seller", created_at: 120.days.ago) }

  before do
    travel_to(Time.utc(2026, 11, 2, 15, 0, 0))
    host! DOMAIN
    Purchase.__elasticsearch__.create_index!(force: true)
  end

  after { travel_back }

  def at_midday(days_ago) = days_ago.days.ago.in_time_zone(seller.timezone).change(hour: 12).utc

  def subscribe(product, created_days_ago:, cancelled_days_ago: nil, price_cents: 500)
    price = create(:price, link: product, price_cents:, recurrence: BasePrice::Recurrence::MONTHLY)
    subscription = create(
      :subscription,
      link: product,
      user: seller,
      cancelled_at: cancelled_days_ago && at_midday(cancelled_days_ago),
      deactivated_at: cancelled_days_ago && at_midday(cancelled_days_ago),
      price:
    )
    create(:purchase, link: product, seller:, subscription:, is_original_subscription_purchase: true, created_at: at_midday(created_days_ago), price_cents:)
  end

  def churn_range = { from: 20.days.ago.to_date.to_s, to: 3.days.ago.to_date.to_s }

  def seed_subscriptions
    create(:large_seller, user: seller)
    alpha = create(:product, :is_subscription, user: seller, name: "Alpha membership")
    subscribe(alpha, created_days_ago: 60)
    subscribe(alpha, created_days_ago: 30, cancelled_days_ago: 10)
    subscribe(alpha, created_days_ago: 12, cancelled_days_ago: 5)
    index_model_records(Purchase)
  end

  describe "churn" do
    it "computes a range that ended at least two days ago and stores it in the analytics cache", parity: true do
      seed_subscriptions
      log_in(seller)

      get churn_dashboard_path(churn_range)

      expect(response).to be_successful
      expect(ComputedSalesAnalyticsDay.count).to eq(1)
    end

    it "serves a range from the analytics cache once it is stored", parity: true do
      seed_subscriptions
      log_in(seller)
      get churn_dashboard_path(churn_range)
      # The cached document wins over the data: a sale made after the range was stored does not show.
      subscribe(Link.last, created_days_ago: 8)
      index_model_records(Purchase)

      get churn_dashboard_path(churn_range)

      expect(response).to be_successful
      expect(ComputedSalesAnalyticsDay.count).to eq(1)
    end

    it "does not cache a range that includes the last two days", parity: true do
      seed_subscriptions
      log_in(seller)

      get churn_dashboard_path(from: 20.days.ago.to_date.to_s, to: 1.day.ago.to_date.to_s)

      expect(response).to be_successful
      expect(ComputedSalesAnalyticsDay.count).to eq(0)
    end

    it "keeps a cache written under an older cache version out of the answer", parity: true do
      seed_subscriptions
      log_in(seller)
      get churn_dashboard_path(churn_range)
      $redis.set(RedisKey.seller_analytics_cache_version, 2)

      get churn_dashboard_path(churn_range)

      expect(response).to be_successful
      expect(ComputedSalesAnalyticsDay.count).to eq(2)
    end

    it "does not cache anything for a seller who is not a large seller", parity: true do
      alpha = create(:product, :is_subscription, user: seller, name: "Alpha membership")
      subscribe(alpha, created_days_ago: 30)
      index_model_records(Purchase)
      log_in(seller)

      get churn_dashboard_path(churn_range)

      expect(response).to be_successful
      expect(ComputedSalesAnalyticsDay.count).to eq(0)
    end
  end

  describe "sales analytics" do
    # Not recorded: a thousand purchase rows make a fixture of ten megabytes. large-seller.test.ts pins the boundary.
    # LargeSeller::SALES_LOWER_LIMIT purchase rows, free ones included, copied from one real purchase.
    def sell_the_lower_limit(count)
      product = create(:product, user: seller, name: "Popular")
      template = create(:purchase, link: product, seller:, price_cents: 0, stripe_fingerprint: nil, stripe_transaction_id: nil, charge_processor_id: nil, merchant_account: nil)
      rows = Array.new(count - 1) { |index| template.attributes.except("id").merge("email" => "buyer#{index}@example.com", "unique_permalink" => nil) }
      Purchase.insert_all(rows.map { _1.slice(*Purchase.column_names) })
    end

    it "records a seller with a thousand sales as a large seller" do
      sell_the_lower_limit(LargeSeller::SALES_LOWER_LIMIT)
      log_in(seller)

      get sales_dashboard_path

      expect(response).to be_successful
      expect(LargeSeller.find_by(user: seller).sales_count).to eq(LargeSeller::SALES_LOWER_LIMIT)
    end

    it "leaves a seller with one sale fewer than the limit alone" do
      sell_the_lower_limit(LargeSeller::SALES_LOWER_LIMIT - 1)
      log_in(seller)

      get sales_dashboard_path

      expect(response).to be_successful
      expect(LargeSeller.count).to eq(0)
    end
  end
end
