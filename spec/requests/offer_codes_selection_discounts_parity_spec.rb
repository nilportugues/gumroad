# frozen_string_literal: true

require "spec_helper"

# GET /offer_codes/selection_discounts, written for recording (PARITY_RECORD=1) and replay by the Next.js port
# (nextjs/src/server/controllers/offer-codes-selection.ts, nextjs/parity/__tests__/offer-codes-selection-discounts.replay.test.ts).
# An example named "hands a ..." is one Node leaves to Rails whole.
describe "Offer codes selection_discounts", type: :request do
  include Parity::SignedInRequests

  let(:seller) { create(:user, name: "Selection Seller") }
  let(:product) { create(:product, user: seller, price_cents: 1000, unique_permalink: "quoted") }

  before { host! DOMAIN }

  def quote(**params)
    get "/offer_codes/selection_discounts", params: { permalink: product.unique_permalink, **params }
    response.parsed_body
  end

  describe "the product" do
    it "answers 404 for a permalink no product has", parity: true do
      get "/offer_codes/selection_discounts", params: { permalink: "nosuchone", code: "off" }

      expect(response).to have_http_status(:not_found)
    end

    it "answers 404 to a JSON request for a deleted product", parity: true do
      product.mark_deleted!

      get "/offer_codes/selection_discounts", params: { permalink: product.unique_permalink }, headers: { "Accept" => "application/json" }

      expect(response).to have_http_status(:not_found)
    end

    it "answers 404 when the permalink is missing", parity: true do
      get "/offer_codes/selection_discounts"

      expect(response).to have_http_status(:not_found)
    end

    it "answers 404 when the permalink is a list", parity: true do
      get "/offer_codes/selection_discounts?permalink[]=#{product.unique_permalink}"

      expect(response).to have_http_status(:not_found)
    end
  end

  describe "a product with no code to quote" do
    it "answers the inputs with no options", parity: true do
      expect(quote["options"]).to eq({})
    end

    it "echoes the quantity, recurrence, option and price it was given", parity: true do
      body = quote(quantity: "3", recurrence: "yearly", option_id: "abc", price_cents: "250")

      expect(body).to include("quantity" => 3, "recurrence" => "yearly", "option_id" => "abc", "price_cents" => 250)
    end

    it "reads a quantity of zero as one", parity: true do
      expect(quote(quantity: "0")["quantity"]).to eq(1)
    end

    it "reads a quantity that is not a plain integer as one", parity: true do
      expect(quote(quantity: "2.5", price_cents: "-3")).to include("quantity" => 1, "price_cents" => nil)
    end

    it "reads a recurrence the product page does not offer as none", parity: true do
      expect(quote(recurrence: "weekly")["recurrence"]).to be_nil
    end

    it "reads a repeated code as absent", parity: true do
      create(:offer_code, user: seller, products: [product], code: "off")

      get "/offer_codes/selection_discounts?permalink=#{product.unique_permalink}&code[]=off"

      expect(response.parsed_body).to include("url_code" => nil, "options" => {})
    end

    it "answers a signed-in buyer the same", parity: true do
      log_in(create(:user), token_path: "/login")

      expect(quote["options"]).to eq({})
    end
  end

  describe "a code in the URL" do
    it "quotes it on a product with no options", parity: true do
      create(:offer_code, user: seller, products: [product], code: "off", amount_cents: 100)

      expect(quote(code: "off").dig("options", "", "discount_code")).to include("valid" => true, "code" => "off")
    end

    it "quotes a code typed in capitals as the buyer typed it", parity: true do
      create(:offer_code, user: seller, products: [product], code: "off", amount_cents: 100)

      expect(quote(code: " OFF ").dig("options", "", "discount_code", "code")).to eq(" OFF ")
    end

    it "quotes a percentage code", parity: true do
      create(:percentage_offer_code, user: seller, products: [product], code: "half")

      expect(quote(code: "half").dig("options", "", "discount_code", "discount", "percents")).to eq(50)
    end

    it "answers invalid_offer for a code the seller does not have", parity: true do
      expect(quote(code: "nope").dig("options", "", "discount_code")).to eq("valid" => false, "error_code" => "invalid_offer")
    end

    it "answers inactive for an expired code", parity: true do
      create(:offer_code, user: seller, products: [product], code: "old", valid_at: 2.days.ago, expires_at: 1.day.ago)

      expect(quote(code: "old").dig("options", "", "discount_code", "error_code")).to eq("inactive")
    end

    it "answers sold_out for a code with no uses left", parity: true do
      create(:offer_code, user: seller, products: [product], code: "gone", max_purchase_count: 0)

      expect(quote(code: "gone").dig("options", "", "discount_code", "error_code")).to eq("sold_out")
    end

    it "lifts the quantity to the code's minimum", parity: true do
      create(:offer_code, user: seller, products: [product], code: "bulk", minimum_quantity: 3)

      expect(quote(code: "bulk", quantity: "1").dig("options", "", "discount_code", "valid")).to be true
    end

    it "answers insufficient_times_of_use when the quantity exceeds what is left", parity: true do
      create(:offer_code, user: seller, products: [product], code: "few", max_purchase_count: 2)

      expect(quote(code: "few", quantity: "5").dig("options", "", "discount_code", "error_code")).to eq("insufficient_times_of_use")
    end

    it "quotes a universal code of the seller", parity: true do
      create(:universal_offer_code, user: seller, code: "all", amount_cents: 100)

      expect(quote(code: "all").dig("options", "", "discount_code", "valid")).to be true
    end

    it "answers invalid_offer for a universal code that excludes the product", parity: true do
      create(:universal_offer_code, user: seller, code: "all", amount_cents: 100, excluded_products: [product])

      expect(quote(code: "all").dig("options", "", "discount_code", "error_code")).to eq("invalid_offer")
    end

    it "quotes a once-per-cart fixed code", parity: true do
      create(:universal_offer_code, user: seller, code: "cart", amount_cents: 300, once_per_cart: true)

      expect(quote(code: "cart").dig("options", "", "discount_code", "discount")).to include("once_per_cart" => true, "cents" => 300)
    end
  end

  describe "a product with versions" do
    let(:product) { create(:product_with_digital_versions, user: seller, price_cents: 1000, unique_permalink: "quoted") }
    let(:option_ids) { product.options.map { _1[:id] } }

    it "quotes the code for each version", parity: true do
      create(:offer_code, user: seller, products: [product], code: "off", amount_cents: 100)

      expect(quote(code: "off")["options"].keys).to eq(option_ids)
    end

    it "answers option_not_eligible for the versions a code does not cover", parity: true do
      covered = product.alive_variants.first
      create(:offer_code, user: seller, products: [product], code: "some", amount_cents: 100, variants: [covered])

      options = quote(code: "some")["options"]

      expect(options.transform_values { _1.dig("discount_code", "error_code") }).to eq(
        option_ids.index_with { _1 == covered.external_id ? nil : "option_not_eligible" }
      )
    end

    it "quotes the seller's auto-applied sale on every version with its label", parity: true do
      create(:universal_offer_code, user: seller, code: "sale", amount_cents: nil, amount_percentage: 20, auto_apply: true, sale_label: "Spring sale")

      options = quote["options"]

      expect(options.values.map { _1["sale_label"] }).to eq(["Spring sale", "Spring sale"])
    end

    it "answers invalid_offer on every version for a code the seller does not have", parity: true do
      expect(quote(code: "nope")["options"].values.map { _1.dig("discount_code", "error_code") }).to eq(%w[invalid_offer invalid_offer])
    end
  end

  describe "a product with an auto-applied sale" do
    before do
      create(:universal_offer_code, user: seller, code: "sale", amount_cents: nil, amount_percentage: 20, auto_apply: true, sale_label: "Spring sale")
    end

    it "quotes the sale with its label when the URL has no code", parity: true do
      expect(quote.dig("options", "")).to include("sale_label" => "Spring sale", "discount_code" => include("valid" => true, "code" => "sale"))
    end

    it "quotes the sale when the URL code is sold out", parity: true do
      create(:offer_code, user: seller, products: [product], code: "off", amount_cents: 100, max_purchase_count: 0)

      expect(quote(code: "off").dig("options", "", "discount_code", "code")).to eq("sale")
    end

    it "quotes the sale for a URL code that is invalid", parity: true do
      expect(quote(code: "nope").dig("options", "", "discount_code", "code")).to eq("sale")
    end

    it "quotes the rental options of a buy-and-rent product like its options", parity: true do
      product.update!(purchase_type: :buy_and_rent, rental_price_cents: 300)

      body = quote

      expect(body["rent_options"]).to eq(body["options"])
    end

    it "hands a URL code that is valid beside a valid sale to Rails, which weighs the two", parity: true do
      create(:offer_code, user: seller, products: [product], code: "off", amount_cents: 100)

      expect(quote(code: "off").dig("options", "", "discount_code")).to include("valid" => true)
    end
  end

  describe "a rental" do
    it "quotes the options of a rent-only product and no rental options", parity: true do
      product.update!(purchase_type: :rent_only, rental_price_cents: 300)
      create(:offer_code, user: seller, products: [product], code: "off", amount_cents: 100)

      expect(quote(code: "off")).to include("rent_options" => nil)
    end
  end

  describe "a membership" do
    let(:product) { create(:membership_product_with_preset_tiered_pricing, user: seller, unique_permalink: "quoted") }

    it "quotes the code for each tier", parity: true do
      create(:offer_code, user: seller, products: [product], code: "off", amount_cents: 100)

      expect(quote(code: "off", recurrence: "monthly")["options"].keys).to eq(product.options.map { _1[:id] })
    end
  end

  describe "a signed-in buyer" do
    let(:buyer) { create(:user) }

    before { log_in(buyer, token_path: "/login") }

    it "quotes an existing-customers code to a buyer who owns the product", parity: true do
      code = create(:offer_code, user: seller, products: [product], code: "loyal", existing_customers_only: true, ownership_products: [product], amount_cents: 100)
      build(:purchase, link: product, seller:, purchaser: buyer, email: buyer.email, purchase_state: "successful").save!(validate: false)

      expect(quote(code: code.code).dig("options", "", "discount_code")).to include("valid" => true)
    end

    it "answers not_existing_customer to a buyer who owns nothing", parity: true do
      create(:offer_code, user: seller, products: [product], code: "loyal", existing_customers_only: true, ownership_products: [product])

      expect(quote(code: "loyal").dig("options", "", "discount_code", "error_code")).to eq("not_existing_customer")
    end

    it "answers not_new_customer to a buyer who bought from the seller before", parity: true do
      create(:offer_code, :for_new_customers, user: seller, products: [product], code: "fresh", amount_cents: 100)
      build(:purchase, link: create(:product, user: seller), seller:, purchaser: buyer, email: buyer.email, purchase_state: "successful").save!(validate: false)

      expect(quote(code: "fresh").dig("options", "", "discount_code", "error_code")).to eq("not_new_customer")
    end

    it "quotes the tier a tiered code reaches for the buyer's ownership", parity: true do
      create(:tiered_offer_code, user: seller, products: [product], code: "tiers", ownership_duration_tiers: [
               { "months" => 0, "amount_percentage" => 10 },
               { "months" => 12, "amount_percentage" => 50 },
             ])
      build(:purchase, link: product, seller:, purchaser: buyer, email: buyer.email, purchase_state: "successful", created_at: 14.months.ago).save!(validate: false)

      expect(quote(code: "tiers").dig("options", "", "discount_code", "discount", "percents")).to eq(50)
    end
  end

  describe "what Node leaves to Rails" do
    it "hands a product with an explicit default offer code to Rails", parity: true do
      code = create(:offer_code, user: seller, products: [product], code: "pinned", amount_cents: 100)
      product.update!(default_offer_code: code)

      expect(quote.dig("options", "", "discount_code")).to include("valid" => true)
    end

    it "hands a quantity too large for a JS number to Rails", parity: true do
      expect(quote(quantity: "123456789012345678901234567890")["quantity"]).to eq(123456789012345678901234567890)
    end
  end
end
