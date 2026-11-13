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

  def charged_in(row, currency, total_cents)
    PurchasePresentment.new(purchase: row, processor: "stripe", presentment_currency: currency, presentment_price_cents: total_cents, presentment_total_cents: total_cents, presentment_gumroad_amount_cents: 0).save!(validate: false)
  end

  def refund(row, amount_cents, **attributes)
    build(:refund, purchase: row, amount_cents:, total_transaction_cents: amount_cents, **attributes).tap { |record| record.save!(validate: false) }
  end

  def in_cart_of_order(row, buyer, emails: [], deleted: false)
    order = Order.create!(purchaser: buyer)
    OrderPurchase.create!(order:, purchase: row)
    cart = create(:cart, :guest, order:, deleted_at: (Time.utc(2026, 3, 5) if deleted))
    emails.each { |installment| SentAbandonedCartEmail.create!(cart:, installment:) }
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

  def csv = CSV.parse(response.body.dup.force_encoding(Encoding::UTF_8))

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

  it "sends a signed-out request to the login page with the path as next", parity: true do
    get "/purchases/export", params: { start_time: "2026-01-11" }

    expect(response.location).to end_with("/login?next=%2Fpurchases%2Fexport%3Fstart_time%3D2026-01-11")
  end

  it "answers a signed-out JSON request with a 404", parity: true do
    get "/purchases/export", headers: json_headers

    expect(response).to have_http_status(:not_found)
  end

  it "hands a mobile export with an access token to Rails", parity: true do
    sell

    get "/purchases/export", params: { access_token: "unknown", mobile_token: "unknown" }

    expect(response).to have_http_status(:found)
  end

  # Pacific midnight of 2026-01-11 is 08:00 UTC and of 2026-01-13 is 08:00 UTC; the sales sit hours away from both.
  it "keeps the sales between the dates as the seller's own days", parity: true do
    sell(created_at: Time.utc(2026, 1, 11, 3))
    sell(created_at: Time.utc(2026, 1, 11, 12))
    sell(created_at: Time.utc(2026, 1, 13, 4))
    sell(created_at: Time.utc(2026, 1, 13, 12))

    export({ in_seller_time_zone: "1", start_time: "2026-01-11", end_time: "2026-01-12" })

    expect(response).to have_http_status(:ok)
    expect(csv.size).to eq(4)
  end

  it "reads the day a date with a time of day names", parity: true do
    sell(created_at: Time.utc(2026, 1, 10, 12))
    sell(created_at: Time.utc(2026, 1, 11, 12))
    sell(created_at: Time.utc(2026, 1, 12, 12))
    sell(created_at: Time.utc(2026, 1, 13, 12))

    export({ start_time: "2026-01-11T23:30:00", end_time: "2026-01-12 01:00:00" })

    expect(csv.size).to eq(4)
  end

  it "reads the day a date with a time of day and an offset names", parity: true do
    sell(created_at: Time.utc(2026, 1, 10, 12))
    sell(created_at: Time.utc(2026, 1, 11, 12))
    sell(created_at: Time.utc(2026, 1, 12, 12))

    export({ start_time: "2026-01-11T00:30:00.250-08:00", end_time: "2026-01-11T23:59:59+05:30" })

    expect(csv.size).to eq(3)
  end

  it "writes the day a date with a time of day names into the query of an asynchronous export", parity: true do
    export({ start_time: "2026-01-11T10:00:00+02:00", end_time: "2026-01-12T10:00:00-02:00", force_async: "1" })

    expect(SalesExport.last.query.to_s).to include("2026-01-11T00:00:00Z", "2026-01-13T00:00:00Z")
  end

  it "reads the dates in the seller's time zone from one side only", parity: true do
    sell(created_at: Time.utc(2026, 1, 11, 3))
    sell(created_at: Time.utc(2026, 1, 11, 12))

    export({ in_seller_time_zone: "1", start_time: "2026-01-11" })

    expect(response).to have_http_status(:ok)
    expect(csv.size).to eq(3)
  end

  it "uses the seller's zone offset across daylight saving time", parity: true do
    seller.update_columns(timezone: "London")
    sell(created_at: Time.utc(2026, 7, 10, 23, 22))
    sell(created_at: Time.utc(2026, 7, 11, 12, 22))

    export({ in_seller_time_zone: "1", start_time: "2026-07-11", end_time: "2026-07-11" })

    expect(response).to have_http_status(:ok)
    expect(csv.size).to eq(4)
  end

  it "starts the day after a midnight the zone skips", parity: true do
    seller.update_columns(timezone: "Brasilia")
    sell(created_at: Time.utc(2018, 11, 4, 2))
    sell(created_at: Time.utc(2018, 11, 4, 12))

    export({ in_seller_time_zone: "1", start_time: "2018-11-04", end_time: "2018-11-04" })

    expect(response).to have_http_status(:ok)
    expect(csv.size).to eq(3)
  end

  it "writes the seller's day boundaries into the query of an asynchronous export", parity: true do
    export({ in_seller_time_zone: "1", start_time: "2026-01-11", end_time: "2026-01-12", force_async: "1" })

    expect(response).to have_http_status(:see_other)
    expect(SalesExport.count).to eq(1)
    expect(SalesExport.last.query.to_s).to include("2026-01-11T00:00:00-08:00", "2026-01-13T00:00:00-08:00")
  end

  # Rails reads whitespace as blank, so the dates stay UTC days.
  it "reads a whitespace-only in_seller_time_zone as blank", parity: true do
    sell(created_at: Time.utc(2026, 1, 11, 3))

    export({ in_seller_time_zone: " ", start_time: "2026-01-11" })

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

  describe "variant_ids" do
    let(:category) { create(:variant_category, link: product, title: "Size") }
    let(:large) { create(:variant, variant_category: category, name: "Large", price_difference_cents: 150) }
    let(:small) { create(:variant, variant_category: category, name: "Small", price_difference_cents: 0) }

    before do
      sell(price_cents: 650).variant_attributes << large
      sell(price_cents: 500).variant_attributes << small
      sell(price_cents: 500)
    end

    it "keeps the sales of the selected variants", parity: true do
      export({ variant_ids: [large.external_id] })

      expect(response).to have_http_status(:ok)
      expect(csv.size).to eq(3)
    end

    it "keeps the sales of every selected variant", parity: true do
      export({ variant_ids: [large.external_id, small.external_id] })

      expect(csv.size).to eq(4)
    end

    it "reads a single variant id that is not wrapped in a list", parity: true do
      export({ variant_ids: small.external_id })

      expect(csv.size).to eq(3)
    end

    it "keeps the sales of a selected product or a selected variant", parity: true do
      other = create(:product, user: seller, name: "Other product", price_cents: 700)
      sell(of: other, price_cents: 700)

      export({ product_ids: [other.external_id], variant_ids: [large.external_id] })

      expect(csv.size).to eq(4)
    end

    it "drops the filter when no variant matches the id", parity: true do
      export({ variant_ids: ["unknown"] })

      expect(response).to have_http_status(:ok)
      expect(csv.size).to eq(5)
    end

    it "writes the variant ids into the query of an asynchronous export", parity: true do
      export({ variant_ids: [small.external_id, large.external_id], force_async: "1" })

      expect(response).to have_http_status(:see_other)
      expect(SalesExport.last.query.to_s).to include("variant_ids")
    end
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

  it "writes the tip, the review and the license key with its activations", parity: true do
    licensed = create(:product, user: seller, name: "Licensed", is_licensed: true)
    tipped = sell(price_cents: 1150)
    Tip.create!(purchase: tipped, value_cents: 150, value_usd_cents: 150)
    reviewed = sell(price_cents: 500)
    ProductReview.new(purchase: reviewed, link: product, rating: 4, message: "Worth it, \"quoted\"").save!(validate: false)
    unmessaged = sell(price_cents: 500)
    ProductReview.new(purchase: unmessaged, link: product, rating: 5).save!(validate: false)
    keyed = sell(of: licensed, price_cents: 900)
    License.create!(purchase: keyed, link: licensed, serial: "AAAA-BBBB-CCCC-DDDD", uses: 3)
    disabled = sell(of: licensed, price_cents: 900)
    License.create!(purchase: disabled, link: licensed, serial: "EEEE-FFFF-GGGG-HHHH", uses: 0, disabled_at: 2.days.ago)
    sell(of: licensed, price_cents: 900)

    export

    expect(response).to have_http_status(:ok)
    expect(csv.map { |row| row[csv.first.index("License Key")] }).to include("AAAA-BBBB-CCCC-DDDD", "EEEE-FFFF-GGGG-HHHH")
  end

  it "writes the UTM link columns and flags an upsold sale", parity: true do
    utm_link = create(:utm_link, seller:, utm_source: "newsletter", utm_medium: "email", utm_campaign: "launch", utm_term: "term one", utm_content: "banner")
    visit = create(:utm_link_visit, utm_link:)
    driven = sell(price_cents: 500)
    create(:utm_link_driven_sale, utm_link:, utm_link_visit: visit, purchase: driven)
    upsold = sell(price_cents: 600)
    upsell = create(:upsell, seller:, product:, name: "Bonus")
    build(:upsell_purchase, upsell:, purchase: upsold, selected_product: product).save!(validate: false)
    sell(price_cents: 500)

    export

    expect(response).to have_http_status(:ok)
    expect(csv.map { |row| row[csv.first.index("UTM Source")] }).to include("newsletter")
    expect(csv.map { |row| row[csv.first.index("Upsold?")] }).to include("1")
  end

  it "hands a sale of a licensed product with a variant to Rails", parity: true do
    licensed = create(:product, user: seller, name: "Licensed versions", is_licensed: true)
    category = create(:variant_category, link: licensed, title: "Edition")
    edition = create(:variant, variant_category: category, name: "Pro", price_difference_cents: 100)
    keyed = sell(of: licensed, price_cents: 600)
    keyed.variant_attributes << edition
    License.create!(purchase: keyed, link: licensed, serial: "IIII-JJJJ-KKKK-LLLL", uses: 1)

    export

    expect(response).to have_http_status(:ok)
  end

  it "transliterates an address and keeps the original of one with a character Rails cannot transliterate", parity: true do
    sell(street_address: "1 Marktstraße", city: "München", country: "Österreich").update_columns(state: "Baden-Württemberg")
    sell(street_address: "東京都 1-2-3", city: "東京", country: "Japan").update_columns(state: "Tokyo")
    sell(street_address: "Zürich?", city: "São Paulo", country: "Brasil").update_columns(state: "SP")
    sell(street_address: "2 Rue de l'Église", city: "Cafe#{"\u0301"}", country: "France").update_columns(state: "Île-de-France")
    sell(street_address: "🏠 1 Main", city: "Non#{"\u00A0"}breaking", country: "United States").update_columns(state: "CA")
    sell(street_address: "Ångström väg 1", city: "Łódź", country: "Ελλάδα").update_columns(state: "Œuvre")

    export

    expect(response).to have_http_status(:ok)
    expect(csv.map { |row| row[csv.first.index("City")] }).to include("Munchen", "東京", "Sao Paulo")
  end

  # spec/support/geoip_mocking.rb stubs GeoIp.lookup with a table of addresses, and the test environment has no lib/GeoIP2-City.mmdb.
  # MaxMind's published test database, the one geo-ip.test.ts reads, stands in for it: the real GeoIp.lookup and Reader run.
  describe "from the IP address" do
    before do
      stub_const("GEOIP", MaxMind::GeoIP2::Reader.new(database: Rails.root.join("nextjs/src/server/infra/__fixtures__/GeoLite2-City-Test.mmdb").to_s))
      allow(GeoIp).to receive(:lookup).and_call_original
    end

    def column(name) = csv.map { |row| row[csv.first.index(name)] }

    # `sell`'s own `state:` is the purchase state, so the address's state is written by column.
    def sold_from(ip_address, state:, country:)
      sell(ip_address:, country:).tap { |row| row.update_columns(state:) }
    end

    it "writes the state and country of the sale's IP address when the sale has neither", parity: true do
      sold_from("2.125.160.216", state: nil, country: nil)
      sold_from("216.160.83.56", state: nil, country: nil)
      sold_from("175.16.199.0", state: nil, country: nil)
      sold_from("2001:218::", state: nil, country: nil)

      export

      expect(response).to have_http_status(:ok)
      expect(column("State")).to include("WBK", "WA", "22")
      expect(column("Country")).to include("United Kingdom", "United States", "China", "Japan")
    end

    it "writes the region code of a city and leaves the state blank for an address the database has no region for", parity: true do
      sold_from("89.160.20.112", state: nil, country: nil)
      sold_from("202.196.224.0", state: nil, country: nil)

      export

      expect(response).to have_http_status(:ok)
      expect(column("State")).to include("E")
      expect(column("Country")).to include("Sweden", "Philippines")
    end

    it "reads from the IP address only the one of the state and the country that the sale lacks", parity: true do
      sold_from("216.160.83.56", state: "CA", country: nil)
      sold_from("216.160.83.56", state: nil, country: "Canada")
      sold_from("216.160.83.56", state: "", country: "")

      export

      expect(response).to have_http_status(:ok)
      expect(column("State")).to include("CA", "WA")
      expect(column("Country")).to include("United States", "Canada")
    end

    it "writes nothing for an address the database does not know, a blank one, or one that is no address", parity: true do
      sold_from("10.0.0.1", state: nil, country: nil)
      sold_from(nil, state: nil, country: nil)
      sold_from("", state: nil, country: nil)
      sold_from("not an address", state: nil, country: nil)

      export

      expect(response).to have_http_status(:ok)
    end
  end

  it "writes the buyer currency, the total charged in it and the refunds that returned it", parity: true do
    cad = sell(price_cents: 1000)
    charged_in(cad, "cad", 1350)
    refund(cad, 400, presentment_currency: "cad", presentment_amount_cents: 540)
    refund(cad, 100, presentment_currency: "cad", presentment_amount_cents: 135)
    charged_in(sell(price_cents: 1500), "jpy", 1500)
    kwd = sell(price_cents: 4000)
    charged_in(kwd, "KWD", 12_345)
    refund(kwd, 1000, presentment_currency: "kwd", presentment_amount_cents: 3_086)
    charged_in(sell(price_cents: 800), "eur", 1_099)
    legacy = sell(price_cents: 900)
    charged_in(legacy, "gbp", 777)
    refund(legacy, 300)
    failed = sell(price_cents: 1100)
    charged_in(failed, "aud", 1_650)
    refund(failed, 1100, presentment_currency: "aud", presentment_amount_cents: 1_650, status: "failed", balance_reversed_on_failure: true)
    refund(sell(price_cents: 1200), 200, presentment_currency: "usd", presentment_amount_cents: 0)

    export

    expect(response).to have_http_status(:ok)
    expect(csv.map { |row| row[csv.first.index("Buyer Currency")] }).to include("CAD", "JPY", "KWD", "EUR", "GBP", "AUD")
  end

  it "flags a sale whose order's cart was sent an abandoned cart email by the seller", parity: true do
    mine = create(:abandoned_cart_workflow, seller:, published_at: 1.day.ago).installments.first
    others = create(:abandoned_cart_workflow, published_at: 1.day.ago).installments.first
    buyer = create(:user, email: "cart-buyer@example.com")

    in_cart_of_order(sell(price_cents: 500), buyer, emails: [mine])
    in_cart_of_order(sell(price_cents: 600), buyer, emails: [others])
    in_cart_of_order(sell(price_cents: 700), buyer, emails: [others, mine])
    in_cart_of_order(sell(price_cents: 800), buyer, deleted: true, emails: [mine])
    in_cart_of_order(sell(price_cents: 900), buyer)
    orderless_cart = Order.create!(purchaser: buyer).tap { |order| OrderPurchase.create!(order:, purchase: sell(price_cents: 1000)) }
    expect(orderless_cart.cart).to be_nil
    sell(price_cents: 1100)

    export

    expect(response).to have_http_status(:ok)
    expect(csv.map { |row| row[csv.first.index("Sent Abandoned Cart Email?")] }).to include("1", "0")
  end

  describe "subscription charges" do
    let(:membership) { create(:membership_product_with_preset_tiered_pricing, user: seller, name: "Club", recurrence_price_values: [{ "monthly": { enabled: true, price: 3 }, "yearly": { enabled: true, price: 30 } }, { "monthly": { enabled: true, price: 5 } }]) }
    let(:first_tier) { membership.tiers.first }
    let(:yearly) { membership.prices.find_by(recurrence: "yearly") || create(:price, link: membership, recurrence: "yearly", price_cents: 3000) }

    # create(:subscription) only builds the subscription and its payment option, so no card is charged.
    def subscribed(price: membership.default_price, **attributes)
      create(:subscription, link: membership, user: nil, price:, **attributes)
    end

    def charge(subscription, original: false, **attributes)
      sell(of: membership, subscription:, is_original_subscription_purchase: original, **attributes).tap { |row| row.variant_attributes << first_tier }
    end

    def column(name) = csv.map { |row| row[csv.first.index(name)] }

    it "writes the recurrence of the subscription's price, the recurring charge flag and the dates the subscription was cancelled and ended", parity: true do
      monthly = subscribed
      charge(monthly, original: true, price_cents: 300)
      charge(monthly, price_cents: 300, created_at: Time.utc(2026, 4, 4, 5, 6, 7))
      annual = subscribed(price: yearly, user_requested_cancellation_at: Time.utc(2026, 5, 6, 7, 8, 9), cancelled_at: Time.utc(2027, 3, 4, 5, 6, 7))
      charge(annual, original: true, price_cents: 3000)
      charge(annual, price_cents: 3000, created_at: Time.utc(2027, 3, 4, 5, 6, 7))

      export

      expect(response).to have_http_status(:ok)
      expect(column("Recurrence")).to include("monthly", "yearly")
      expect(column("Recurring Charge?")).to include("1", "0")
    end

    it "ends the subscription at the first of its ended, cancelled, failed and deactivated times", parity: true do
      # Replays seed a time to the nearest hour of the recording, so these stay clear of midnight to keep their day.
      ended = subscribed(ended_at: Time.utc(2026, 6, 1, 12, 0, 0), cancelled_at: Time.utc(2026, 5, 1, 9, 30, 3), failed_at: Time.utc(2026, 4, 1, 9, 30, 3), deactivated_at: Time.utc(2026, 7, 1, 9, 30, 3))
      cancelled = subscribed(cancelled_at: Time.utc(2026, 5, 2, 9, 30, 1), failed_at: Time.utc(2026, 4, 2, 9, 30, 3), deactivated_at: Time.utc(2026, 7, 2, 9, 30, 3))
      failed = subscribed(failed_at: Time.utc(2026, 4, 3, 15, 30, 0), deactivated_at: Time.utc(2026, 7, 3, 9, 30, 3))
      deactivated = subscribed(deactivated_at: Time.utc(2026, 7, 4, 9, 30, 3))
      live = subscribed
      [ended, cancelled, failed, deactivated, live].each { |subscription| charge(subscription, original: true, price_cents: 300) }

      export

      expect(response).to have_http_status(:ok)
      expect(column("Subscription End Date")).to include("2026-06-01", "2026-05-02", "2026-04-03", "2026-07-04")
    end

    it "prices a tier from the recurrence of the subscription and writes nothing for a recurrence the tier has no price for", parity: true do
      monthly = subscribed
      charge(monthly, original: true, price_cents: 300)
      annual = subscribed(price: yearly)
      charge(annual, original: true, price_cents: 3000)
      second_tier = membership.tiers.second
      sell(of: membership, subscription: subscribed(price: yearly), is_original_subscription_purchase: true, price_cents: 500).variant_attributes << second_tier
      deleted_price = membership.tiers.first.prices.find_by(recurrence: "monthly")
      deleted_tier = create(:variant, variant_category: membership.tier_category, name: "Retired")
      deleted_tier.save_recurring_prices!("monthly": { enabled: true, price: 7 })
      deleted_tier.prices.update_all(deleted_at: Time.utc(2026, 2, 1))
      sell(of: membership, subscription: subscribed, is_original_subscription_purchase: true, price_cents: 700).variant_attributes << deleted_tier

      export

      expect(response).to have_http_status(:ok)
      expect(deleted_price).to be_present
      expect(column("Variants Price ($)")).to include("3.0", "0.0")
    end

    it "prefers the price on the charge itself to the subscription's for the tier's price", parity: true do
      row = charge(subscribed, original: true, price_cents: 3000)
      row.update_columns(price_id: yearly.id)

      export

      expect(response).to have_http_status(:ok)
    end

    it "reads the review of the subscription's original purchase for each of its charges and leaves out a deleted review", parity: true do
      monthly = subscribed
      original = charge(monthly, original: true, price_cents: 300)
      charge(monthly, price_cents: 300, created_at: Time.utc(2026, 4, 4, 5, 6, 7))
      ProductReview.new(purchase: original, link: membership, rating: 4, message: "Still worth it").save!(validate: false)
      removed = subscribed
      removed_original = charge(removed, original: true, price_cents: 300)
      charge(removed, price_cents: 300, created_at: Time.utc(2026, 4, 4, 5, 6, 7))
      ProductReview.new(purchase: removed_original, link: membership, rating: 1, message: "Removed", deleted_at: Time.utc(2026, 3, 5)).save!(validate: false)
      reviewed_charge = subscribed
      charge(reviewed_charge, original: true, price_cents: 300)
      later = charge(reviewed_charge, price_cents: 300, created_at: Time.utc(2026, 4, 4, 5, 6, 7))
      # ProductReview refuses a recurring charge, so the row an older import could have left is inserted whole.
      ProductReview.insert_all!([{ purchase_id: later.id, link_id: membership.id, rating: 2, message: "Only on the charge", created_at: Time.utc(2026, 4, 5), updated_at: Time.utc(2026, 4, 5) }])
      sell(price_cents: 500).tap { |row| ProductReview.new(purchase: row, link: product, rating: 3, message: "Gone", deleted_at: Time.utc(2026, 3, 5)).save!(validate: false) }
      # The first original purchase of a subscription owns the review, not a later one.
      renewed = subscribed
      older = charge(renewed, original: true, price_cents: 300)
      newer = charge(renewed, original: true, price_cents: 300, created_at: Time.utc(2026, 4, 4, 5, 6, 7))
      ProductReview.new(purchase: older, link: membership, rating: 5, message: "Older original").save!(validate: false)
      ProductReview.new(purchase: newer, link: membership, rating: 2, message: "Newer original").save!(validate: false)

      export

      expect(response).to have_http_status(:ok)
      expect(column("Review")).to include("Still worth it", "Older original")
    end

    it "reads the recurrence from the last payment option, else the newest live one, and nothing when its price is gone", parity: true do
      deleted_last = subscribed
      option = create(:payment_option, subscription: deleted_last, price: yearly)
      deleted_last.update_columns(last_payment_option_id: option.id)
      option.update_columns(deleted_at: Time.utc(2026, 2, 1))
      unset_last = subscribed
      create(:payment_option, subscription: unset_last, price: yearly)
      create(:payment_option, subscription: unset_last, price: membership.default_price).update_columns(deleted_at: Time.utc(2026, 2, 1))
      unset_last.update_columns(last_payment_option_id: nil)
      missing_last = subscribed(price: yearly)
      missing_last.update_columns(last_payment_option_id: 987_654_321)
      priceless = subscribed
      priceless.payment_options.update_all(price_id: 987_654_321)
      [deleted_last, unset_last, missing_last, priceless].each { |subscription| charge(subscription, original: true, price_cents: 300) }

      export

      expect(response).to have_http_status(:ok)
      expect(column("Recurrence")).to include("yearly")
    end

    describe "of a licensed product" do
      let(:licensed) { create(:product, user: seller, name: "Licensed club", is_recurring_billing: true, subscription_duration: :monthly, is_licensed: true) }
      let(:subscription) { create(:subscription, link: licensed, user: nil) }

      def licensed_charge(original: false, **attributes)
        sell(of: licensed, subscription:, is_original_subscription_purchase: original, price_cents: 300, **attributes)
      end

      def archive(row) = row.update_columns(flags: row.flags | Purchase.flag_mapping["flags"][:is_archived_original_subscription_purchase])

      it "reads the license key, its activations and whether it is enabled from the subscription's original purchase", parity: true do
        original = licensed_charge(original: true)
        License.create!(purchase: original, link: licensed, serial: "SUBS-AAAA-BBBB-CCCC", uses: 4)
        licensed_charge(created_at: Time.utc(2026, 4, 4, 5, 6, 7))
        disabled = create(:subscription, link: licensed, user: nil)
        disabled_original = sell(of: licensed, subscription: disabled, is_original_subscription_purchase: true, price_cents: 300)
        License.create!(purchase: disabled_original, link: licensed, serial: "SUBS-DDDD-EEEE-FFFF", uses: 0, disabled_at: Time.utc(2026, 3, 5))
        sell(of: licensed, subscription: disabled, price_cents: 300, created_at: Time.utc(2026, 4, 4, 5, 6, 7))

        export

        expect(response).to have_http_status(:ok)
        expect(column("License Key").count("SUBS-AAAA-BBBB-CCCC")).to eq(2)
      end

      it "skips an archived original purchase for the one that is live", parity: true do
        archived = licensed_charge(original: true, created_at: Time.utc(2026, 2, 4, 5, 6, 7))
        License.create!(purchase: archived, link: licensed, serial: "OLD-AAAA-BBBB-CCCC", uses: 9)
        archive(archived)
        live = licensed_charge(original: true)
        License.create!(purchase: live, link: licensed, serial: "LIVE-AAAA-BBBB-CCCC", uses: 1)
        licensed_charge(created_at: Time.utc(2026, 4, 4, 5, 6, 7))

        export

        expect(response).to have_http_status(:ok)
        expect(column("License Key")).to include("LIVE-AAAA-BBBB-CCCC")
      end

      it "hands a subscription with two live original purchases to Rails", parity: true do
        licensed_charge(original: true)
        licensed_charge(original: true, created_at: Time.utc(2026, 3, 5, 5, 6, 7))
        licensed_charge(created_at: Time.utc(2026, 4, 4, 5, 6, 7))

        export

        expect(response).to have_http_status(:ok)
      end
    end

    it "writes the recurrence and the price difference of a variant of a subscription product that is not a tiered membership", parity: true do
      recurring = create(:product, user: seller, name: "Recurring", is_recurring_billing: true, subscription_duration: :monthly)
      category = create(:variant_category, link: recurring, title: "Size")
      large = create(:variant, variant_category: category, name: "Large", price_difference_cents: 150)
      subscription = create(:subscription, link: recurring, user: nil)
      sell(of: recurring, subscription:, is_original_subscription_purchase: true, price_cents: 650).variant_attributes << large

      export

      expect(response).to have_http_status(:ok)
      expect(column("Variants Price ($)")).to include("1.5")
    end

    it "writes a free trial membership that has not been charged", parity: true do
      trial = subscribed(free_trial_ends_at: Time.utc(2026, 3, 11, 5, 6, 7))
      charge(trial, original: true, price_cents: 0, state: "not_charged", is_free_trial_purchase: true)

      export

      expect(response).to have_http_status(:ok)
    end

    it "hands a tier with two live prices for the subscription's recurrence to Rails", parity: true do
      charge(subscribed, original: true, price_cents: 300)
      duplicate = first_tier.prices.find_by(recurrence: "monthly").dup
      duplicate.save!(validate: false)

      export

      expect(response).to have_http_status(:ok)
    end

    describe "of an installment plan" do
      let(:plan_product) { create(:product, :with_installment_plan, user: seller, name: "Plan product") }

      def paid(plan, original: false, **attributes)
        sell(of: plan_product, subscription: plan, is_original_subscription_purchase: original, is_installment_payment: true, **attributes)
      end

      it "writes the payments of a plan that is still being paid as recurring charges of one subscription", parity: true do
        plan = create(:subscription, link: plan_product, user: nil, is_installment_plan: true)
        paid(plan, original: true, price_cents: 300)
        paid(plan, price_cents: 300, created_at: Time.utc(2026, 4, 4, 5, 6, 7))
        paid(plan, price_cents: 300, created_at: Time.utc(2026, 5, 4, 5, 6, 7))

        export

        expect(response).to have_http_status(:ok)
        expect(column("Recurring Charge?")).to include("0", "1")
      end

      it "writes the dates a plan was cancelled and ended", parity: true do
        cancelled = create(:subscription, link: plan_product, user: nil, is_installment_plan: true, user_requested_cancellation_at: Time.utc(2026, 4, 1, 8, 9, 10), cancelled_at: Time.utc(2026, 4, 2, 8, 9, 10))
        paid(cancelled, original: true, price_cents: 300)
        finished = create(:subscription, link: plan_product, user: nil, is_installment_plan: true, ended_at: Time.utc(2026, 6, 1, 8, 9, 10))
        paid(finished, original: true, price_cents: 300)
        paid(finished, price_cents: 300, created_at: Time.utc(2026, 4, 4, 5, 6, 7))

        export

        expect(response).to have_http_status(:ok)
        expect(column("Cancellation Date")).to include("2026-04-01 08:09:10 UTC")
        expect(column("Subscription End Date")).to include("2026-04-02", "2026-06-01")
      end

      it "reads the recurrence from the payment option of the plan", parity: true do
        monthly = create(:price, link: plan_product, recurrence: "monthly", price_cents: 300)
        plan = create(:subscription, link: plan_product, user: nil, is_installment_plan: true, price: monthly)
        paid(plan, original: true, price_cents: 300)

        export

        expect(response).to have_http_status(:ok)
        expect(column("Recurrence")).to include("monthly")
      end
    end

    it "prices a tier from its buy price and not from a rental price for the same recurrence", parity: true do
      charge(subscribed, original: true, price_cents: 300)
      rental = first_tier.prices.find_by(recurrence: "monthly").dup
      rental.is_rental = true
      rental.price_cents = 99
      rental.save!(validate: false)
      annual = subscribed(price: yearly)
      charge(annual, original: true, price_cents: 3000)
      first_tier.prices.find_by(recurrence: "yearly").update_column(:flags, 1)

      export

      expect(response).to have_http_status(:ok)
      expect(column("Variants Price ($)")).to include("3.0", "0.0")
    end

    it "writes a gifted membership's sender from the review of the subscription's original purchase", parity: true do
      subscription = subscribed
      sender = sell(of: membership, subscription:, is_original_subscription_purchase: true, is_gift_sender_purchase: true, price_cents: 300, email: "gifter@example.com")
      receiver = sell(of: membership, subscription:, state: "gift_receiver_purchase_successful", is_gift_receiver_purchase: true, price_cents: 0, email: "giftee@example.com")
      [sender, receiver].each { |row| row.variant_attributes << first_tier }
      Gift.create!(link: membership, gifter_purchase: sender, giftee_purchase: receiver, gifter_email: "gifter@example.com", giftee_email: "giftee@example.com", state: "successful")
      # A review callback refuses a gift sender's purchase, so the rows are inserted.
      ProductReview.insert_all!([{ purchase_id: sender.id, link_id: membership.id, rating: 4, message: "Sender note" }, { purchase_id: receiver.id, link_id: membership.id, rating: 2, message: "Receiver note" }])

      export

      expect(response).to have_http_status(:ok)
      expect(column("Giftee Email")).to include("giftee@example.com")
      expect(column("Review")).to include("Sender note")
    end

    it "hands a gifted membership whose receiver is on another subscription to Rails", parity: true do
      sender = sell(of: membership, subscription: subscribed, is_original_subscription_purchase: true, is_gift_sender_purchase: true, price_cents: 300, email: "gifter@example.com")
      receiver = sell(of: membership, subscription: subscribed, state: "gift_receiver_purchase_successful", is_gift_receiver_purchase: true, price_cents: 0, email: "giftee@example.com")
      Gift.create!(link: membership, gifter_purchase: sender, giftee_purchase: receiver, gifter_email: "gifter@example.com", giftee_email: "giftee@example.com", state: "successful")

      export

      expect(response).to have_http_status(:ok)
    end

    # Rails raises on these rows (a NoMethodError the request spec cannot record as a response), so Node leaves them to it.
    it "hands a gifted membership whose receiver is not flagged as one to Rails", parity: true do
      subscription = subscribed
      sender = sell(of: membership, subscription:, is_original_subscription_purchase: true, is_gift_sender_purchase: true, price_cents: 300, email: "gifter@example.com")
      receiver = sell(of: membership, subscription:, state: "gift_receiver_purchase_successful", price_cents: 0, email: "giftee@example.com")
      Gift.create!(link: membership, gifter_purchase: sender, giftee_purchase: receiver, gifter_email: "gifter@example.com", giftee_email: "giftee@example.com", state: "successful")

      export

      expect(response).to have_http_status(:ok)
    end

    describe "Rails cannot export" do
      it "a sale whose subscription is gone" do
        charge(subscribed, original: true, price_cents: 300).update_columns(subscription_id: 0)

        expect { export }.to raise_error(NoMethodError, /true_original_purchase/)
      end

      it "a subscription without a payment option" do
        subscription = subscribed
        charge(subscription, original: true, price_cents: 300)
        PaymentOption.where(subscription_id: subscription.id).delete_all
        subscription.update_columns(last_payment_option_id: nil)

        expect { export }.to raise_error(NoMethodError, /price/)
      end

      it "a SKU of a tiered membership" do
        row = charge(subscribed, original: true, price_cents: 300)
        row.variant_attributes.destroy_all
        row.variant_attributes << create(:sku, link: membership, name: "Sized")

        expect { export }.to raise_error(NoMethodError, /prices/)
      end
    end
  end

  it "writes the PayPal transaction and fee columns of a PayPal sale", parity: true do
    sell(price_cents: 500, fee_cents: 100, paypal_order_id: "9AB12345CD678901E", stripe_transaction_id: "5TX123456789", processor_fee_cents: 35, processor_fee_cents_currency: "usd", card_type: CardType::PAYPAL, charge_processor_id: "paypal")
    sell(price_cents: 700, paypal_order_id: "7ZZ00000000000001", stripe_transaction_id: "5TX987654321", processor_fee_cents: 1999, processor_fee_cents_currency: "eur", card_type: CardType::PAYPAL, charge_processor_id: "paypal")
    sell(price_cents: 800, paypal_order_id: "7ZZ00000000000002", stripe_transaction_id: nil, processor_fee_cents: nil, processor_fee_cents_currency: nil, charge_processor_id: "paypal")
    sell(price_cents: 900, stripe_transaction_id: "ch_not_paypal", processor_fee_cents: 50)

    export

    expect(response).to have_http_status(:ok)
    expect(csv.map { |row| row[csv.first.index("PayPal Transaction ID")] }).to include("5TX123456789")
  end

  it "writes the Stripe transaction and fee columns of a sale charged on a seller's own Connect account only", parity: true do
    connect = create(:merchant_account_stripe_connect, user: seller)
    sell(price_cents: 500, fee_cents: 100, merchant_account: connect, stripe_transaction_id: "ch_connect_1", processor_fee_cents: 45, processor_fee_cents_currency: "usd", charge_processor_id: "stripe")
    sell(price_cents: 600, merchant_account: connect, stripe_transaction_id: nil, processor_fee_cents: nil, processor_fee_cents_currency: "eur", charge_processor_id: "stripe")
    managed = create(:merchant_account, user: seller)
    sell(price_cents: 700, merchant_account: managed, stripe_transaction_id: "ch_own_account", processor_fee_cents: 60, charge_processor_id: "stripe")
    gumroad = create(:merchant_account, user: nil)
    sell(price_cents: 800, merchant_account: gumroad, stripe_transaction_id: "ch_gumroad", processor_fee_cents: 70, charge_processor_id: "stripe")
    deleted = create(:merchant_account_stripe_connect, user: seller, deleted_at: Time.utc(2026, 3, 1))
    sell(price_cents: 950, merchant_account: deleted, stripe_transaction_id: "ch_deleted_connect", processor_fee_cents: 90, charge_processor_id: "stripe")
    sell(price_cents: 960, stripe_transaction_id: "ch_dangling", processor_fee_cents: 95).update_columns(merchant_account_id: 987_654)
    paypal_account = create(:merchant_account_paypal, user: seller)
    sell(price_cents: 900, merchant_account: paypal_account, stripe_transaction_id: "5TX_PAYPAL_CONNECT", processor_fee_cents: 80, charge_processor_id: "paypal")

    export

    expect(response).to have_http_status(:ok)
    expect(csv.map { |row| row[csv.first.index("Stripe Transaction ID")] }).to include("ch_connect_1")
  end

  it "writes a checkbox or terms answer that is blank as nil and the other spellings of false as false", parity: true do
    first = sell
    first.purchase_custom_fields.create!(name: "Newsletter", value: true, field_type: "checkbox")
    first.purchase_custom_fields.create!(name: "Updates", value: true, field_type: "checkbox").update_columns(value: nil)
    first.purchase_custom_fields.create!(name: "Offers", value: true, field_type: "checkbox").update_columns(value: "")
    first.purchase_custom_fields.create!(name: "Terms", value: true, field_type: "terms")
    second = sell
    second.purchase_custom_fields.create!(name: "Newsletter", value: true, field_type: "checkbox").update_columns(value: "off")
    second.purchase_custom_fields.create!(name: "Updates", value: true, field_type: "checkbox").update_columns(value: "F")
    second.purchase_custom_fields.create!(name: "Offers", value: true, field_type: "checkbox").update_columns(value: " ")
    second.purchase_custom_fields.create!(name: "Terms", value: true, field_type: "terms").update_columns(value: nil)

    export

    expect(response).to have_http_status(:ok)
    expect(csv.first.last(4)).to eq(%w[Newsletter Updates Offers Terms])
  end

  it "writes a custom field name and value of letters, marks, numbers, punctuation and symbols outside ASCII", parity: true do
    answered = sell
    answered.purchase_custom_fields.create!(name: "Größe", value: "Zoë Åström", field_type: "text")
    answered.purchase_custom_fields.create!(name: "名前", value: "日本語 – “quoted” 5² €10 ¿Qué?", field_type: "long_text")
    answered.purchase_custom_fields.create!(name: "Mood", value: "😀 ❤️ café#{"\u0301"}", field_type: "text")
    sell.purchase_custom_fields.create!(name: "Größe", value: "Ünïcödé", field_type: "text")

    export

    expect(response).to have_http_status(:ok)
    expect(csv.first.last(3)).to eq(%w[Größe 名前 Mood])
  end

  it "hands a custom field value that Ruby escapes in its inspect to Rails", parity: true do
    sell.purchase_custom_fields.create!(name: "Note", value: "zero#{"\u200B"}width", field_type: "text")

    export

    expect(response).to have_http_status(:ok)
  end

  it "writes the giftee's email and reads the review and license key of a gift from the giftee's purchase", parity: true do
    licensed = create(:product, user: seller, name: "Licensed gift", is_licensed: true)
    sent = sell(of: licensed, price_cents: 700, email: "gifter@example.com", is_gift_sender_purchase: true)
    received = sell(of: licensed, price_cents: 0, state: "gift_receiver_purchase_successful", email: "giftee@example.com", is_gift_receiver_purchase: true)
    Gift.create!(link: licensed, gifter_purchase: sent, giftee_purchase: received, gifter_email: "gifter@example.com", giftee_email: "giftee@example.com", state: "successful")
    ProductReview.new(purchase: received, link: licensed, rating: 5, message: "Lovely gift").save!(validate: false)
    License.create!(purchase: received, link: licensed, serial: "GIFT-AAAA-BBBB-CCCC", uses: 2)
    plain_sent = sell(price_cents: 300, email: "other-gifter@example.com", is_gift_sender_purchase: true)
    plain_received = sell(price_cents: 0, state: "gift_receiver_purchase_successful", email: "other-giftee@example.com", is_gift_receiver_purchase: true)
    Gift.create!(link: product, gifter_purchase: plain_sent, giftee_purchase: plain_received, gifter_email: "other-gifter@example.com", giftee_email: "other-giftee@example.com", state: "successful")

    export

    expect(response).to have_http_status(:ok)
    expect(csv.map { |row| row[csv.first.index("Giftee Email")] }).to include("giftee@example.com", "other-giftee@example.com")
    expect(csv.map { |row| row[csv.first.index("License Key")] }).to include("GIFT-AAAA-BBBB-CCCC")
  end

  it "writes the giftee's email of a gift of a product with variants and reads nothing of the license from them", parity: true do
    category = create(:variant_category, link: product, title: "Size")
    large = create(:variant, variant_category: category, name: "Large", price_difference_cents: 150)
    sent = sell(price_cents: 650, email: "gifter@example.com", is_gift_sender_purchase: true)
    received = sell(price_cents: 0, state: "gift_receiver_purchase_successful", email: "giftee@example.com", is_gift_receiver_purchase: true)
    [sent, received].each { |row| row.variant_attributes << large }
    Gift.create!(link: product, gifter_purchase: sent, giftee_purchase: received, gifter_email: "gifter@example.com", giftee_email: "giftee@example.com", state: "successful")

    export

    expect(response).to have_http_status(:ok)
    expect(csv.map { |row| row[csv.first.index("Variants")] }).to include("(Large)")
  end

  it "hands a gift of a licensed product whose receiver holds a variant to Rails", parity: true do
    licensed = create(:product, user: seller, name: "Licensed gift", is_licensed: true)
    category = create(:variant_category, link: licensed, title: "Size")
    large = create(:variant, variant_category: category, name: "Large")
    sent = sell(of: licensed, price_cents: 700, email: "gifter@example.com", is_gift_sender_purchase: true)
    received = sell(of: licensed, price_cents: 0, state: "gift_receiver_purchase_successful", email: "giftee@example.com", is_gift_receiver_purchase: true)
    received.variant_attributes << large
    Gift.create!(link: licensed, gifter_purchase: sent, giftee_purchase: received, gifter_email: "gifter@example.com", giftee_email: "giftee@example.com", state: "successful")
    License.create!(purchase: received, link: licensed, serial: "GIFT-DDDD-EEEE-FFFF", uses: 1)

    export

    expect(response).to have_http_status(:ok)
  end

  it "flags a pre-order authorization and writes the authorization time on its charge", parity: true do
    preordered = create(:product, user: seller, name: "Pre-ordered")
    preorder_link = create(:preorder_link, link: preordered, release_at: 2.months.from_now)
    preorder = create(:preorder, preorder_link:, seller:, state: "charge_successful", created_at: Time.utc(2026, 2, 3, 4, 5, 6))
    sell(of: preordered, price_cents: 500, preorder:, state: "preorder_authorization_successful", is_preorder_authorization: true)
    sell(of: preordered, price_cents: 500, preorder:)

    export

    expect(response).to have_http_status(:ok)
    expect(csv.map { |row| row[csv.first.index("Pre-order authorization?")] }).to include("1", "0")
    expect(csv.map { |row| row[csv.first.index("Pre-order authorization time (UTC timezone)")] }).to include("2026-02-03 04:05:06 +0000")
  end
end
