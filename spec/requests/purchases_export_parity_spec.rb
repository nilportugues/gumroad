# frozen_string_literal: true

require "spec_helper"

# GET|POST /purchases/export, recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/rest-sweep-3.replay.test.ts, which sends the last request of each example and rebuilds the purchases
# index. Up to 2,000 sales are returned as a CSV built by Exports::PurchaseExportService; more, or `force_async`, enqueue a
# SalesExport. An example named "hands a ..." is a request Node leaves to Rails whole: the export is a read, so nothing is
# written either way.
describe "Purchases export", type: :request, elasticsearch_wait_for_refresh: true do
  include Parity::AudienceSignedIn

  let(:seller) { create(:user, name: "Export Seller", created_at: 120.days.ago, timezone: "Pacific Time (US & Canada)") }
  let(:product) { create(:product, user: seller, name: "Exported product", price_cents: 500) }
  let(:json_headers) { { "Accept" => "application/json" } }

  before do
    host! DOMAIN
    Purchase.__elasticsearch__.create_index!(force: true)
  end

  # The purchase factory charges a card through Stripe; the export only reads the row. The sale time is printed in the CSV, so it is fixed.
  def sell(of: product, state: "successful", **attributes)
    attributes = { created_at: Time.utc(2026, 3, 4, 5, 6, 7), email: "buyer#{SecureRandom.hex(3)}@example.com", country: "United States", state: "CA", street_address: "1 Market Street", city: "San Francisco", zip_code: "94103", **attributes }
    build(:purchase, link: of, seller:, purchase_state: state, **attributes).tap { |row| row.save!(validate: false) }
  end

  def index_sales
    index_model_records(Purchase)
    Purchase.__elasticsearch__.refresh_index!
  end

  def export(params = {}, headers = {})
    index_sales
    log_in(seller)
    get "/purchases/export", params:, headers:
  end

  def csv = CSV.parse(response.body)

  it "exports a sale as a row of the CSV followed by the totals", parity: true do
    sell(price_cents: 500, fee_cents: 100, referrer: "twitter.com")

    export

    expect(response).to have_http_status(:ok)
    expect(csv.first.size).to eq(Exports::PurchaseExportService::PURCHASE_FIELDS.size)
    expect(csv.last.first).to eq("Totals")
  end

  it "exports only the header and the totals when nothing was sold", parity: true do
    export

    expect(csv.size).to eq(2)
  end

  it "answers a POST the same way", parity: true do
    sell
    index_sales
    log_in(seller)

    post "/purchases/export", params: { authenticity_token: csrf_token }

    expect(response).to have_http_status(:ok)
  end

  it "writes the buyer, the discount code, the zip padding and the dispute and refund columns", parity: true do
    buyer = create(:user, name: "Ada Buyer", email: "ada@example.com")
    code = create(:offer_code, user: seller, products: [product], code: "SAVE10", amount_cents: 100)
    sell(purchaser: buyer, full_name: "Ada L.", offer_code: code, zip_code: "1234", price_cents: 400, fee_cents: 80, tax_cents: 0)
    sell(price_cents: 500, stripe_refunded: true).tap { |row| build(:refund, purchase: row, amount_cents: 500, total_transaction_cents: 500).save!(validate: false) }
    sell(price_cents: 600, stripe_partially_refunded: true).tap { |row| build(:refund, purchase: row, amount_cents: 150, total_transaction_cents: 150).save!(validate: false) }
    sell(price_cents: 700, chargeback_date: 3.days.ago)
    reversed = sell(price_cents: 800, chargeback_date: 3.days.ago)
    reversed.update_columns(flags: reversed.flags | Purchase.flag_mapping["flags"][:chargeback_reversed])
    revoked = sell(price_cents: 900)
    revoked.update_columns(flags: revoked.flags | Purchase.flag_mapping["flags"][:is_access_revoked])
    recommended = sell(price_cents: 1000)
    recommended.update_columns(flags: recommended.flags | Purchase.flag_mapping["flags"][:was_product_recommended] | Purchase.flag_mapping["flags"][:is_purchasing_power_parity_discounted])
    sell(price_cents: 1100, can_contact: false, quantity: 2)

    export

    expect(response).to have_http_status(:ok)
    expect(csv.size).to eq(10)
  end

  it "adds a column for each custom field of the products and of the sales", parity: true do
    field = create(:custom_field, name: "Company", seller:, field_type: "text")
    product.custom_fields << field
    answered = sell
    answered.purchase_custom_fields.create!(name: "Company", value: "Example Inc", field_type: "text", custom_field: field)
    answered.purchase_custom_fields.create!(name: "Nickname", value: "Ada", field_type: "text")
    sell

    export

    expect(response).to have_http_status(:ok)
    expect(csv.first.last(2)).to eq(%w[Company Nickname])
  end

  it "leaves out the sales that are not successful", parity: true do
    sell(price_cents: 500)
    sell(state: "failed")
    sell(state: "in_progress")
    sell(state: "not_charged", price_cents: 0)

    export

    expect(response).to have_http_status(:ok)
  end

  it "keeps the sales of the selected products", parity: true do
    other = create(:product, user: seller, name: "Other product", price_cents: 700)
    sell
    sell(of: other, price_cents: 700)

    export({ product_ids: [product.external_id] })

    expect(response).to have_http_status(:ok)
    expect(csv.size).to eq(3)
  end

  # Seeds are replayed at hour granularity, so the sales sit at midday, away from the day boundaries.
  it "keeps the sales between the dates as UTC days", parity: true do
    sell(created_at: Time.utc(2026, 1, 10, 12))
    sell(created_at: Time.utc(2026, 1, 11, 12))
    sell(created_at: Time.utc(2026, 1, 12, 12))
    sell(created_at: Time.utc(2026, 1, 13, 12))

    export({ start_time: "2026-01-11", end_time: "2026-01-12" })

    expect(response).to have_http_status(:ok)
    expect(csv.size).to eq(4)
  end

  it "enqueues the export when it is forced to run asynchronously", parity: true do
    sell

    export({ force_async: "1" })

    expect(response).to have_http_status(:see_other)
    expect(response).to redirect_to(customers_path)
    expect(flash[:notice]).to eq("You will receive an email in your inbox with the data you've requested shortly.")
    expect(SalesExport.count).to eq(1)
    expect(Exports::Sales::CreateAndEnqueueChunksWorker.jobs.size).to eq(1)
  end

  it "answers the dashboard's asynchronous request with success", parity: true do
    sell

    export({ force_async: "1" }, json_headers)

    expect(response).to have_http_status(:ok)
    expect(response.parsed_body).to eq("success" => true)
  end

  it "lets a support team member export", parity: true do
    sell
    support = create(:user, name: "Support Member")
    membership = create(:team_membership, user: support, seller:, role: TeamMembership::ROLE_SUPPORT)
    index_sales
    log_in(support)
    switch_to(membership)

    get "/purchases/export"

    expect(response).to have_http_status(:ok)
  end

  it "hands a signed-out request to Rails", parity: true do
    get "/purchases/export"

    expect(response).to have_http_status(:found)
  end

  it "hands a mobile export with an access token to Rails", parity: true do
    sell

    get "/purchases/export", params: { access_token: "unknown", mobile_token: "unknown" }

    expect(response).to have_http_status(:found)
  end

  it "hands an export in the seller's time zone to Rails", parity: true do
    sell

    export({ in_seller_time_zone: "1", start_time: "2026-01-11" })

    expect(response).to have_http_status(:ok)
  end

  it "writes the variant, its extra cost and the item price without it", parity: true do
    category = create(:variant_category, link: product, title: "Size")
    large = create(:variant, variant_category: category, name: "Large", price_difference_cents: 150)
    small = create(:variant, variant_category: category, name: "Small", price_difference_cents: 0)
    untitled = create(:variant, variant_category: category, name: "Untitled", price_difference_cents: nil)
    sell(price_cents: 650).variant_attributes << large
    sell(price_cents: 500).variant_attributes << small
    sell(price_cents: 500).variant_attributes << untitled
    sell(price_cents: 500)

    export

    expect(response).to have_http_status(:ok)
    expect(csv.map { |row| row[csv.first.index("Variants")] }).to include("(Large)", "(Small)")
  end

  it "writes a SKU's custom name or its external id in the SKU column", parity: true do
    product.update_columns(flags: product.flags | Link.flag_mapping["flags"][:skus_enabled])
    custom = create(:sku, link: product, name: "Red - Large", custom_sku: "RED-L", price_difference_cents: 200)
    plain = create(:sku, link: product, name: "Blue - Small", price_difference_cents: 0)
    default = create(:sku, link: product, name: "Default", price_difference_cents: 0)
    default.update_columns(flags: default.flags | BaseVariant.flag_mapping["flags"][:is_default_sku])
    sell(price_cents: 700).variant_attributes << custom
    sell(price_cents: 500).variant_attributes << plain
    sell(price_cents: 500).variant_attributes << default

    export

    expect(response).to have_http_status(:ok)
    expect(csv.map { |row| row[csv.first.index("SKU ID")] }).to include("RED-L")
  end

  it "hands a sale with several variants to Rails", parity: true do
    category = create(:variant_category, link: product, title: "Size")
    first = create(:variant, variant_category: category, name: "Large", price_difference_cents: 100)
    second = create(:variant, variant_category: create(:variant_category, link: product, title: "Color"), name: "Red", price_difference_cents: 50)
    sell.variant_attributes.push(first, second)

    export

    expect(response).to have_http_status(:ok)
  end

  it "writes the tax amount, its label and whether the price includes it", parity: true do
    us_rate = create(:zip_tax_rate, country: "US", state: "NY", zip_code: "10087")
    de_rate = create(:zip_tax_rate, country: "DE", state: nil, zip_code: nil, combined_rate: "0.1900000")
    jp_rate = create(:zip_tax_rate, country: "JP", state: nil, zip_code: nil, combined_rate: "0.1000000")
    taxable = Purchase.flag_mapping["flags"][:was_purchase_taxable]
    excluded = Purchase.flag_mapping["flags"][:was_tax_excluded_from_price]
    sell(price_cents: 1100, tax_cents: 100, zip_tax_rate: us_rate).update_columns(flags: taxable | excluded)
    sell(price_cents: 1190, tax_cents: 0, gumroad_tax_cents: 190, zip_tax_rate: de_rate, country: "Germany").update_columns(flags: taxable)
    sell(price_cents: 1100, tax_cents: 0, gumroad_tax_cents: 100, zip_tax_rate: jp_rate, country: "Japan").update_columns(flags: taxable)
    sell(price_cents: 500).update_columns(flags: taxable | excluded)
    sell(price_cents: 800, tax_cents: 50, zip_tax_rate: nil)

    export

    expect(response).to have_http_status(:ok)
    expect(csv.map { |row| row[csv.first.index("Tax Type")] }).to include("Sales tax", "VAT")
  end

  it "writes the affiliate's email and the commission", parity: true do
    affiliate_user = create(:user, email: "partner@example.com")
    affiliate = create(:direct_affiliate, seller:, affiliate_user:, affiliate_basis_points: 2500)
    commissioned = sell(price_cents: 1000, fee_cents: 100, affiliate:, affiliate_credit_cents: 250)
    commissioned.update_columns(affiliate_credit_cents: 250)
    pending_email = create(:user, email: "pending@example.com")
    pending_email.update_columns(unconfirmed_email: "new-address@example.com")
    other = create(:direct_affiliate, seller:, affiliate_user: pending_email)
    sell(price_cents: 600, affiliate: other)
    sell(price_cents: 500)

    export

    expect(response).to have_http_status(:ok)
    expect(csv.map { |row| row[csv.first.index("Affiliate")] }).to include("partner@example.com", "new-address@example.com")
  end

  it "hands a sale with a non-ASCII address to Rails", parity: true do
    sell(street_address: "1 Marktstraße")

    export

    expect(response).to have_http_status(:ok)
  end

  it "hands a membership charge to Rails", parity: true do
    membership = create(:membership_purchase, link: create(:membership_product, user: seller), email: "member@example.com")
    membership.update_columns(seller_id: seller.id)

    export

    expect(response).to have_http_status(:ok)
  end
end
