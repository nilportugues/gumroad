# frozen_string_literal: true

require "spec_helper"

# POST /customer_surcharge for the carts the Next.js port serves (nextjs/src/server/controllers/customer-surcharge.ts):
# one-time digital lines, a buyer taxed from the lookup table, and no seller in the buyer-currency rollout. Written for
# recording (PARITY_RECORD=1); not yet recorded, so no fixture exists under nextjs/parity/fixtures.
describe "Customer surcharge", type: :request do
  include Parity::AudienceSignedIn

  let(:seller) { create(:user) }
  let(:product) { create(:product, user: seller, unique_permalink: "surcharge") }
  let(:other_product) { create(:product, user: seller, unique_permalink: "surcharge2") }
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
end
