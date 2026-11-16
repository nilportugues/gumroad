# frozen_string_literal: true

require "spec_helper"

# DashboardController's JSON endpoints (the four counters and the checklist dismissal) and EventsController#create, recorded for the
# Next.js port (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/dashboard-json.replay.test.ts, which sends the last request
# of each example. The clock is frozen: counts and sales ranges do not depend on it, but the rows written carry timestamps.
describe "Dashboard JSON endpoints and event tracking", type: :request, elasticsearch_wait_for_refresh: true do
  include Parity::AudienceSignedIn

  JSON_HEADERS = { "Accept" => "application/json" }.freeze

  let(:seller) { create(:user, name: "Counting Seller") }
  let(:product) { create(:product, user: seller, name: "Alpha", unique_permalink: "alpha", price_cents: 500) }
  let(:membership) { create(:membership_product, user: seller, name: "Club", unique_permalink: "club") }

  before do
    host! DOMAIN
    Purchase.__elasticsearch__.create_index!(force: true)
  end

  def seed_sales
    create(:purchase, link: product, seller:, price_cents: 500)
    create(:purchase, link: product, seller:, price_cents: 1_234_567)
    create(:purchase, link: product, seller:, price_cents: 300, stripe_refunded: true)
    create(:imported_customer, importing_user: seller, link: product)
    create(:imported_customer, importing_user: seller, link: product, deleted_at: Time.utc(2025, 1, 1))
    index_model_records(Purchase)
  end

  def seed_memberships
    create(:membership_purchase, link: membership, seller:, price_cents: 1000)
    create(:membership_purchase, link: membership, seller:, price_cents: 2500)
    index_model_records(Purchase)
  end

  def fetch(path) = get(path, headers: JSON_HEADERS)

  describe "counters" do
    it "counts the customers with a thousands delimiter and imported customers", parity: true do
      seed_sales
      log_in(seller)

      fetch(dashboard_customers_count_path)

      expect(response.parsed_body).to eq("success" => true, "value" => "3")
    end

    it "answers zero customers for a seller without sales", parity: true do
      log_in(seller)

      fetch(dashboard_customers_count_path)

      expect(response.parsed_body).to eq("success" => true, "value" => "0")
    end

    it "formats the gross revenue net of refunds", parity: true do
      seed_sales
      log_in(seller)

      fetch(dashboard_total_revenue_path)

      expect(response.parsed_body["success"]).to be(true)
    end

    it "answers $0 revenue for a seller without sales", parity: true do
      log_in(seller)

      fetch(dashboard_total_revenue_path)

      expect(response.parsed_body).to eq("success" => true, "value" => "$0")
    end

    it "counts active members", parity: true do
      seed_memberships
      log_in(seller)

      fetch(dashboard_active_members_count_path)

      expect(response.parsed_body["success"]).to be(true)
    end

    it "answers zero members for a seller without memberships", parity: true do
      seed_sales
      log_in(seller)

      fetch(dashboard_active_members_count_path)

      expect(response.parsed_body).to eq("success" => true, "value" => "0")
    end

    it "sums the monthly recurring revenue", parity: true do
      seed_memberships
      log_in(seller)

      fetch(dashboard_monthly_recurring_revenue_path)

      expect(response.parsed_body["success"]).to be(true)
    end

    it "answers $0 monthly recurring revenue for a seller without memberships", parity: true do
      log_in(seller)

      fetch(dashboard_monthly_recurring_revenue_path)

      expect(response.parsed_body).to eq("success" => true, "value" => "$0")
    end

    it "answers 403 JSON to a seller without an email address", parity: true do
      log_in(seller)
      seller.update_columns(email: nil, unconfirmed_email: nil)

      fetch(dashboard_customers_count_path)

      expect(response).to have_http_status(:forbidden)
    end

    it "answers HTML requests through Rails", parity: true do
      log_in(seller)

      get dashboard_customers_count_path

      expect(response).to be_successful
    end
  end

  describe "dismissing the getting started checklist" do
    def dismiss
      post dashboard_dismiss_getting_started_checklist_path, headers: JSON_HEADERS.merge("X-CSRF-Token" => csrf_token)
    end

    it "marks the checklist as dismissed", parity: true do
      log_in(seller)

      dismiss

      expect(response).to have_http_status(:ok)
      expect(seller.reload.has_dismissed_getting_started_checklist?).to be(true)
    end

    it "is idempotent", parity: true do
      seller.update!(has_dismissed_getting_started_checklist: true)
      log_in(seller)

      dismiss

      expect(response).to have_http_status(:ok)
    end

    it "answers 403 JSON to a seller without an email address", parity: true do
      log_in(seller)
      seller.update_columns(email: nil, unconfirmed_email: nil)

      dismiss

      expect(response).to have_http_status(:forbidden)
    end
  end

  describe "event tracking" do
    def track(body, headers: {})
      post events_track_user_action_path, params: body.to_json, headers: JSON_HEADERS.merge("Content-Type" => "application/json", "X-CSRF-Token" => csrf_token, "User-Agent" => "Mozilla/5.0 (X11; Linux) Parity/1.0").merge(headers)
    end

    it "records a permitted event for a visitor", parity: true do
      track({ event_name: "post_view", referrer: "https://www.google.com/search?q=a", plugins: "pdf", is_modal: false, from_multi_overlay: true, source: "embed", view_url: "/alpha" })

      expect(response.parsed_body).to eq("success" => true)
      expect(Event.last).to have_attributes(event_name: "post_view", referrer_domain: "google.com", is_modal: false, view_url: "/alpha")
    end

    it "records a recommended product event with the recommended referrer domain", parity: true do
      track({ event_name: "post_view", was_product_recommended: "true", referrer: "https://example.org/x", parent_referrer: "https://example.com/" })

      expect(Event.last.referrer_domain).to eq("recommended_by_gumroad")
    end

    it "drops an event whose name is not permitted when nobody is signed in", parity: true do
      track({ event_name: "link_view" })

      expect(response.parsed_body).to eq("success" => true)
      expect(Event.count).to eq(0)
    end

    it "keeps an event with any name for a signed-in user", parity: true do
      log_in(seller)

      track({ event_name: "link_view", referrer: "direct" })

      expect(Event.last).to have_attributes(event_name: "link_view", user_id: seller.id)
    end

    it "does nothing without an event name", parity: true do
      track({ referrer: "direct" })

      expect(response.parsed_body).to eq("success" => true)
      expect(Event.count).to eq(0)
    end

    it "uses the request referrer when the body has none", parity: true do
      track({ event_name: "post_view" }, headers: { "Referer" => "https://news.example.net/story" })

      expect(Event.last.referrer_domain).to eq("news.example.net")
    end

    it "marks a mobile user agent", parity: true do
      track({ event_name: "post_view", referrer: "direct" }, headers: { "User-Agent" => "Mozilla/5.0 (iPhone) Mobile Safari" })

      expect(Event.last.is_mobile).to be(true)
    end

    it "hands a signup event to Rails", parity: true do
      track({ event_name: "signup", referrer: "direct" })

      expect(response.parsed_body).to eq("success" => true)
    end
  end
end
