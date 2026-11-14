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

  # Two options of one product, one sold of each, plus a sale of the other product.
  def seed_options
    category = create(:variant_category, link: product, title: "Size")
    small = create(:variant, variant_category: category, name: "Small")
    large = create(:variant, variant_category: category, name: "Large")
    sell(product, days_ago: 5, email: "ada@example.com", full_name: "Ada Lovelace").variant_attributes = [small]
    sell(product, days_ago: 4, email: "carl@example.com").variant_attributes = [large]
    sell(other, days_ago: 2, price_cents: 1400, email: "bob@example.com")
    index_model_records(Purchase)
    log_in(seller)
    { small:, large: }
  end

  it "filters by a product option", parity: true do
    options = seed_options

    fetch(page: 1, variants: [options[:small].external_id])

    expect(response.parsed_body["count"]).to eq(1)
  end

  it "excludes the buyers of a product option", parity: true do
    options = seed_options

    fetch(page: 1, excluded_variants: [options[:small].external_id])

    expect(response.parsed_body["count"]).to eq(2)
  end

  it "matches a product or an option when both are given", parity: true do
    options = seed_options

    fetch(page: 1, products: [other.external_id], variants: [options[:large].external_id])

    expect(response.parsed_body["count"]).to eq(2)
  end

  it "ignores a product id that does not decode", parity: true do
    seed

    fetch(page: 1, products: ["not-an-id"], excluded_variants: ["nope"])

    expect(response.parsed_body["count"]).to eq(3)
  end

  it "filters by a minimum amount alone", parity: true do
    seed

    fetch(page: 1, minimum_amount_cents: "1000")

    expect(response.parsed_body["count"]).to eq(1)
  end

  it "filters by a maximum amount alone", parity: true do
    seed

    fetch(page: 1, maximum_amount_cents: "1000")

    expect(response.parsed_body["count"]).to eq(2)
  end

  it "reads an amount in the seller's currency", parity: true do
    seed
    seller.update_columns(currency_type: "eur")

    fetch(page: 1, minimum_amount_cents: "1000")

    expect(response).to be_successful
  end

  it "filters by a start date alone", parity: true do
    seed
    day = 6.days.ago.in_time_zone(seller.timezone).to_date.iso8601

    fetch(page: 1, created_after: day)

    expect(response.parsed_body["count"]).to eq(2)
  end

  it "filters by an end date alone, inclusive of that day", parity: true do
    seed
    day = 5.days.ago.in_time_zone(seller.timezone).to_date.iso8601

    fetch(page: 1, created_before: day)

    expect(response.parsed_body["count"]).to eq(2)
  end

  it "filters by ISO 8601 instants", parity: true do
    seed

    fetch(page: 1, created_after: at_midday(6).iso8601, created_before: at_midday(3).iso8601)

    expect(response.parsed_body["count"]).to eq(1)
  end

  it "searches by the buyer name", parity: true do
    seed

    fetch(page: 1, query: "Lovelace")

    expect(response.parsed_body["count"]).to eq(1)
  end

  it "drops an unreversed chargeback from the active customers and keeps a reversed one", parity: true do
    seed
    Purchase.find_by(email: "ada@example.com").update_columns(chargeback_date: at_midday(1))
    reversed = Purchase.find_by(email: "bob@example.com")
    reversed.update_columns(chargeback_date: at_midday(1))
    reversed.chargeback_reversed = true
    reversed.save!(validate: false)
    index_model_records(Purchase)

    fetch(page: 1, active_customers_only: "true")

    expect(response.parsed_body["count"]).to eq(2)
  end

  it "drops cancelled and deactivated members from the active customers and keeps a refunded one", parity: true do
    membership = create(:membership_product, user: seller, name: "Club")
    live = create(:subscription, link: membership, user: nil)
    cancelled = create(:subscription, link: membership, user: nil, cancelled_at: 1.day.ago)
    deactivated = create(:subscription, link: membership, user: nil, deactivated_at: 1.day.ago)
    refunded = create(:subscription, link: membership, user: nil)
    [live, cancelled, deactivated, refunded].each_with_index do |subscription, index|
      sell(membership, days_ago: 3 + index, subscription:, is_original_subscription_purchase: true, email: "member#{index}@example.com")
    end
    Purchase.find_by(email: "member3@example.com").update_columns(stripe_refunded: true)
    index_model_records(Purchase)
    log_in(seller)

    fetch(page: 1, active_customers_only: "true")

    expect(response.parsed_body["count"]).to eq(2)
  end

  it "treats a false active_customers_only as no filter", parity: true do
    seed
    Purchase.find_by(email: "ada@example.com").update_columns(stripe_refunded: true)
    index_model_records(Purchase)

    fetch(page: 1, active_customers_only: "false")

    expect(response.parsed_body["count"]).to eq(3)
  end

  it "filters by license uses when the seller has the filter", parity: true do
    Feature.activate_user(:license_uses_sales_filter, seller)
    licensed = create(:product, user: seller, name: "Licensed", is_licensed: true)
    create(:license, link: licensed, purchase: sell(licensed, days_ago: 3, email: "used@example.com"), uses: 4)
    create(:license, link: licensed, purchase: sell(licensed, days_ago: 4, email: "unused@example.com"), uses: 1)
    index_model_records(Purchase)
    log_in(seller)

    fetch(page: 1, minimum_license_uses: "3")

    expect(response.parsed_body["count"]).to eq(1)
  end

  it "ignores the license uses filter for a seller without it", parity: true do
    licensed = create(:product, user: seller, name: "Licensed", is_licensed: true)
    create(:license, link: licensed, purchase: sell(licensed, days_ago: 3, email: "used@example.com"), uses: 4)
    create(:license, link: licensed, purchase: sell(licensed, days_ago: 4, email: "unused@example.com"), uses: 1)
    index_model_records(Purchase)
    log_in(seller)

    fetch(page: 1, minimum_license_uses: "3")

    expect(response.parsed_body["count"]).to eq(2)
  end

  it "compares a minimum amount with decimals as given for a seller paid in dollars", parity: true do
    seed

    fetch(page: 1, minimum_amount_cents: "1399.5")

    expect(response.parsed_body["count"]).to eq(1)
  end

  it "compares a maximum amount with decimals as given for a seller paid in dollars", parity: true do
    seed

    fetch(page: 1, maximum_amount_cents: "1400.5")

    expect(response.parsed_body["count"]).to eq(3)
  end

  it "hands a minimum amount with decimals of a seller paid in another currency to Rails", parity: true do
    seed
    seller.update_columns(currency_type: "eur")

    fetch(page: 1, minimum_amount_cents: "10.5")

    expect(response).to be_successful
  end

  it "hands a date that is not ISO 8601 to Rails", parity: true do
    seed

    fetch(page: 1, created_after: "March 3")

    expect(response).to be_successful
  end

  it "hands a parameter the port does not read to Rails", parity: true do
    seed

    fetch(page: 1, unread: "1")

    expect(response).to be_successful
  end

  it "answers 403 JSON to a seller without an email address", parity: true do
    log_in(seller)
    seller.update_columns(email: nil, unconfirmed_email: nil)

    fetch(page: 1)

    expect(response).to have_http_status(:forbidden)
  end
end
