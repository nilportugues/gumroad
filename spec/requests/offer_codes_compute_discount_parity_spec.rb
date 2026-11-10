# frozen_string_literal: true

require "spec_helper"

# GET /offer_codes/compute_discount, written for recording (PARITY_RECORD=1) and replay by the Next.js port
# (nextjs/src/server/controllers/offer-codes.ts). Fixtures live under nextjs/parity/fixtures/requests.
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

  describe "a visitor who is not signed in has no purchase history" do
    it "reports not_existing_customer for an existing-customers code", parity: true do
      code = create(:offer_code, user: seller, products: [product], existing_customers_only: true, ownership_products: [product])

      get "/offer_codes/compute_discount", params: { code: code.code, products: cart(product) }

      expect(response.parsed_body["error_code"]).to eq("not_existing_customer")
    end

    it "ranks not_existing_customer above an unmet minimum quantity", parity: true do
      code = create(:offer_code, user: seller, products: [product], existing_customers_only: true, ownership_products: [product], minimum_quantity: 3)

      get "/offer_codes/compute_discount", params: { code: code.code, products: cart(product) }

      expect(response.parsed_body["error_code"]).to eq("not_existing_customer")
    end

    it "gives a tiered code its month-0 tier instead of the configured amount", parity: true do
      code = create(:tiered_offer_code, user: seller, products: [product], ownership_duration_tiers: [
                      { "months" => 0, "amount_percentage" => 10 },
                      { "months" => 12, "amount_percentage" => 50 },
                    ])

      get "/offer_codes/compute_discount", params: { code: code.code, products: cart(product) }

      expect(response.parsed_body.dig("products_data", product.unique_permalink, "percents")).to eq(10)
    end
  end

  describe "a fixed code applied once per cart" do
    let(:lines) { create_list(:product, 2, user: seller, price_cents: 500) }

    def cents_by_line(code, params_products)
      get "/offer_codes/compute_discount", params: { code: code.code, products: params_products }
      response.parsed_body["products_data"].transform_values { _1["cents"] }
    end

    it "discounts one line and lists the cart-wide amount in the discount", parity: true do
      code = create(:universal_offer_code, user: seller, amount_cents: 300, once_per_cart: true)

      get "/offer_codes/compute_discount", params: { code: code.code, products: cart(product) }

      expect(response.parsed_body.dig("products_data", product.unique_permalink)).to include("cents" => 300, "once_per_cart" => true, "once_per_cart_amount_cents" => 300)
    end

    it "carries the amount a line cannot absorb to the next one", parity: true do
      code = create(:universal_offer_code, user: seller, amount_cents: 700, once_per_cart: true)

      expect(cents_by_line(code, cart(*lines))).to eq(lines[0].unique_permalink => 500, lines[1].unique_permalink => 200)
    end

    it "leaves the currency minimum on the line", parity: true do
      code = create(:universal_offer_code, user: seller, amount_cents: 450, once_per_cart: true)

      expect(cents_by_line(code, cart(product))).to eq(product.unique_permalink => 401)
    end

    it "allocates against the submitted price less the tip", parity: true do
      code = create(:universal_offer_code, user: seller, amount_cents: 1000, once_per_cart: true)
      products = { "0" => { permalink: product.unique_permalink, quantity: 1, price_cents: "900", tip_cents: "100" } }

      expect(cents_by_line(code, products)).to eq(product.unique_permalink => 800)
    end

    it "covers every line of a code with one use left without spending another", parity: true do
      code = create(:universal_offer_code, user: seller, amount_cents: 300, once_per_cart: true, max_purchase_count: 1)

      get "/offer_codes/compute_discount", params: { code: code.code, products: cart(*lines, quantity: 3) }

      expect(response.parsed_body["products_data"].transform_values { _1["cents"] }).to eq(lines[0].unique_permalink => 300, lines[1].unique_permalink => 0)
      expect(response.parsed_body).not_to have_key("notice")
    end

    it "reports sold_out when the code has no uses left", parity: true do
      code = create(:universal_offer_code, user: seller, amount_cents: 300, once_per_cart: true, max_purchase_count: 0)

      get "/offer_codes/compute_discount", params: { code: code.code, products: cart(product) }

      expect(response.parsed_body["error_code"]).to eq("sold_out")
    end
  end

  describe "a signed-in buyer is measured against their purchase history" do
    let(:buyer) { create(:user) }

    def purchased(product, **attributes)
      build(:purchase, link: product, seller: product.user, purchaser: buyer, email: buyer.email, purchase_state: "successful", **attributes).save!(validate: false)
    end

    before { log_in(buyer, token_path: "/login") }

    it "gives an existing-customers code to a buyer who owns the product", parity: true do
      code = create(:offer_code, user: seller, products: [product], existing_customers_only: true, ownership_products: [product], amount_cents: 100)
      purchased(product)

      get "/offer_codes/compute_discount", params: { code: code.code, products: cart(product) }

      expect(response.parsed_body.dig("products_data", product.unique_permalink, "cents")).to eq(100)
    end

    it "reports not_existing_customer for a buyer who owns nothing", parity: true do
      code = create(:offer_code, user: seller, products: [product], existing_customers_only: true, ownership_products: [product])

      get "/offer_codes/compute_discount", params: { code: code.code, products: cart(product) }

      expect(response.parsed_body["error_code"]).to eq("not_existing_customer")
    end

    it "recognizes a guest purchase made with the buyer's confirmed email", parity: true do
      code = create(:offer_code, user: seller, products: [product], existing_customers_only: true, ownership_products: [product])
      purchased(product, purchaser: nil)

      get "/offer_codes/compute_discount", params: { code: code.code, products: cart(product) }

      expect(response.parsed_body["valid"]).to be true
    end

    it "gives a tiered code the tier the buyer's ownership has reached", parity: true do
      code = create(:tiered_offer_code, user: seller, products: [product], ownership_duration_tiers: [
                      { "months" => 0, "amount_percentage" => 10 },
                      { "months" => 12, "amount_percentage" => 50 },
                    ])
      purchased(product, created_at: 14.months.ago)

      get "/offer_codes/compute_discount", params: { code: code.code, products: cart(product) }

      expect(response.parsed_body.dig("products_data", product.unique_permalink, "percents")).to eq(50)
    end

    it "gives a new-customers code to a buyer with no earlier purchase from the seller", parity: true do
      code = create(:offer_code, :for_new_customers, user: seller, products: [product], amount_cents: 100)

      get "/offer_codes/compute_discount", params: { code: code.code, products: cart(product) }

      expect(response.parsed_body["valid"]).to be true
    end

    it "reports not_new_customer for a buyer who bought from the seller before", parity: true do
      code = create(:offer_code, :for_new_customers, user: seller, products: [product], amount_cents: 100)
      purchased(create(:product, user: seller, price_cents: 500))

      get "/offer_codes/compute_discount", params: { code: code.code, products: cart(product) }

      expect(response.parsed_body["error_code"]).to eq("not_new_customer")
    end
  end

  it "reads an array code as an unknown code", parity: true do
    create(:offer_code, user: seller, products: [product])

    get "/offer_codes/compute_discount", params: { code: ["off"], products: cart(product) }

    expect(response.parsed_body["error_code"]).to eq("invalid_offer")
  end

  it "reads a hash code as an unknown code", parity: true do
    create(:offer_code, user: seller, products: [product])

    get "/offer_codes/compute_discount", params: { code: { name: "off" }, products: cart(product) }

    expect(response.parsed_body["error_code"]).to eq("invalid_offer")
  end

  describe "a seller with cross-sells" do
    let(:offered) { create(:product, user: seller, price_cents: 300) }
    let(:code) { create(:universal_offer_code, user: seller, amount_cents: 100) }

    def compute(code, *lines)
      get "/offer_codes/compute_discount", params: { code: code.code, products: cart(*lines) }
      response.parsed_body
    end

    it "discounts the product a cross-sell offers alongside the carted one", parity: true do
      create(:upsell, seller:, product: offered, cross_sell: true, selected_products: [product])

      expect(compute(code, product)["products_data"].keys).to contain_exactly(product.unique_permalink, offered.unique_permalink)
    end

    it "discounts the product of a universal cross-sell", parity: true do
      create(:upsell, seller:, product: offered, cross_sell: true, universal: true)

      expect(compute(code, product)["products_data"]).to have_key(offered.unique_permalink)
    end

    it "ignores a cross-sell that is paused or lists another product", parity: true do
      other = create(:product, user: seller)
      create(:upsell, seller:, product: offered, cross_sell: true, selected_products: [product], paused: true)
      create(:upsell, seller:, product: create(:product, user: seller), cross_sell: true, selected_products: [other])

      expect(compute(code, product)["products_data"].keys).to eq([product.unique_permalink])
    end

    it "leaves out an offered product the code does not cover", parity: true do
      create(:upsell, seller:, product: offered, cross_sell: true, selected_products: [product])
      limited = create(:offer_code, user: seller, products: [product], amount_cents: 100)

      expect(compute(limited, product)["products_data"].keys).to eq([product.unique_permalink])
    end

    it "keeps the discount of a cross-sell that is itself a cart line", parity: true do
      create(:upsell, seller:, product: offered, cross_sell: true, selected_products: [product])
      capped = create(:universal_offer_code, user: seller, amount_cents: 100, max_purchase_count: 1)

      expect(compute(capped, product, offered)["products_data"].keys).to contain_exactly(product.unique_permalink, offered.unique_permalink)
    end

    it "covers the offered product at zero once a once-per-cart code is spent", parity: true do
      create(:upsell, seller:, product: offered, cross_sell: true, selected_products: [product])
      once = create(:universal_offer_code, user: seller, amount_cents: 300, once_per_cart: true)

      expect(compute(once, product)["products_data"].transform_values { _1["cents"] }).to eq(product.unique_permalink => 300, offered.unique_permalink => 0)
    end

    it "gives no discount to the offered product when the cart line misses the code's minimum", parity: true do
      create(:upsell, seller:, product: offered, cross_sell: true, selected_products: [product])
      minimum = create(:universal_offer_code, user: seller, amount_cents: 100, minimum_quantity: 3)

      expect(compute(minimum, product)["error_code"]).to eq("unmet_minimum_purchase_quantity")
    end
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
