# frozen_string_literal: true

require "spec_helper"

# Signed-in visits to /customers and /customers/:product_id, recorded for the Next.js port (PARITY_RECORD=1) and
# replayed by nextjs/parity/__tests__/customers.replay.test.ts, which sends the last request of each example and
# rebuilds the purchases index from the rows it seeds.
describe "Customers page when signed in", type: :request, elasticsearch_wait_for_refresh: true do
  include Parity::AudienceSignedIn

  let(:seller) { create(:user, name: "Customers Seller", created_at: 120.days.ago) }
  let(:product) { create(:product, user: seller, name: "Alpha") }

  before do
    host! DOMAIN
    Purchase.__elasticsearch__.create_index!(force: true)
  end

  def sign_in_with_indexed_sales
    index_model_records(Purchase)
    log_in(seller)
  end

  # Midday, so the replay clock (whole hours) cannot move a sale across the seller's day boundary.
  def at_midday(days_ago) = days_ago.days.ago.in_time_zone(seller.timezone).change(hour: 12).utc

  def sell(link, days_ago:, **attributes)
    create(:purchase, link:, seller:, created_at: at_midday(days_ago), **attributes)
  end

  def customers_of(response) = inertia_props_of(response).dig("customers_presenter", "customers")

  it "redirects a signed-out visitor to the login page", parity: true do
    get customers_path

    expect(response).to redirect_to(login_path(next: "/customers"))
  end

  it "lists no customers for a seller without sales", parity: true do
    log_in(seller)

    get customers_path

    expect(response).to be_successful
    expect(inertia_props_of(response).dig("customers_presenter", "count")).to eq(0)
  end

  it "lists the customers newest first with their purchase details", parity: true do
    other = create(:product, user: seller, name: "Beta", price_cents: 700)
    sell(product, days_ago: 5, full_name: "  Ada Lovelace ")
    sell(other, days_ago: 2, quantity: 2, price_cents: 1400)
    sell(product, days_ago: 9, email: "second@example.com")
    sign_in_with_indexed_sales

    get customers_path

    expect(response).to be_successful
    expect(customers_of(response).size).to eq(3)
  end

  it "pages through more customers than fit on a page", parity: true do
    22.times { |index| sell(product, days_ago: index + 1) }
    sign_in_with_indexed_sales

    get customers_path

    expect(inertia_props_of(response).dig("customers_presenter", "pagination")).to include("page" => 1, "pages" => 2)
    expect(customers_of(response).size).to eq(20)
  end

  it "reads the page parameter of the index as an offset of whole pages from the start, as Rails does", parity: true do
    22.times { |index| sell(product, days_ago: index + 1) }
    sign_in_with_indexed_sales

    get customers_path(page: 2)

    expect(inertia_props_of(response).dig("customers_presenter", "count")).to eq(22)
    expect(customers_of(response)).to eq([])
  end

  it "narrows the list to one product", parity: true do
    other = create(:product, user: seller, name: "Beta")
    sell(product, days_ago: 3)
    sell(other, days_ago: 4)
    sign_in_with_indexed_sales

    get customers_link_id_path(product.unique_permalink)

    expect(inertia_props_of(response).dig("customers_presenter", "product_id")).to eq(product.external_id)
    expect(customers_of(response).size).to eq(1)
  end

  it "lists every customer when the product does not exist", parity: true do
    sell(product, days_ago: 3)
    sign_in_with_indexed_sales

    get customers_link_id_path("nope")

    expect(inertia_props_of(response).dig("customers_presenter", "product_id")).to be_nil
    expect(customers_of(response).size).to eq(1)
  end

  it "searches by the buyer's email and by the country they bought from", parity: true do
    sell(product, days_ago: 3, email: "findme@example.com", country: "United States")
    sell(product, days_ago: 4, email: "other@example.com", country: "Canada")
    sign_in_with_indexed_sales

    get customers_path(query: "findme", bought_from: "United States")

    expect(customers_of(response).map { _1["email"] }).to eq(["findme@example.com"])
  end

  it "shows the offer code a customer used and the price before it", parity: true do
    code = create(:offer_code, user: seller, products: [product], code: "SAVE", amount_cents: 100)
    sell(product, days_ago: 3, offer_code: code, price_cents: 400)
    sign_in_with_indexed_sales

    get customers_path

    expect(customers_of(response).first["discount"]).to eq("type" => "fixed", "cents" => 100, "code" => "SAVE")
  end

  it "shows a percentage offer code", parity: true do
    priced = create(:product, user: seller, name: "Priced", price_cents: 500)
    code = create(:percentage_offer_code, user: seller, products: [priced], code: "HALF", amount_percentage: 50)
    sell(priced, days_ago: 3, offer_code: code, price_cents: 250)
    sign_in_with_indexed_sales

    get customers_path

    expect(customers_of(response).first["discount"]).to include("type" => "percent", "percents" => 50)
  end

  it "shows the license key of a licensed product", parity: true do
    licensed = create(:product, user: seller, name: "Licensed", is_licensed: true)
    purchase = sell(licensed, days_ago: 3)
    create(:license, link: licensed, purchase:, uses: 4)
    sign_in_with_indexed_sales

    get customers_path

    expect(customers_of(response).first["license"]).to include("uses" => 4, "enabled" => true)
  end

  it "shows a disabled license", parity: true do
    licensed = create(:product, user: seller, name: "Licensed", is_licensed: true)
    purchase = sell(licensed, days_ago: 3)
    create(:license, link: licensed, purchase:, disabled_at: 1.day.ago)
    sign_in_with_indexed_sales

    get customers_path

    expect(customers_of(response).first["license"]).to include("enabled" => false)
  end

  it "shows the review and the seller's response", parity: true do
    purchase = sell(product, days_ago: 3)
    review = create(:product_review, purchase:, link: product, rating: 4, message: "Very good")
    create(:product_review_response, product_review: review, user: seller, message: "Thanks!")
    sign_in_with_indexed_sales

    get customers_path

    expect(customers_of(response).first["review"]).to include("rating" => 4, "message" => "Very good", "response" => { "message" => "Thanks!" })
  end

  it "shows a review without a message", parity: true do
    purchase = sell(product, days_ago: 3)
    create(:product_review, purchase:, link: product, rating: 2, message: nil)
    sign_in_with_indexed_sales

    get customers_path

    expect(customers_of(response).first["review"]).to include("rating" => 2, "message" => nil, "response" => nil)
  end

  it "shows where the customer came from and the purchasing power discount", parity: true do
    sell(product, days_ago: 3, referrer: "https://twitter.com/somebody")
    sell(product, days_ago: 4, referrer: "direct")
    sell(product, days_ago: 5, referrer: "https://news.example.com/story")
    sign_in_with_indexed_sales

    get customers_path

    expect(customers_of(response).map { _1["referrer"] }).to eq(["Twitter", "Direct", "news.example.com"])
  end

  it "shows the customer's answers to custom text fields", parity: true do
    field = create(:custom_field, seller:, products: [product], name: "Company", type: "text")
    purchase = sell(product, days_ago: 3)
    create(:purchase_custom_field, purchase:, custom_field: field, name: "Company", value: "Acme", type: CustomField::TYPE_TEXT)
    sign_in_with_indexed_sales

    get customers_path

    expect(customers_of(response).first["custom_fields"]).to eq([{ "attribute" => "Company", "type" => "text", "value" => "Acme" }])
  end

  it "counts a customer's downloads", parity: true do
    purchase = sell(product, days_ago: 3)
    purchase.url_redirect&.update!(uses: 3)
    sign_in_with_indexed_sales

    get customers_path

    expect(customers_of(response).first).to have_key("download_count")
  end

  it "marks a revoked access", parity: true do
    sell(product, days_ago: 3, is_access_revoked: true)
    sign_in_with_indexed_sales

    get customers_path

    expect(customers_of(response).first["is_access_revoked"]).to eq(true)
  end

  it "lists a product's variants for the filter box and hides an archived product that never sold", parity: true do
    create(:product_with_digital_versions, user: seller, name: "Versioned")
    create(:product, user: seller, name: "Hidden archive", archived: true)
    sell(product, days_ago: 3)
    sign_in_with_indexed_sales

    get customers_path

    expect(inertia_props_of(response).dig("customers_presenter", "products").map { _1["name"] }).to include("Versioned", "Alpha")
    expect(inertia_props_of(response).dig("customers_presenter", "products").map { _1["name"] }).not_to include("Hidden archive")
  end

  it "keeps an archived product that sold in the filter box", parity: true do
    archived = create(:product, user: seller, name: "Archived but sold")
    sell(archived, days_ago: 3)
    archived.update!(archived: true)
    sign_in_with_indexed_sales

    get customers_path

    expect(inertia_props_of(response).dig("customers_presenter", "products").map { _1["name"] }).to eq(["Archived but sold"])
  end

  it "shows a partially refunded customer", parity: true do
    purchase = sell(product, days_ago: 3, price_cents: 500)
    purchase.update_columns(stripe_partially_refunded: true)
    create(:refund, purchase:, amount_cents: 100)
    sign_in_with_indexed_sales

    get customers_path

    customer = customers_of(response).first
    expect(customer["partially_refunded"]).to eq(true)
    expect(customer.dig("price", "cents_refundable")).to eq(400)
  end

  it "counts a failed refund whose balance was not reversed against the refundable amount, and one that was reversed not", parity: true do
    kept = sell(product, days_ago: 3, price_cents: 500)
    reversed = sell(product, days_ago: 4, price_cents: 500)
    create(:refund, purchase: kept, amount_cents: 100, status: "failed")
    create(:refund, purchase: reversed, amount_cents: 100, status: "failed", balance_reversed_on_failure: true)
    sign_in_with_indexed_sales

    get customers_path

    expect(customers_of(response).map { _1.dig("price", "cents_refundable") }).to eq([400, 500])
  end

  it "shows a fully refunded customer", parity: true do
    purchase = sell(product, days_ago: 3, price_cents: 500)
    purchase.update_columns(stripe_refunded: true)
    create(:refund, purchase:, amount_cents: 500)
    sign_in_with_indexed_sales

    get customers_path

    customer = customers_of(response).first
    expect(customer["refunded"]).to eq(true)
    expect(customer.dig("price", "cents_refundable")).to eq(0)
    expect(customer["is_access_revoked"]).to be_nil
  end

  it "shows the recipient of a gift on the sender's row", parity: true do
    sender = sell(product, days_ago: 3, is_gift_sender_purchase: true)
    create(:gift, link: product, gifter_purchase: sender, giftee_email: "giftee@example.com")
    sign_in_with_indexed_sales

    get customers_path

    customer = customers_of(response).first
    expect(customer["giftee_email"]).to eq("giftee@example.com")
    expect(customer["is_gift_sender_purchase"]).to eq(true)
  end

  it "reports the refundable amount of a non-USD sale in its own currency", parity: true do
    eur_product = create(:product, user: seller, name: "Euro", price_currency_type: "eur", price_cents: 1000)
    purchase = sell(eur_product, days_ago: 3, displayed_price_currency_type: "eur", displayed_price_cents: 1000, rate_converted_to_usd: "0.8", price_cents: 1250)
    create(:refund, purchase:, amount_cents: 250)
    sign_in_with_indexed_sales

    get customers_path

    price = customers_of(response).first["price"]
    expect(price["currency_type"]).to eq("eur")
    expect(price["cents_refundable"]).to eq(800)
  end

  it "serves a member with its subscription", parity: true do
    membership = create(:membership_product, user: seller, name: "Club")
    create(:membership_purchase, link: membership, seller:, created_at: at_midday(3))
    sign_in_with_indexed_sales

    get customers_path

    expect(customers_of(response).first["subscription"]).to be_present
  end

  it "leaves a physical product sale to Rails", parity: true do
    physical = create(:physical_product, user: seller, name: "Poster")
    create(:physical_purchase, link: physical, seller:, created_at: at_midday(3))
    sign_in_with_indexed_sales

    get customers_path

    expect(customers_of(response).first["shipping"]).to be_present
  end

  it "lets a support team member see the seller's customers", parity: true do
    member = create(:user)
    membership = create(:team_membership, user: member, seller:, role: TeamMembership::ROLE_SUPPORT)
    sell(product, days_ago: 3)
    index_model_records(Purchase)
    log_in(member)
    switch_to(membership)

    get customers_path

    expect(customers_of(response).size).to eq(1)
  end

  it "does not let a marketing team member see the customers' sales detail differently", parity: true do
    member = create(:user)
    membership = create(:team_membership, user: member, seller:, role: TeamMembership::ROLE_MARKETING)
    sell(product, days_ago: 3)
    index_model_records(Purchase)
    log_in(member)
    switch_to(membership)

    get customers_path

    expect(response).to be_successful
  end

  it "reports a seller with a license uses filter and ping endpoints", parity: true do
    Feature.activate_user(:license_uses_sales_filter, seller)
    log_in(seller)

    get customers_path

    expect(inertia_props_of(response).dig("customers_presenter", "license_uses_filter_enabled")).to eq(true)
  end
end
