# frozen_string_literal: true

require "spec_helper"

# POST /customer_surcharge for the carts the Next.js port serves (nextjs/src/server/controllers/customer-surcharge.ts):
# one-time digital lines, a buyer taxed from the lookup table, and no seller in the buyer-currency rollout. Written for
# recording (PARITY_RECORD=1); not yet recorded, so no fixture exists under nextjs/parity/fixtures.
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

  it "answers a malformed products param with an empty 400", parity: true do
    post_surcharge(products: ["not-a-product"])

    expect(response).to have_http_status(:bad_request)
    expect(response.body).to eq("")
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

    it "drops VAT on a physical line bound for the EU", parity: true do
      create_de_vat_rate
      physical_product.shipping_destinations << create(:shipping_destination, country_code: "DE", one_item_rate_cents: 500, multiple_items_rate_cents: 0)

      post_surcharge(products: [line(physical_product, price: 1_000)], country: "DE", postal_code: "10115")

      expect(response.parsed_body).to include("tax_cents" => 0, "shipping_rate_cents" => 500)
    end
  end
end
