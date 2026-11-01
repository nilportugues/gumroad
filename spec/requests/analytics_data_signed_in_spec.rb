# frozen_string_literal: true

require "spec_helper"

# Signed-in requests to /analytics/data/by_date, by_state and by_referral, recorded for the Next.js port
# (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/analytics-data.replay.test.ts, which sends the last
# request of each example. The clock is frozen at PARITY_NOW (the replay freezes the same instant) because the
# answers hold calendar labels and, for large sellers, cache keys made of dates.
describe "Sales analytics data when signed in", type: :request, elasticsearch_wait_for_refresh: true do
  include Parity::AudienceSignedIn
  include ProductPageViewHelpers

  PARITY_NOW = Time.utc(2026, 11, 2, 15, 0, 0)
  JSON_HEADERS = { "Accept" => "application/json" }.freeze

  let(:seller) { create(:user, name: "Analytics Seller", created_at: 120.days.ago) }
  let(:product) { create(:product, user: seller, name: "Alpha", unique_permalink: "alpha") }
  let(:other_product) { create(:product, user: seller, name: "Beta", unique_permalink: "beta") }

  before do
    travel_to(PARITY_NOW)
    host! DOMAIN
    Purchase.__elasticsearch__.create_index!(force: true)
    ProductPageView.__elasticsearch__.create_index!(force: true)
  end

  after { travel_back }

  def sell(item, days_ago:, hour: 10, price_cents: 500, **attributes)
    create(:purchase, link: item, seller:, price_cents:, created_at: days_ago.days.ago.in_time_zone(seller.timezone).change(hour:, min: 30).utc, **attributes)
  end

  def view(item, days_ago:, hour: 11, **body)
    add_page_view(item, days_ago.days.ago.in_time_zone(seller.timezone).change(hour:, min: 5).utc.iso8601, { country: "United States", state: "CA" }.merge(body))
  end

  def seed_activity
    sell(product, days_ago: 6, referrer: "https://www.google.com/search")
    sell(product, days_ago: 6, hour: 14, price_cents: 900, ip_country: "France", referrer: "https://twitter.com/a")
    sell(product, days_ago: 4, ip_country: "United States", ip_state: "NY")
    sell(other_product, days_ago: 3, price_cents: 1200, ip_country: "Canada", referrer: "recommended_by_gumroad")
    sell(other_product, days_ago: 1, ip_country: nil)
    sell(other_product, days_ago: 1, hour: 18, price_cents: 300, stripe_refunded: true)
    view(product, days_ago: 6, referrer_domain: "google.com")
    view(product, days_ago: 6, hour: 12, referrer_domain: "google.com", country: "France", state: nil)
    view(product, days_ago: 4, referrer_domain: "twitter.com", state: "NY")
    view(other_product, days_ago: 3, referrer_domain: "recommended_by_gumroad", country: "Canada", state: nil)
    view(other_product, days_ago: 2, referrer_domain: "direct", country: nil, state: nil)
    view(other_product, days_ago: 1, referrer_domain: "example.org", state: "other")
    view(other_product, days_ago: 1, hour: 20, referrer_domain: "example.org", state: "XX")
    index_model_records(Purchase)
    EsClient.indices.refresh(index: ProductPageView.index_name)
  end

  def range(from_days_ago, to_days_ago)
    { start_time: from_days_ago.days.ago.to_date.to_s, end_time: to_days_ago.days.ago.to_date.to_s }
  end

  def fetch(path, params = {}, headers: JSON_HEADERS)
    get path, params:, headers:
  end

  it "answers views, sales and totals per product and day", parity: true do
    seed_activity
    log_in(seller)

    fetch(analytics_data_by_date_path, range(8, 0))

    expect(response).to be_successful
    expect(response.parsed_body["by_date"].keys).to eq(%w[views sales totals])
  end

  it "leaves out days before the seller joined and after today", parity: true do
    seed_activity
    seller.update!(created_at: 5.days.ago)
    log_in(seller)

    fetch(analytics_data_by_date_path, range(30, -4))

    expect(response).to be_successful
  end

  it "reads the range from a timestamp followed by a location in parentheses", parity: true do
    seed_activity
    log_in(seller)

    fetch(analytics_data_by_date_path, { start_time: "#{6.days.ago.to_date} (Pacific Time)", end_time: "#{1.day.ago.to_date}T23:59:59-07:00 (Pacific Time)" })

    expect(response).to be_successful
  end

  it "falls back to the trailing thirty days when the range cannot be parsed", parity: true do
    seed_activity
    log_in(seller)

    fetch(analytics_data_by_date_path, { start_time: "garbage", end_time: "never" })

    expect(response).to be_successful
  end

  it "answers a seller without products", parity: true do
    log_in(seller)

    fetch(analytics_data_by_date_path, range(3, 0))

    expect(response).to be_successful
  end

  it "counts views and sales per country, and per state inside the United States", parity: true do
    seed_activity
    log_in(seller)

    fetch(analytics_data_by_state_path, range(8, 0))

    expect(response).to be_successful
    expect(response.parsed_body["by_state"].keys).to eq(%w[views sales totals])
  end

  it "names the referrers and groups the rest by domain", parity: true do
    seed_activity
    log_in(seller)

    fetch(analytics_data_by_referral_path, range(8, 0))

    expect(response).to be_successful
    expect(response.parsed_body["by_referral"]["views"]["alpha"].keys).to include("Google", "Twitter")
  end

  it "answers the hourly interval from live data in the seller's time zone", parity: true do
    seller.update!(timezone: "Pacific Time (US & Canada)")
    seed_activity
    log_in(seller)

    fetch(analytics_data_by_referral_path, range(2, 0).merge(interval: "hour"))

    expect(response).to be_successful
  end

  it "refuses an hourly range that ends before it starts", parity: true do
    log_in(seller)

    fetch(analytics_data_by_referral_path, { start_time: 1.day.ago.to_date.to_s, end_time: 3.days.ago.to_date.to_s, interval: "hour" })

    expect(response).to have_http_status(:bad_request)
  end

  it "refuses an hourly range longer than a week", parity: true do
    log_in(seller)

    fetch(analytics_data_by_referral_path, range(20, 0).merge(interval: "hour"))

    expect(response).to have_http_status(:bad_request)
  end

  it "lets an accountant on the team read the seller's analytics", parity: true do
    seed_activity
    member = create(:user)
    membership = create(:team_membership, user: member, seller:, role: TeamMembership::ROLE_ACCOUNTANT)
    log_in(member)
    switch_to(membership)

    fetch(analytics_data_by_date_path, range(8, 0))

    expect(response).to be_successful
  end

  it "asks a signed-in user without an email to add one, as JSON", parity: true do
    log_in(seller)
    seller.update_columns(email: nil)

    fetch(analytics_data_by_date_path, range(8, 0))

    expect(response).to have_http_status(:forbidden)
  end

  it "sends a signed-in user without an email to the main settings for an HTML request", parity: true do
    log_in(seller)
    seller.update_columns(email: nil)

    fetch(analytics_data_by_state_path, range(8, 0), headers: {})

    expect(response).to redirect_to(settings_main_path)
  end

  describe "for a large seller" do
    before { create(:large_seller, user: seller) }

    # Days up to two days ago are read from ComputedSalesAnalyticsDay; the cache is filled the way the nightly job does.
    def warm_cache
      CreatorAnalytics::CachingProxy.new(seller).generate_cache
    end

    it "serves cached days and computes the days the cache does not hold, by date", parity: true do
      seed_activity
      warm_cache
      sell(product, days_ago: 6, hour: 16, price_cents: 7_000)
      index_model_records(Purchase)
      log_in(seller)

      fetch(analytics_data_by_date_path, range(8, 0))

      expect(response).to be_successful
    end

    it "serves cached days by state", parity: true do
      seed_activity
      warm_cache
      log_in(seller)

      fetch(analytics_data_by_state_path, range(8, 0))

      expect(response).to be_successful
    end

    it "serves cached days by referral", parity: true do
      seed_activity
      warm_cache
      log_in(seller)

      fetch(analytics_data_by_referral_path, range(8, 0))

      expect(response).to be_successful
    end

    it "computes every day when nothing is cached", parity: true do
      seed_activity
      log_in(seller)

      fetch(analytics_data_by_date_path, range(8, 0))

      expect(response).to be_successful
    end

    it "ignores a cache written under an older cache version", parity: true do
      seed_activity
      warm_cache
      $redis.set(RedisKey.seller_analytics_cache_version, 4)
      log_in(seller)

      fetch(analytics_data_by_date_path, range(8, 0))

      expect(response).to be_successful
    end
  end
end
