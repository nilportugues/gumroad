# frozen_string_literal: true

require "spec_helper"

# PublicController's lookup endpoints (charge_data, license_key_lookup_data, paypal_charge_data), recorded for the Next.js
# port (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/ws11-public.replay.test.ts.
describe "Public lookup data", type: :request do
  before { host! DOMAIN }

  let(:email) { "buyer@example.com" }
  # Creating a purchase through the factory charges a card; a lookup only reads the row.
  def purchase_row(product:, **attributes)
    build(:purchase, link: product, price_cents: 100, fee_cents: 30, email:, **attributes).tap { |row| row.save!(validate: false) }
  end

  let!(:purchase) { purchase_row(product: create(:product, name: "Sketch pack", unique_permalink: "sketchpk"), card_visual: "**** 4242", created_at: Time.utc(2024, 3, 15, 12)) }
  let!(:other_purchase) { purchase_row(product: create(:product, name: "Brush set", unique_permalink: "brushset"), card_visual: "**** 1111", created_at: Time.utc(2023, 7, 1, 12)) }

  describe "GET /charge_data" do
    it "emails a grouped receipt for every successful purchase of the address", parity: true do
      get "/charge_data", params: { email: }

      expect(response.parsed_body).to eq("success" => true)
    end

    it "narrows by the last four digits of the card", parity: true do
      get "/charge_data", params: { email:, last_4: "4242" }

      expect(response.parsed_body).to eq("success" => true)
    end

    it "narrows by year and month", parity: true do
      get "/charge_data", params: { email:, year: "2023", month: "7" }

      expect(response.parsed_body).to eq("success" => true)
    end

    it "narrows by year alone when the month is out of range", parity: true do
      get "/charge_data", params: { email:, year: "2024", month: "13" }

      expect(response.parsed_body).to eq("success" => true)
    end

    it "ignores a year before the first purchases", parity: true do
      get "/charge_data", params: { email:, year: "2005", month: "3" }

      expect(response.parsed_body).to eq("success" => true)
    end

    it "reports failure when nothing matches", parity: true do
      get "/charge_data", params: { email:, last_4: "9999" }

      expect(response.parsed_body).to eq("success" => false)
    end

    it "reports failure for an address with no purchases", parity: true do
      get "/charge_data", params: { email: "nobody@example.com" }

      expect(response.parsed_body).to eq("success" => false)
    end
  end

  describe "GET /license_key_lookup_data" do
    it "emails every purchase with recommendations when no product is named", parity: true do
      get "/license_key_lookup_data", params: { email: }

      expect(response.parsed_body).to eq("success" => true)
    end

    it "narrows to the product named by a partial name", parity: true do
      get "/license_key_lookup_data", params: { email:, product_query: "sketch" }

      expect(response.parsed_body).to eq("success" => true)
    end

    it "narrows to the product named by its URL", parity: true do
      get "/license_key_lookup_data", params: { email:, product_query: "https://example.com/l/brushset" }

      expect(response.parsed_body).to eq("success" => true)
    end

    it "falls back to every purchase when the product query matches nothing", parity: true do
      get "/license_key_lookup_data", params: { email:, product_query: "no such product" }

      expect(response.parsed_body).to eq("success" => true)
    end

    it "reports failure for an address with no purchases", parity: true do
      get "/license_key_lookup_data", params: { email: "nobody@example.com", product_query: "sketch" }

      expect(response.parsed_body).to eq("success" => false)
    end
  end

  describe "GET /paypal_charge_data" do
    it "enqueues the receipt for the purchase", parity: true do
      get "/paypal_charge_data", params: { invoice_id: purchase.external_id }

      expect(response.parsed_body).to eq("success" => true)
    end

    it "reports failure for an unknown invoice", parity: true do
      get "/paypal_charge_data", params: { invoice_id: "unknown-invoice" }

      expect(response.parsed_body).to eq("success" => false)
    end

    it "reports failure without an invoice", parity: true do
      get "/paypal_charge_data"

      expect(response.parsed_body).to eq("success" => false)
    end
  end

  # Rack::Attack counts these endpoints per client address (3 requests in 20 seconds, then the backoff tiers) and, for the two that email
  # a receipt to an address, per recipient (6 in a minute, shared by both). Node counts in the same Redis keys. The earlier requests of a
  # window are added to the counter directly; ws11-public.replay.test.ts adds the same count in Node's Redis before the last request. The
  # clock is frozen so the window cannot end mid-example.
  describe "the Rack::Attack throttle" do
    let(:client) { "203.0.113.7" }
    let(:frozen_at) { Time.at(1_800_000_001).utc }

    before do
      Rack::Attack.cache.store.flushdb
      travel_to(frozen_at)
    end

    after do
      travel_back
      Rack::Attack.cache.store.flushdb
    end

    def count_requests(times, name, period, id = client)
      times.times { Rack::Attack.cache.count("#{name}:#{id}", period) }
    end

    def lookup(path, params = { email: }, headers = { "CF-Connecting-IP" => client })
      get path, params:, headers:
    end

    it "answers the third lookup of an address", parity: true do
      count_requests(2, "/ip:/charge_data", 20)

      lookup("/charge_data")

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body).to eq("success" => true)
    end

    it "answers 429 to the fourth charge lookup of an address", parity: true do
      count_requests(3, "/ip:/charge_data", 20)

      lookup("/charge_data")

      expect(response).to have_http_status(:too_many_requests)
      expect(response.body).to eq("Retry later\n")
      expect(response.headers["Retry-After"]).to eq((20 - (frozen_at.to_i % 20)).to_s)
    end

    it "answers 429 to the fourth paypal lookup of an address", parity: true do
      count_requests(3, "/ip:/paypal_charge_data", 20)

      lookup("/paypal_charge_data", { invoice_id: purchase.external_id })

      expect(response).to have_http_status(:too_many_requests)
    end

    it "answers 429 once an email has six lookups across both endpoints", parity: true do
      count_requests(6, "/params:grouped_receipt:email", 60, email)

      lookup("/license_key_lookup_data")

      expect(response).to have_http_status(:too_many_requests)
    end

    it "counts an email in any case and with spaces in one budget", parity: true do
      count_requests(6, "/params:grouped_receipt:email", 60, email)

      lookup("/charge_data", { email: "  BUYER@Example.com " })

      expect(response).to have_http_status(:too_many_requests)
    end

    it "does not count a blank email", parity: true do
      count_requests(6, "/params:grouped_receipt:email", 60, email)

      lookup("/charge_data", { email: "" })

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body).to eq("success" => false)
    end
  end
end
