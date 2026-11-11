# frozen_string_literal: true

require "spec_helper"

# Api::Mobile::AnalyticsController's data_by_date, by_date, by_state, by_referral and revenue_totals, recorded for the Next.js port
# (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/mobile-analytics.replay.test.ts. The clock is frozen at
# PARITY_NOW (the replay freezes the same instant) because the answers hold calendar labels and the seller's current day.
describe "Mobile API analytics", type: :request, elasticsearch_wait_for_refresh: true do
  include Parity::MobileApi
  include ProductPageViewHelpers

  PARITY_NOW = Time.utc(2026, 11, 2, 15, 0, 0) unless defined?(PARITY_NOW)

  let(:seller) { create(:user, name: "Analytics Seller", created_at: 120.days.ago) }
  let(:product) { create(:product, user: seller, name: "Alpha", unique_permalink: "alpha") }
  let(:other_product) { create(:product, user: seller, name: "Beta", unique_permalink: "beta") }

  before do
    travel_to(PARITY_NOW)
    Purchase.__elasticsearch__.create_index!(force: true)
    ProductPageView.__elasticsearch__.create_index!(force: true)
  end

  after { travel_back }

  def sell(item, days_ago:, hour: 10, minute: 30, price_cents: 500, **attributes)
    purchase_row(link: item, seller:, price_cents:, purchase_state: "successful", created_at: days_ago.days.ago.in_time_zone(seller.timezone).change(hour:, min: minute).utc, **attributes)
  end

  def view(item, days_ago:, hour: 11, **body)
    add_page_view(item, days_ago.days.ago.in_time_zone(seller.timezone).change(hour:, min: 5).utc.iso8601, { country: "United States", state: "CA" }.merge(body))
  end

  def seed_activity
    sell(product, days_ago: 6, referrer: "https://www.google.com/search")
    sell(product, days_ago: 6, hour: 14, price_cents: 900, ip_country: "France", referrer: "https://twitter.com/a")
    sell(product, days_ago: 0, ip_country: "United States", ip_state: "NY")
    sell(other_product, days_ago: 3, price_cents: 1200, ip_country: "Canada", referrer: "recommended_by_gumroad")
    sell(other_product, days_ago: 1, ip_country: nil)
    sell(other_product, days_ago: 1, hour: 18, price_cents: 300, stripe_refunded: true)
    view(product, days_ago: 6, referrer_domain: "google.com")
    view(product, days_ago: 0, referrer_domain: "twitter.com", state: "NY")
    view(other_product, days_ago: 3, referrer_domain: "recommended_by_gumroad", country: "Canada", state: nil)
    view(other_product, days_ago: 1, referrer_domain: "example.org", state: "other")
    index_model_records(Purchase)
    EsClient.indices.refresh(index: ProductPageView.index_name)
  end

  def fetch(path, params = {})
    seed_activity
    get "/mobile/analytics/#{path}", params: auth(seller, scopes: "creator_api").merge(params)
  end

  describe "revenue_totals" do
    it "totals the day, week, month and year", parity: true do
      fetch("revenue_totals")

      expect(response.parsed_body.keys).to eq(%w[day week month year])
    end

    it "is zero for a seller without sales", parity: true do
      get "/mobile/analytics/revenue_totals", params: auth(seller, scopes: "creator_api")

      expect(response.parsed_body["day"]["revenue"]).to eq(0)
    end

    it "refuses a token without the creator_api scope", parity: true do
      get "/mobile/analytics/revenue_totals", params: auth(seller)

      expect(response).to have_http_status(:forbidden)
    end
  end

  describe "data_by_date" do
    def seed_sales
      sell(product, days_ago: 0, hour: 9, email: "buyer-today@example.com")
      sell(product, days_ago: 0, hour: 12, price_cents: 750, email: "buyer-noon@example.com")
      sell(other_product, days_ago: 1, price_cents: 1200, email: "buyer-week@example.com")
      sell(other_product, days_ago: 40, minute: 0, price_cents: 300, stripe_refunded: true, email: "buyer-old@example.com")
      sell(product, days_ago: 3, minute: 0, price_cents: 900, chargeback_date: 2.days.ago)
      index_model_records(Purchase)
    end

    def fetch_sales(params = {})
      seed_sales
      get "/mobile/analytics/data_by_date", params: auth(seller, scopes: "creator_api").merge(params)
    end

    it "lists the sales and revenue of the current day", parity: true do
      fetch_sales(range: "day")

      expect(response.parsed_body["sales_count"]).to eq(2)
    end

    it "lists the sales and revenue of the current week", parity: true do
      fetch_sales(range: "week")

      expect(response.parsed_body["sales_count"]).to eq(2)
    end

    it "lists the sales and revenue of the current month", parity: true do
      fetch_sales(range: "month")

      expect(response.parsed_body["sales_count"]).to eq(3)
    end

    it "lists every sale for all time, refunded and charged back ones included", parity: true do
      fetch_sales(range: "all")

      expect(response.parsed_body["purchases"].size).to eq(5)
    end

    it "narrows the sales to a search query", parity: true do
      fetch_sales(range: "all", query: "buyer-week")

      expect(response.parsed_body["purchases"].size).to eq(1)
    end

    it "treats a blank query as no query", parity: true do
      fetch_sales(range: "month", query: "")

      expect(response).to be_successful
    end

    it "answers a seller without sales", parity: true do
      get "/mobile/analytics/data_by_date", params: auth(seller, scopes: "creator_api").merge(range: "year")

      expect(response.parsed_body).to include("sales_count" => 0, "purchases" => [])
    end

    it "refuses a token without the creator_api scope", parity: true do
      get "/mobile/analytics/data_by_date", params: auth(seller).merge(range: "day")

      expect(response).to have_http_status(:forbidden)
    end
  end

  describe "products" do
    # Newest first: the sold-then-archived and sold-then-deleted products stay, the unsold archived and deleted ones go.
    let!(:old_sold_archived) { create(:product, user: seller, name: "Old archived", archived: true) }
    let!(:old_unsold_archived) { create(:product, user: seller, name: "Unsold archived", archived: true) }
    let!(:old_sold_deleted) { create(:product, user: seller, name: "Old deleted", deleted_at: 2.days.ago) }
    let!(:old_unsold_deleted) { create(:product, user: seller, name: "Unsold deleted", deleted_at: 2.days.ago) }
    let!(:live) { create(:product, user: seller, name: "Live") }

    before do
      create(:product, name: "Someone else's")
      sell(old_sold_archived, days_ago: 3)
      sell(old_sold_deleted, days_ago: 3)
      sell(live, days_ago: 3, price_cents: 100).update_column(:purchase_state, "failed")
    end

    def fetch_products(params = {})
      get "/mobile/analytics/products", params: auth(seller, scopes: "creator_api").merge(params)
    end

    it "lists the seller's products newest first", parity: true do
      fetch_products

      expect(response.parsed_body["products"].size).to eq(3)
    end

    it "pages with the items param", parity: true do
      fetch_products(items: "2", page: "2")

      expect(response.parsed_body["meta"]["pagination"]).to include("page" => 2, "pages" => 2, "prev" => 1, "next" => nil)
    end

    it "answers the first of several pages", parity: true do
      fetch_products(items: "1")

      expect(response.parsed_body["meta"]["pagination"]).to include("count" => 3, "pages" => 3, "next" => 2)
    end

    it "refuses a page past the last one", parity: true do
      fetch_products(page: "9")

      expect(response).to have_http_status(:bad_request)
    end

    it "lists nothing for a seller without products", parity: true do
      get "/mobile/analytics/products", params: auth(create(:user), scopes: "creator_api")

      expect(response.parsed_body["products"]).to eq([])
    end

    it "refuses a token without the creator_api scope", parity: true do
      get "/mobile/analytics/products", params: auth(seller)

      expect(response).to have_http_status(:forbidden)
    end
  end

  describe "by_date" do
    it "answers the trailing thirty days by day", parity: true do
      fetch("by_date")

      expect(response.parsed_body.keys).to include("dates", "by_date", "seller_time_zone")
    end

    it "answers a named range", parity: true do
      fetch("by_date", date_range: "1w")

      expect(response.parsed_body["dates"].size).to eq(7)
    end

    it "answers every day since the seller started", parity: true do
      fetch("by_date", date_range: "all")

      expect(response).to be_successful
    end

    it "groups by month", parity: true do
      fetch("by_date", start_date: "2026-09-01", end_date: "2026-11-02", group_by: "month")

      expect(response.parsed_body["dates"].size).to eq(3)
    end

    it "answers an explicit range without grouping when group_by is unknown", parity: true do
      fetch("by_date", start_date: "2026-10-28", end_date: "2026-11-02", group_by: "week")

      expect(response.parsed_body.keys).to include("dates_and_months")
    end

    it "answers hourly data", parity: true do
      fetch("by_date", start_date: "2026-11-01", end_date: "2026-11-02", group_by: "hour")

      expect(response.parsed_body["dates"].size).to eq(48)
    end

    it "refuses an hourly range that runs backwards", parity: true do
      fetch("by_date", start_date: "2026-11-02", end_date: "2026-11-01", group_by: "hour")

      expect(response).to have_http_status(:bad_request)
    end

    it "refuses an hourly range longer than a week", parity: true do
      fetch("by_date", start_date: "2026-10-01", end_date: "2026-11-02", group_by: "hour")

      expect(response).to have_http_status(:bad_request)
    end
  end

  describe "by_state" do
    it "answers the trailing thirty days", parity: true do
      fetch("by_state")

      expect(response.parsed_body.keys).to include("by_state")
    end

    it "answers a named range", parity: true do
      fetch("by_state", date_range: "1m")

      expect(response).to be_successful
    end
  end

  describe "by_referral" do
    it "answers the trailing thirty days by day", parity: true do
      fetch("by_referral")

      expect(response.parsed_body.keys).to include("dates", "by_referral")
    end

    it "groups by month", parity: true do
      fetch("by_referral", date_range: "1y", group_by: "month")

      expect(response.parsed_body["dates"].size).to eq(5)
    end

    it "starts at the seller's first day when the range reaches further back", parity: true do
      fetch("by_referral", date_range: "all")

      expect(response.parsed_body["dates"].size).to eq(121)
    end

    context "when the seller is older than a year" do
      let(:seller) { create(:user, name: "Veteran Seller", created_at: 500.days.ago) }

      it "clamps a range longer than a year", parity: true do
        fetch("by_referral", date_range: "all")

        expect(response.parsed_body["dates"].size).to eq(366)
      end
    end
  end
end
