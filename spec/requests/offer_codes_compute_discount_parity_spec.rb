# frozen_string_literal: true

require "spec_helper"

# GET /offer_codes/compute_discount, written for recording (PARITY_RECORD=1) and replay by the Next.js port
# (nextjs/src/server/controllers/offer-codes.ts). Not yet recorded: no fixture exists under nextjs/parity/fixtures.
describe "Offer codes compute_discount", type: :request do
  include Parity::SignedInRequests

  let(:seller) { create(:user) }
  let(:product) { create(:product, user: seller, price_cents: 500) }

  before { host! DOMAIN }

  def cart(*products, quantity: 1)
    products.each_with_index.to_h { |p, i| [i.to_s, { permalink: p.unique_permalink, quantity: }] }
  end

  it "returns the discount of a code on the carted product", parity: true do
    code = create(:offer_code, user: seller, products: [product], amount_cents: 100)

    get "/offer_codes/compute_discount", params: { code: code.code, products: cart(product) }

    expect(response.parsed_body["valid"]).to be true
  end

  it "applies a code pasted with leading whitespace", parity: true do
    code = create(:offer_code, user: seller, products: [product])

    get "/offer_codes/compute_discount", params: { code: " #{code.code.upcase}", products: cart(product) }

    expect(response.parsed_body["products_data"]).to have_key(product.unique_permalink)
  end

  it "rejects an unknown code as invalid_offer", parity: true do
    get "/offer_codes/compute_discount", params: { code: "nope", products: cart(product) }

    expect(response.parsed_body["error_code"]).to eq("invalid_offer")
  end

  it "rejects an inactive code", parity: true do
    code = create(:offer_code, user: seller, products: [product], valid_at: 2.days.ago, expires_at: 1.day.ago)

    get "/offer_codes/compute_discount", params: { code: code.code, products: cart(product) }

    expect(response.parsed_body["error_code"]).to eq("inactive")
  end

  it "reports sold_out when the code has no uses left", parity: true do
    code = create(:offer_code, user: seller, products: [product], max_purchase_count: 0)

    get "/offer_codes/compute_discount", params: { code: code.code, products: cart(product) }

    expect(response.parsed_body["error_code"]).to eq("sold_out")
  end

  it "reports an unmet minimum quantity", parity: true do
    code = create(:offer_code, user: seller, products: [product], minimum_quantity: 3)

    get "/offer_codes/compute_discount", params: { code: code.code, products: cart(product, quantity: 2) }

    expect(response.parsed_body["error_code"]).to eq("unmet_minimum_purchase_quantity")
  end

  it "discounts the lines that fit a capped universal code and explains the rest", parity: true do
    capped = create(:universal_offer_code, user: seller, amount_cents: 100, max_purchase_count: 2)
    lines = create_list(:product, 3, user: seller, price_cents: 500)

    get "/offer_codes/compute_discount", params: { code: capped.code, products: cart(*lines) }

    expect(response.parsed_body["products_data"].size).to eq(2)
    expect(response.parsed_body["notice"]).to eq("The discount code was applied to some products. The rest exceed its remaining usage limit.")
  end

  it "reads a missing products param as an invalid code", parity: true do
    code = create(:offer_code, user: seller, products: [product])

    get "/offer_codes/compute_discount", params: { code: code.code }

    expect(response.parsed_body["error_code"]).to eq("invalid_offer")
  end

  describe "a code limited to options" do
    let(:category) { create(:variant_category, link: product) }
    let!(:covered) { create(:variant, variant_category: category, name: "Covered") }
    let!(:other) { create(:variant, variant_category: category, name: "Other") }
    let!(:code) { create(:offer_code, user: seller, products: [product], variants: [covered], amount_cents: 100) }

    def option_cart(*options)
      options.each_with_index.to_h { |(option, quantity), i| [i.to_s, { permalink: product.unique_permalink, quantity: quantity || 1, variant_external_id: option.external_id }] }
    end

    it "discounts a line that picks a covered option and lists the options in the discount", parity: true do
      get "/offer_codes/compute_discount", params: { code: code.code, products: option_cart([covered]) }

      expect(response.parsed_body.dig("products_data", product.unique_permalink, "option_ids_by_product")).to be_present
    end

    it "reports option_not_eligible when the only line picks another option", parity: true do
      get "/offer_codes/compute_discount", params: { code: code.code, products: option_cart([other]) }

      expect(response.parsed_body["error_code"]).to eq("option_not_eligible")
    end

    it "discounts the covered lines of a mixed cart and explains the rest", parity: true do
      get "/offer_codes/compute_discount", params: { code: code.code, products: option_cart([covered], [other, 2]) }

      expect(response.parsed_body["notice"]).to eq("The code applies to some items. The selected options for the other items are not eligible.")
    end
  end
end
