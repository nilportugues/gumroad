# frozen_string_literal: true

require "spec_helper"

# GET /customers/paged, the JSON the customers table fetches, recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/customers-paged.replay.test.ts, which sends the last request of each example and rebuilds the purchases index.
describe "Customers table JSON when signed in", type: :request, elasticsearch_wait_for_refresh: true do
  include Parity::AudienceSignedIn

  JSON_HEADERS = { "Accept" => "application/json" }.freeze

  let(:seller) { create(:user, name: "Paged Seller", created_at: 120.days.ago) }
  let(:product) { create(:product, user: seller, name: "Alpha") }
  let(:other) { create(:product, user: seller, name: "Beta", price_cents: 700) }

  before do
    host! DOMAIN
    Purchase.__elasticsearch__.create_index!(force: true)
  end

  def at_midday(days_ago) = days_ago.days.ago.in_time_zone(seller.timezone).change(hour: 12).utc

  def sell(link, days_ago:, **attributes)
    # The purchase factory charges a card through Stripe; the listing only reads the row.
    build(:purchase, link:, seller:, purchase_state: "successful", created_at: at_midday(days_ago), **attributes).tap { |row| row.save!(validate: false) }
  end

  def seed(count = 3)
    sell(product, days_ago: 5, full_name: "Ada Lovelace", email: "ada@example.com")
    sell(other, days_ago: 2, price_cents: 1400, email: "bob@example.com")
    sell(product, days_ago: 9, email: "second@example.com", ip_country: "France")
    (count - 3).times { |i| sell(product, days_ago: 10 + i, email: "extra#{i}@example.com") }
    index_model_records(Purchase)
    log_in(seller)
  end

  def fetch(params = {}) = get(customers_paged_path, params:, headers: JSON_HEADERS)

  it "lists the first page newest first", parity: true do
    seed

    fetch(page: 1)

    expect(response.parsed_body["customers"].size).to eq(3)
    expect(response.parsed_body["pagination"]["page"]).to eq(1)
  end

  it "reports the second page and its offset", parity: true do
    seed(23)

    fetch(page: 2)

    expect(response.parsed_body["pagination"]).to include("page" => 2, "pages" => 2)
    expect(response.parsed_body["customers"].size).to eq(3)
  end

  it "answers the first page without a page parameter", parity: true do
    seed

    fetch

    expect(response.parsed_body["pagination"]["page"]).to eq(1)
  end

  it "searches by the buyer email", parity: true do
    seed

    fetch(page: 1, query: "bob@example.com")

    expect(response.parsed_body["count"]).to eq(1)
  end

  it "sorts by price ascending", parity: true do
    seed

    fetch(page: 1, sort: { key: "price_cents", direction: "asc" })

    expect(response.parsed_body["customers"].first["price"]["cents"]).to be <= response.parsed_body["customers"].last["price"]["cents"]
  end

  it "sorts by product name descending by default", parity: true do
    seed

    fetch(page: 1, sort: { key: "product_name" })

    expect(response).to be_successful
  end

  it "ignores an unknown sort key", parity: true do
    seed

    fetch(page: 1, sort: { key: "email", direction: "asc" })

    expect(response).to be_successful
  end

  it "filters by the country of the sale", parity: true do
    seed

    fetch(page: 1, bought_from: "France")

    expect(response.parsed_body["count"]).to eq(1)
  end

  it "clamps a page past the last legal window", parity: true do
    seed

    fetch(page: 9999)

    expect(response.parsed_body["pagination"]["page"]).to eq(500)
  end

  it "filters by a product", parity: true do
    seed

    fetch(page: 1, products: [product.external_id])

    expect(response.parsed_body["customers"].size).to eq(2)
  end

  it "excludes the buyers of a product", parity: true do
    seed

    fetch(page: 1, excluded_products: [other.external_id])

    expect(response.parsed_body["count"]).to eq(2)
  end

  it "filters by an amount range", parity: true do
    seed

    fetch(page: 1, minimum_amount_cents: "1000", maximum_amount_cents: "2000")

    expect(response.parsed_body["count"]).to eq(1)
  end

  it "filters by a date range in the seller's time zone", parity: true do
    seed
    day = ->(days_ago) { days_ago.days.ago.in_time_zone(seller.timezone).to_date.iso8601 }

    fetch(page: 1, created_after: day.call(6), created_before: day.call(2))

    expect(response.parsed_body["count"]).to eq(2)
  end

  it "drops a date range that ends before it starts", parity: true do
    seed

    fetch(page: 1, created_after: "2030-01-03", created_before: "2030-01-01")

    expect(response.parsed_body["count"]).to eq(3)
  end

  it "filters by the country parameter ahead of bought_from", parity: true do
    seed

    fetch(page: 1, country: "France", bought_from: "Spain")

    expect(response.parsed_body["count"]).to eq(1)
  end

  it "lists active customers only", parity: true do
    seed
    Purchase.find_by(email: "ada@example.com").update_columns(stripe_refunded: true)
    index_model_records(Purchase)

    fetch(page: 1, active_customers_only: "true")

    expect(response.parsed_body["count"]).to eq(2)
  end

  it "answers 403 JSON to a seller without an email address", parity: true do
    log_in(seller)
    seller.update_columns(email: nil, unconfirmed_email: nil)

    fetch(page: 1)

    expect(response).to have_http_status(:forbidden)
  end
end
