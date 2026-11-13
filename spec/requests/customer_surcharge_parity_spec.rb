# frozen_string_literal: true

require "spec_helper"

# POST /customer_surcharge for the carts the Next.js port serves (nextjs/src/server/controllers/customer-surcharge.ts):
# one-time digital lines, a buyer taxed from the lookup table, and no seller in the buyer-currency rollout. Written for
# recording (PARITY_RECORD=1); the examples added after the first recordings (GeoIP, ELSEWHERE, exclusion, preorder,
# membership, installment) have no fixture under nextjs/parity/fixtures yet.
describe "Customer surcharge", type: :request do
  include Parity::AudienceSignedIn

  let(:seller) { create(:user) }
  let(:product) { create(:product, user: seller, unique_permalink: "surcharge") }
  let(:other_product) { create(:product, user: seller, unique_permalink: "surchargetwo") }
  let(:json_headers) do
    { "Accept" => "application/json", "X-Requested-With" => "XMLHttpRequest", "Content-Type" => "application/json", "Referer" => "http://#{DOMAIN}/checkout" }
  end

  before { host! DOMAIN }

  def post_surcharge(body)
    post "/customer_surcharge", params: body.to_json, headers: json_headers.merge("X-CSRF-Token" => csrf_token)
  end

  def stub_dropped_connection(method, url)
    stub_request(method, url).to_return do |request|
      Parity::Recorder.current&.record_dropped_http(request)
      raise Errno::ECONNRESET
    end
  end

  def line(item, price: 100, **extra)
    { permalink: item.unique_permalink, price:, quantity: 1 }.merge(extra)
  end

  def create_de_vat_rate
    create(:zip_tax_rate, combined_rate: 0.19, country: "DE", state: nil, zip_code: nil, is_seller_responsible: false)
  end

  it "totals a plain cart with no buyer location", parity: true do
    post_surcharge(products: [line(product)])

    expect(response.parsed_body).to include("subtotal" => 100, "tax_cents" => 0, "charge_canonical_total_cents" => 100)
  end

  it "adds the Gumroad-collected VAT of a German buyer", parity: true do
    create_de_vat_rate

    post_surcharge(products: [line(product)], postal_code: "10115", country: "DE")

    expect(response.parsed_body).to include("subtotal" => 100, "tax_cents" => 19, "has_vat_id_input" => true, "charge_canonical_total_cents" => 119)
  end

  it "charges no VAT on a free line", parity: true do
    create_de_vat_rate

    post_surcharge(products: [line(product, price: 0)], postal_code: "10115", country: "DE")

    expect(response.parsed_body).to include("subtotal" => 0, "tax_cents" => 0, "has_vat_id_input" => false)
  end

  it "rounds the VAT of each line and sums the cart", parity: true do
    create(:zip_tax_rate, combined_rate: 0.2, country: "DE", state: nil, zip_code: nil, is_seller_responsible: false)

    post_surcharge(products: [line(product, price: 1_003), line(other_product, price: 502)], postal_code: "10115", country: "DE")

    expect(response.parsed_body).to include("subtotal" => 1_505, "tax_cents" => 301, "charge_canonical_total_cents" => 1_806)
  end

  it "charges no tax when the buyer's country has no rate", parity: true do
    post_surcharge(products: [line(product)], postal_code: "75001", country: "FR")

    expect(response.parsed_body).to include("tax_cents" => 0, "has_vat_id_input" => false)
  end

  it "charges no tax in a US state that is not a taxable state", parity: true do
    post_surcharge(products: [line(product)], postal_code: "94104", country: "US")

    expect(response.parsed_body).to include("tax_cents" => 0)
  end

  it "reads a string price and an unparsable price like to_d.to_i", parity: true do
    post_surcharge(products: [line(product, price: "250.9"), line(other_product, price: "invalid")])

    expect(response.parsed_body).to include("subtotal" => 250)
  end

  it "withholds the charge totals when a permalink matches no product", parity: true do
    post_surcharge(products: [line(product), { permalink: "nosuchproduct", price: 100, quantity: 1 }])

    expect(response.parsed_body).to include("subtotal" => 100, "charge_canonical_total_cents" => nil, "commission_completion_canonical_total_cents" => nil)
  end

  it "offers US dollars alone and no quote", parity: true do
    post_surcharge(products: [line(product)])

    expect(response.parsed_body).to include(
      "buyer_currency_quote" => nil,
      "detected_buyer_currency" => nil,
      "available_buyer_currencies" => [{ "code" => "usd", "label" => "$ (US Dollars)" }],
      "direct_listed_amount_token" => nil
    )
  end

  it "detects the buyer's currency from a GeoIP country", parity: true do
    # The suite stubs GeoIp.lookup with a fixed table, so this IP is stubbed to what the GeoLite2 test database the
    # Node port reads (81.2.69.160) says: Great Britain.
    allow(GeoIp).to receive(:lookup).with("81.2.69.160").and_return(
      GeoIp::Result.new(country_name: "United Kingdom", country_code: "GB", region_name: "ENG", city_name: "London", postal_code: nil, latitude: nil, longitude: nil)
    )

    post "/customer_surcharge", params: { products: [line(product)] }.to_json,
                                headers: json_headers.merge("X-CSRF-Token" => csrf_token, "X-Forwarded-For" => "81.2.69.160")

    expect(response.parsed_body).to include(
      "detected_buyer_currency" => "gbp",
      "buyer_currency_quote" => nil,
      "available_buyer_currencies" => [{ "code" => "usd", "label" => "$ (US Dollars)" }]
    )
  end

  it "answers a malformed products param with an empty 400", parity: true do
    post_surcharge(products: ["not-a-product"])

    expect(response).to have_http_status(:bad_request)
    expect(response.body).to eq("")
  end

  %w[xml text js].each do |format|
    it "answers a malformed products param with an empty 400 for the #{format} format param", parity: true do
      post "/customer_surcharge?format=#{format}", params: { products: ["not-a-product"] }.to_json,
                                                    headers: json_headers.merge("X-CSRF-Token" => csrf_token)

      expect(response).to have_http_status(:bad_request)
      expect(response.body).to eq("")
    end
  end

  describe "Singapore, Spanish and physical lines" do
    let(:physical_product) { create(:physical_product, user: seller, unique_permalink: "surchargephysical") }

    def create_sg_rate(years, rate)
      create(:zip_tax_rate, country: "SG", state: nil, zip_code: nil, combined_rate: rate, is_seller_responsible: false, applicable_years: years)
    end

    it "taxes a Singapore buyer with the rate listing the current year", parity: true do
      create_sg_rate([Time.current.year - 1], 0.08)
      create_sg_rate([Time.current.year], 0.09)

      post_surcharge(products: [line(product, price: 1_000)], country: "SG")

      expect(response.parsed_body).to include("tax_cents" => 90, "has_vat_id_input" => true)
    end

    it "falls back to the Singapore rate with the latest year", parity: true do
      create_sg_rate([2001], 0.07)
      create_sg_rate([2003, 2002], 0.08)

      post_surcharge(products: [line(product, price: 1_000)], country: "SG")

      expect(response.parsed_body).to include("tax_cents" => 80)
    end

    it "takes the later Singapore rate when two rates tie on their latest year", parity: true do
      create_sg_rate([2003], 0.08)
      create_sg_rate([2003, 2001], 0.09)

      post_surcharge(products: [line(product, price: 1_000)], country: "SG")

      expect(response.parsed_body).to include("tax_cents" => 90)
    end

    it "taxes a Spanish buyer outside the Canary Islands and exempts a Canary postal code", parity: true do
      create(:zip_tax_rate, combined_rate: 0.21, country: "ES", state: nil, zip_code: nil, is_seller_responsible: false)

      post_surcharge(products: [line(product, price: 1_000)], country: "ES", postal_code: "08001")
      expect(response.parsed_body).to include("tax_cents" => 210)

      post_surcharge(products: [line(product, price: 1_000)], country: "ES", postal_code: "35001")
      expect(response.parsed_body).to include("tax_cents" => 0)
    end

    it "adds the shipping rate of the buyer's country for a physical line", parity: true do
      physical_product.shipping_destinations << create(:shipping_destination, country_code: "US", one_item_rate_cents: 500, multiple_items_rate_cents: 200)

      post_surcharge(products: [line(physical_product, price: 1_000, quantity: 3)], country: "US", postal_code: "94104")

      expect(response.parsed_body).to include("shipping_rate_cents" => 900, "subtotal" => 1_000, "charge_canonical_total_cents" => 1_900)
    end

    # The :is_physical trait already gives the product a zero-rate ELSEWHERE destination, and a second one fails the
    # country uniqueness validation (`<<` returns false), so the rate is set on that one.
    def set_elsewhere_rates(one_item, multiple_items)
      physical_product.shipping_destinations.find_by!(country_code: "ELSEWHERE").update!(one_item_rate_cents: one_item, multiple_items_rate_cents: multiple_items)
    end

    it "falls back to the ELSEWHERE destination for a country with no destination of its own", parity: true do
      set_elsewhere_rates(800, 300)
      expect(ShippingDestination.for_product_and_country_code(product: physical_product, country_code: "IT")).to be_present

      post_surcharge(products: [line(physical_product)], country: "IT")

      expect(response.parsed_body).to include("shipping_rate_cents" => 800)
    end

    it "charges no shipping to a country the product excludes", parity: true do
      set_elsewhere_rates(800, 300)
      physical_product.shipping_exclusions.create!(country_code: "FR")

      post_surcharge(products: [line(physical_product)], country: "FR")

      expect(response.parsed_body).to include("shipping_rate_cents" => 0)
    end

    it "ships to a country through the continent destination that lists it", parity: true do
      physical_product.shipping_destinations << create(:shipping_destination, country_code: "NORTH AMERICA", is_virtual_country: true, one_item_rate_cents: 650, multiple_items_rate_cents: 100)
      expect(ShippingDestination.for_product_and_country_code(product: physical_product, country_code: "MX").country_code).to eq("NORTH AMERICA")

      post_surcharge(products: [line(physical_product)], country: "MX", postal_code: "01000")

      expect(response.parsed_body).to include("shipping_rate_cents" => 650)
    end

    it "prefers the continent destination to ELSEWHERE and skips a continent that does not list the country", parity: true do
      set_elsewhere_rates(800, 300)
      physical_product.shipping_destinations << create(:shipping_destination, country_code: "ASIA", is_virtual_country: true, one_item_rate_cents: 700, multiple_items_rate_cents: 100)

      post_surcharge(products: [line(physical_product)], country: "JP", postal_code: "100-0001")
      expect(response.parsed_body).to include("shipping_rate_cents" => 700)

      post_surcharge(products: [line(physical_product)], country: "AU", postal_code: "2000")
      expect(response.parsed_body).to include("shipping_rate_cents" => 800)
    end

    it "drops VAT on a physical line bound for the EU", parity: true do
      create_de_vat_rate
      physical_product.shipping_destinations << create(:shipping_destination, country_code: "DE", one_item_rate_cents: 500, multiple_items_rate_cents: 0)

      post_surcharge(products: [line(physical_product, price: 1_000)], country: "DE", postal_code: "10115")

      expect(response.parsed_body).to include("tax_cents" => 0, "shipping_rate_cents" => 500)
    end
  end

  describe "TaxJar buyers and tax ids" do
    let(:taxjar_url) { "https://api.sandbox.taxjar.com/v2/taxes" }
    let(:physical_product) { create(:physical_product, user: seller, unique_permalink: "surchargephysical") }

    def taxjar_response(amount_to_collect:, rate:, state:, breakdown: {})
      {
        tax: {
          order_total_amount: 10.0, shipping: 0.0, taxable_amount: 10.0, amount_to_collect:, rate:, has_nexus: true,
          freight_taxable: false, tax_source: "destination",
          jurisdictions: { country: "US", state:, county: "KING", city: "SEATTLE" },
          breakdown: { taxable_amount: 10.0, tax_collectable: amount_to_collect, combined_tax_rate: rate, state_tax_rate: 0.065, county_tax_rate: 0.0,
                       city_tax_rate: 0.0, special_district_tax_rate: 0.0 }.merge(breakdown)
        }
      }.to_json
    end

    def stub_taxjar(body, status: 200)
      stub_request(:post, taxjar_url).to_return(status:, body:, headers: { "Content-Type" => "application/json" })
    end

    it "taxes a buyer in a US taxable state through TaxJar and rounds the float amount", parity: true do
      stub_taxjar(taxjar_response(amount_to_collect: 1.025, rate: 0.1025, state: "WA"))

      post_surcharge(products: [line(product, price: 1_000)], country: "US", postal_code: "98101")

      expect(response.parsed_body).to include("tax_cents" => 102, "subtotal" => 1_000, "has_vat_id_input" => false, "charge_canonical_total_cents" => 1_102)
    end

    it "sends the unit price, quantity and shipping of a physical line to TaxJar", parity: true do
      stub_taxjar(taxjar_response(amount_to_collect: 3.4, rate: 0.1, state: "WA"))
      physical_product.shipping_destinations << create(:shipping_destination, country_code: "US", one_item_rate_cents: 500, multiple_items_rate_cents: 250)

      post_surcharge(products: [line(physical_product, price: 1_000, quantity: 3)], country: "US", postal_code: "98101")

      expect(response.parsed_body).to include("tax_cents" => 340, "shipping_rate_cents" => 1_000, "charge_canonical_total_cents" => 2_340)
    end

    it "sends the SaaS tax code for a product in the software and plugins taxonomy", parity: true do
      software = Taxonomy.find_or_create_by!(slug: "software-and-plugins", parent: Taxonomy.find_or_create_by!(slug: "software-development"))
      wordpress = Taxonomy.find_or_create_by!(slug: "wordpress", parent: software)
      product.update_columns(taxonomy_id: wordpress.id)
      stub_taxjar(taxjar_response(amount_to_collect: 0.5, rate: 0.05, state: "WA"))

      post_surcharge(products: [line(product, price: 1_000, quantity: "2")], country: "US", postal_code: "98101")

      expect(response.parsed_body).to include("tax_cents" => 50)
    end

    it "taxes the first installment through TaxJar on its own", parity: true do
      installment_product = create(:product, :with_installment_plan, user: seller, unique_permalink: "surchargeinstall")
      stub_taxjar(taxjar_response(amount_to_collect: 0.65, rate: 0.065, state: "WA"))

      post_surcharge(products: [line(installment_product, price: 1_000, pay_in_installments: true)], country: "US", postal_code: "98101")

      expect(response.parsed_body).to include("subtotal" => 1_000, "tax_cents" => 65)
      expect(a_request(:post, taxjar_url)).to have_been_made.twice
    end

    it "taxes a Canadian buyer through TaxJar", parity: true do
      stub_taxjar(taxjar_response(amount_to_collect: 1.4, rate: 0.12, state: "BC", breakdown: { gst_tax_rate: 0.05, pst_tax_rate: 0.07 }))

      post_surcharge(products: [line(product, price: 2_000)], country: "CA", state: "BC", postal_code: "V6B 1A1")

      expect(response.parsed_body).to include("tax_cents" => 140, "has_vat_id_input" => false)
    end

    it "offers a tax id input to a Quebec buyer", parity: true do
      stub_taxjar(taxjar_response(amount_to_collect: 2.99, rate: 0.14975, state: "QC", breakdown: { gst_tax_rate: 0.05, qst_tax_rate: 0.09975 }))

      post_surcharge(products: [line(product, price: 2_000)], country: "CA", state: "QC", postal_code: "H2Y 1C6")

      expect(response.parsed_body).to include("tax_cents" => 299, "has_vat_id_input" => true)
    end

    it "falls back to the US state rate in the lookup table when TaxJar is down", parity: true do
      create(:zip_tax_rate, combined_rate: 0.065, country: "US", state: "WA", zip_code: nil, is_seller_responsible: false)
      stub_taxjar({ error: "Service Unavailable" }.to_json, status: 503)

      post_surcharge(products: [line(product, price: 1_000)], country: "US", postal_code: "98101")

      expect(response.parsed_body).to include("tax_cents" => 65, "has_vat_id_input" => false)
    end

    it "falls back to the US state rate in the lookup table when the connection to TaxJar drops", parity: true do
      create(:zip_tax_rate, combined_rate: 0.065, country: "US", state: "WA", zip_code: nil, is_seller_responsible: false)
      stub_dropped_connection(:post, taxjar_url)

      post_surcharge(products: [line(product, price: 1_000)], country: "US", postal_code: "98101")

      expect(response.parsed_body).to include("tax_cents" => 65, "has_vat_id_input" => false)
    end

    it "falls back to the Canadian province rate in the lookup table when TaxJar rejects the request", parity: true do
      create(:zip_tax_rate, combined_rate: 0.12, country: "CA", state: "BC", zip_code: nil, is_seller_responsible: false)
      stub_taxjar({ status: 400, error: "Bad Request", detail: "to_zip" }.to_json, status: 400)

      post_surcharge(products: [line(product, price: 1_000)], country: "CA", state: "BC")

      expect(response.parsed_body).to include("tax_cents" => 120, "has_vat_id_input" => false)
    end

    it "calls TaxJar once for two identical lines", parity: true do
      stub_taxjar(taxjar_response(amount_to_collect: 0.65, rate: 0.065, state: "WA"))

      post_surcharge(products: [line(product, price: 1_000), line(other_product, price: 1_000)], country: "US", postal_code: "98101")

      expect(response.parsed_body).to include("tax_cents" => 130, "subtotal" => 2_000)
      expect(a_request(:post, taxjar_url)).to have_been_made.once
    end

    it "charges no tax on a free line to a TaxJar buyer", parity: true do
      post_surcharge(products: [line(product, price: 0)], country: "US", postal_code: "98101")

      expect(response.parsed_body).to include("tax_cents" => 0, "subtotal" => 0)
    end

    it "accepts a valid Bahraini tax registration number", parity: true do
      post_surcharge(products: [line(product, price: 1_000)], country: "BH", vat_id: "123456789012345")

      expect(response.parsed_body).to include("vat_id_valid" => true, "tax_cents" => 0)
    end

    it "rejects a Bahraini tax registration number of the wrong length", parity: true do
      post_surcharge(products: [line(product, price: 1_000)], country: "BH", vat_id: "12345")

      expect(response.parsed_body).to include("vat_id_valid" => false, "tax_cents" => 0)
    end

    it "validates Kenyan, Nigerian, Tanzanian and Omani tax ids locally", parity: true do
      { "KE" => "A123456789Z", "NG" => "12345678-1234", "TZ" => "12-345678-A", "OM" => "OM1234567890" }.each do |country, vat_id|
        post_surcharge(products: [line(product, price: 1_000)], country:, vat_id:)
        expect(response.parsed_body).to include("vat_id_valid" => true)

        post_surcharge(products: [line(product, price: 1_000)], country:, vat_id: "bad")
        expect(response.parsed_body).to include("vat_id_valid" => false)
      end
    end

    it "does not validate a tax id for a free line", parity: true do
      post_surcharge(products: [line(product, price: 0)], country: "BH", vat_id: "123456789012345")

      expect(response.parsed_body).to include("vat_id_valid" => false)
    end

    it "hands a tax id that needs a vendor lookup back to Rails", parity: true do
      create_de_vat_rate
      allow_any_instance_of(VatValidationService).to receive(:process).and_return(false)

      post_surcharge(products: [line(product, price: 1_000)], country: "DE", postal_code: "10115", vat_id: "DE000")

      expect(response.parsed_body).to include("vat_id_valid" => false, "tax_cents" => 190, "has_vat_id_input" => true)
    end

    describe "tax ids checked by IRAS, Revenu Quebec and taxid.pro" do
      let(:iras_url) { "https://apisandbox.iras.gov.sg/iras/sb/GSTListing/SearchGSTRegistered" }
      let(:qst_url) { "https://svcnab2b.revenuquebec.ca/2019/02/ValidationTVQ/" }
      let(:taxid_url) { "https://v3.api.taxid.pro/validate" }
      let(:json_type) { { "Content-Type" => "application/json" } }

      def stub_iras(status: "Registered", return_code: "10")
        stub_request(:post, iras_url).to_return(status: 200, body: { returnCode: return_code, data: { Status: status } }.to_json, headers: json_type)
      end

      def create_sg_rate
        create(:zip_tax_rate, country: "SG", state: nil, zip_code: nil, combined_rate: 0.09, is_seller_responsible: false, applicable_years: [Time.current.year])
      end

      it "zeroes the tax of a Singapore buyer whose GST id IRAS lists as registered", parity: true do
        create_sg_rate
        stub_iras

        post_surcharge(products: [line(product, price: 1_000)], country: "SG", vat_id: "M90000001A")

        expect(response.parsed_body).to include("vat_id_valid" => true, "tax_cents" => 0)
        expect(a_request(:post, iras_url).with(body: { clientID: IRAS_API_ID, regID: "M90000001A" }.to_json)).to have_been_made.once
      end

      it "taxes a Singapore buyer whose GST id IRAS does not list as registered", parity: true do
        create_sg_rate
        stub_iras(status: "De-Registered")

        post_surcharge(products: [line(product, price: 1_000)], country: "SG", vat_id: "M90000002B")

        expect(response.parsed_body).to include("vat_id_valid" => false, "tax_cents" => 90)
      end

      it "asks IRAS once for a GST id repeated across the lines of a cart", parity: true do
        create_sg_rate
        stub_iras

        post_surcharge(products: [line(product, price: 1_000), line(other_product, price: 500)], country: "SG", vat_id: "M90000003C")

        expect(response.parsed_body).to include("vat_id_valid" => true)
        expect(a_request(:post, iras_url)).to have_been_made.once
      end

      it "treats a dropped connection to IRAS as not registered", parity: true do
        create_sg_rate
        stub_dropped_connection(:post, iras_url)

        post_surcharge(products: [line(product, price: 1_000)], country: "SG", vat_id: "M90000004D")

        expect(response.parsed_body).to include("vat_id_valid" => false, "tax_cents" => 90)
      end

      it "treats an IRAS answer with another return code as not registered", parity: true do
        create_sg_rate
        stub_iras(return_code: "20")

        post_surcharge(products: [line(product, price: 1_000)], country: "SG", vat_id: "M90000005E")

        expect(response.parsed_body).to include("vat_id_valid" => false, "tax_cents" => 90)
      end

      it "zeroes the tax of a Quebec buyer whose QST id Revenu Quebec lists as registered", parity: true do
        stub_request(:get, "#{qst_url}1000000001TQ0001").to_return(status: 200, body: { Resultat: { StatutSousDossierUsager: "R" } }.to_json, headers: json_type)

        post_surcharge(products: [line(product, price: 2_000)], country: "CA", state: "QC", postal_code: "H2Y 1C6", vat_id: "1000000001TQ0001")

        expect(response.parsed_body).to include("vat_id_valid" => true, "tax_cents" => 0)
      end

      it "taxes a Quebec buyer whose QST id Revenu Quebec does not know", parity: true do
        stub_request(:get, "#{qst_url}1000000002TQ0001").to_return(status: 404, body: "{}", headers: json_type)
        stub_taxjar(taxjar_response(amount_to_collect: 2.99, rate: 0.14975, state: "QC", breakdown: { gst_tax_rate: 0.05, qst_tax_rate: 0.09975 }))

        post_surcharge(products: [line(product, price: 2_000)], country: "CA", state: "QC", postal_code: "H2Y 1C6", vat_id: "1000000002TQ0001")

        expect(response.parsed_body).to include("vat_id_valid" => false, "tax_cents" => 299)
      end

      it "percent-encodes a QST id with reserved characters", parity: true do
        stub_request(:get, %r{\A#{Regexp.escape(qst_url)}}).to_return(status: 200, body: { Resultat: { StatutSousDossierUsager: "A" } }.to_json, headers: json_type)
        stub_taxjar(taxjar_response(amount_to_collect: 2.99, rate: 0.14975, state: "QC", breakdown: { gst_tax_rate: 0.05, qst_tax_rate: 0.09975 }))

        post_surcharge(products: [line(product, price: 2_000)], country: "CA", state: "QC", postal_code: "H2Y 1C6", vat_id: "10 00/00?0003#1é")

        expect(response.parsed_body).to include("vat_id_valid" => false, "tax_cents" => 299)
      end

      it "zeroes the tax of a South African buyer whose tax id taxid.pro validates", parity: true do
        stub_request(:get, "#{taxid_url}?country=ZA&tin=4000000001").to_return(status: 200, body: { is_valid: true }.to_json, headers: json_type)

        post_surcharge(products: [line(product, price: 1_000)], country: "ZA", vat_id: "4000000001")

        expect(response.parsed_body).to include("vat_id_valid" => true, "tax_cents" => 0)
        expect(a_request(:get, "#{taxid_url}?country=ZA&tin=4000000001").with(headers: { "Authorization" => "Bearer #{TAX_ID_PRO_API_KEY}" })).to have_been_made.once
      end

      it "does not validate a South African tax id taxid.pro rejects, and asks once for two lines", parity: true do
        stub_request(:get, "#{taxid_url}?country=ZA&tin=4000000002").to_return(status: 200, body: { is_valid: false }.to_json, headers: json_type)

        post_surcharge(products: [line(product, price: 1_000), line(other_product, price: 500)], country: "ZA", vat_id: "4000000002")

        expect(response.parsed_body).to include("vat_id_valid" => false)
        expect(a_request(:get, "#{taxid_url}?country=ZA&tin=4000000002")).to have_been_made.once
      end

      it "answers a taxid.pro 401 as an invalid id", parity: true do
        stub_request(:get, "#{taxid_url}?country=ZA&tin=4000000003").to_return(status: 401, body: { is_valid: true }.to_json, headers: json_type)

        post_surcharge(products: [line(product, price: 1_000)], country: "ZA", vat_id: "4000000003")

        expect(response.parsed_body).to include("vat_id_valid" => false)
      end

      it "does not ask a vendor about a free line", parity: true do
        create_sg_rate
        stub_iras

        post_surcharge(products: [line(product, price: 0)], country: "SG", vat_id: "M90000006F")

        expect(response.parsed_body).to include("vat_id_valid" => false)
        expect(a_request(:post, iras_url)).not_to have_been_made
      end

      it "hands an Australian ABN, which Vatstack checks, back to Rails", parity: true do
        stub_request(:post, "https://api.vatstack.com/v1/validations").to_return(status: 200, body: { valid: true, active: true }.to_json, headers: json_type)

        post_surcharge(products: [line(product, price: 1_000)], country: "AU", vat_id: "51824753556")

        expect(response.parsed_body).to include("vat_id_valid" => true, "tax_cents" => 0)
      end
    end
  end

  describe "a bundle bound for the EU" do
    let(:bundle) { create(:product, :bundle, user: seller, unique_permalink: "surchargebundle") }

    before { create_de_vat_rate }

    def make_components(bundle, *physical_flags)
      bundle.bundle_products.each(&:mark_deleted!)
      physical_flags.each_with_index do |physical, index|
        component = create(physical ? :physical_product : :product, user: seller, unique_permalink: "surchargecomp#{%w[a b c][index]}")
        create(:bundle_product, bundle:, product: component)
      end
    end

    it "drops VAT when every live component is physical", parity: true do
      make_components(bundle, true, true)

      post_surcharge(products: [line(bundle, price: 1_000)], country: "DE", postal_code: "10115")

      expect(response.parsed_body).to include("subtotal" => 1_000, "tax_cents" => 0)
    end

    it "keeps collecting VAT on a bundle that mixes physical and digital components", parity: true do
      make_components(bundle, true, false)

      post_surcharge(products: [line(bundle, price: 1_000)], country: "DE", postal_code: "10115")

      expect(response.parsed_body).to include("subtotal" => 1_000, "tax_cents" => 190)
    end

    it "decides by the components when the bundle row itself is flagged physical", parity: true do
      make_components(bundle, false)
      bundle.update_attribute(:is_physical, true)

      post_surcharge(products: [line(bundle, price: 1_000)], country: "DE", postal_code: "10115")

      expect(response.parsed_body).to include("tax_cents" => 190)
    end
  end

  describe "preorder, membership and installment lines" do
    before { create_de_vat_rate }

    it "totals a preorder in full but charges nothing now", parity: true do
      create(:preorder_link, link: product)
      product.is_in_preorder_state = true
      product.save!(validate: false)

      post_surcharge(products: [line(product, price: 1_000)], postal_code: "10115", country: "DE")

      expect(response.parsed_body).to include("subtotal" => 1_000, "tax_cents" => 190, "charge_canonical_total_cents" => 0, "commission_completion_canonical_total_cents" => 0)
    end

    it "charges a membership like a one-time line", parity: true do
      membership = create(:membership_product, user: seller, unique_permalink: "surchargemember")

      post_surcharge(products: [line(membership, price: 1_000)], postal_code: "10115", country: "DE")

      expect(response.parsed_body).to include("subtotal" => 1_000, "tax_cents" => 190, "charge_canonical_total_cents" => 1_190)
    end

    it "charges the first installment, taxed on its own", parity: true do
      installment_product = create(:product, :with_installment_plan, user: seller, unique_permalink: "surchargeinstall")

      post_surcharge(products: [line(installment_product, price: 1_000, pay_in_installments: true)], postal_code: "10115", country: "DE")

      expect(response.parsed_body).to include("subtotal" => 1_000, "tax_cents" => 190, "charge_canonical_total_cents" => 397)
    end

    it "charges the whole tip with the first installment", parity: true do
      installment_product = create(:product, :with_installment_plan, user: seller, unique_permalink: "surchargeinstall")

      post_surcharge(products: [line(installment_product, price: 1_000, pay_in_installments: true, tip_cents: "100")], postal_code: "10115", country: "DE")

      expect(response.parsed_body).to include("charge_canonical_total_cents" => 476)
    end
  end
end
