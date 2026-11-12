# frozen_string_literal: true

require "spec_helper"

# The writes of Api::V2::OfferCodesController through the full Rack stack, recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/api-v2-ws17c.replay.test.ts. Node answers the checks that run before the write (missing amount, unknown
# product or code, malformed validity period) and the writes of a plain code: no automatic application, no options, tiers, exclusions or
# customer limits on the code, products that are neither memberships nor have options. A write outside that is recorded as what Node hands
# back ("hands a ..."), and Node must hand it back before its first statement.
describe "API v2 offer code writes", type: :request do
  include Parity::ApiV2Requests

  let(:seller) { create(:user, name: "Offer Seller", email: "offer-seller@example.com") }
  let(:product) { create(:product, user: seller, name: "Discounted", unique_permalink: "discounted", price_cents: 1000) }
  let(:token) { api_token(seller) }
  let!(:offer_code) { create(:offer_code, user: seller, products: [product], code: "SAVE10", amount_cents: 100) }

  def create_code(params = {}, options = {})
    api_call(:post, "/products/#{options.fetch(:product_id) { product.external_id }}/offer_codes", params:, token: options.fetch(:token) { token }, **options.slice(:as, :api_host, :headers))
  end

  def change(verb, path, params = {}, options = {})
    api_call(verb, path, params:, token: options.fetch(:token) { token }, **options.slice(:as, :api_host, :headers))
  end

  describe "POST /products/:link_id/offer_codes" do
    it "refuses a request without an amount", parity: true do
      create_code({ name: "NEW" })

      expect(response.parsed_body).to include("success" => false)
      expect(response.parsed_body["message"]).to start_with("You are missing required offer code parameters")
    end

    it "refuses a blank amount_off", parity: true do
      create_code({ name: "NEW", amount_off: "  " })

      expect(response.parsed_body["message"]).to start_with("You are missing required offer code parameters")
    end

    it "refuses a missing amount before it looks for the product", parity: true do
      create_code({ name: "NEW" }, product_id: "unknown")

      expect(response.parsed_body["message"]).to start_with("You are missing required offer code parameters")
    end

    it "refuses a missing amount through the /api prefix on the Gumroad domain", parity: true do
      create_code({ name: "NEW" }, api_host: false)

      expect(response.parsed_body["message"]).to start_with("You are missing required offer code parameters")
    end

    it "does not find an unknown product", parity: true do
      create_code({ name: "NEW", amount_off: "50" }, product_id: "unknown")

      expect(response.parsed_body).to eq("success" => false, "message" => "The product was not found.")
    end

    it "does not find the product of another seller", parity: true do
      other = create(:product, user: create(:user, email: "other-offer-seller@example.com"))

      create_code({ name: "NEW", amount_off: "50" }, product_id: other.external_id)

      expect(response.parsed_body).to eq("success" => false, "message" => "The product was not found.")
    end

    it "refuses a request without a token", parity: true do
      create_code({ name: "NEW", amount_off: "50" }, token: nil)

      expect(response).to have_http_status(:unauthorized)
    end

    it "refuses a token that lacks the edit_products scope", parity: true do
      create_code({ name: "NEW", amount_off: "50" }, token: api_token(seller, scopes: "view_sales"))

      expect(response).to have_http_status(:forbidden)
    end

    it "refuses a valid_at that is not a timestamp", parity: true do
      create_code({ name: "NEW", amount_off: "50", valid_at: "tomorrow" })

      expect(response.parsed_body).to eq("success" => false, "message" => "valid_at must be an RFC 3339 timestamp with a time zone, or null.")
    end

    it "refuses a timestamp without a time zone", parity: true do
      create_code({ name: "NEW", amount_off: "50", expires_at: "2099-01-01T10:00:00" })

      expect(response.parsed_body["message"]).to eq("expires_at must be an RFC 3339 timestamp with a time zone, or null.")
    end

    it "refuses a timestamp on a day the month does not have", parity: true do
      create_code({ name: "NEW", amount_off: "50", valid_at: "2099-02-30T10:00:00Z" })

      expect(response.parsed_body["message"]).to eq("valid_at must be an RFC 3339 timestamp with a time zone, or null.")
    end

    it "refuses a timestamp at hour 24", parity: true do
      create_code({ name: "NEW", amount_off: "50", valid_at: "2099-01-01T24:00:00Z" })

      expect(response.parsed_body["message"]).to eq("valid_at must be an RFC 3339 timestamp with a time zone, or null.")
    end

    it "refuses a leap second", parity: true do
      create_code({ name: "NEW", amount_off: "50", expires_at: "2099-01-01T10:00:60Z" })

      expect(response.parsed_body["message"]).to eq("expires_at must be an RFC 3339 timestamp with a time zone, or null.")
    end

    it "refuses a JSON number as a validity period", parity: true do
      create_code({ name: "NEW", amount_off: "50", valid_at: 5 }, as: :json)

      expect(response.parsed_body["message"]).to eq("valid_at must be an RFC 3339 timestamp with a time zone, or null.")
    end

    it "names the first of two bad validity periods", parity: true do
      create_code({ name: "NEW", amount_off: "50", valid_at: "2099-13-01T10:00:00Z", expires_at: "later" })

      expect(response.parsed_body["message"]).to eq("valid_at must be an RFC 3339 timestamp with a time zone, or null.")
    end

    it "creates a fixed amount code", parity: true do
      create_code({ name: "NEW", amount_off: "50" })

      expect(response.parsed_body).to include("success" => true)
      expect(product.offer_codes.pluck(:code)).to include("NEW")
    end

    it "creates a fixed amount code from amount_cents", parity: true do
      create_code({ name: "CENTS", amount_cents: "75" })

      expect(response.parsed_body["offer_code"]).to include("name" => "CENTS", "amount_cents" => 75)
    end

    it "creates a percent code", parity: true do
      create_code({ name: "HALF", offer_type: "percent", amount_off: "50" })

      expect(response.parsed_body["offer_code"]).to include("name" => "HALF", "percent_off" => 50)
    end

    it "creates a code with a validity period", parity: true do
      create_code({ name: "WINDOW", amount_off: "50", valid_at: "2099-01-01T10:00:00Z", expires_at: "2099-02-01T10:00:00+02:00" })

      expect(response.parsed_body["offer_code"]).to include("valid_at" => "2099-01-01T10:00:00Z", "expires_at" => "2099-02-01T08:00:00Z")
    end

    it "creates a code with a null validity period", parity: true do
      create_code({ name: "OPEN", amount_off: "50", valid_at: nil, expires_at: nil }, as: :json)

      expect(response.parsed_body["offer_code"]).to include("valid_at" => nil, "expires_at" => nil)
    end

    it "creates a code with a purchase limit and a minimum amount", parity: true do
      create_code({ name: "LIMITED", amount_off: "50", max_purchase_count: "5", minimum_amount_cents: "200" })

      expect(response.parsed_body["offer_code"]).to include("max_purchase_count" => 5, "minimum_amount_cents" => 200)
    end

    it "clamps a purchase limit above the maximum", parity: true do
      create_code({ name: "HUGE", amount_off: "50", max_purchase_count: "20000000" })

      expect(response.parsed_body["offer_code"]).to include("max_purchase_count" => 10_000_000)
    end

    it "drops the sale label of a code that is not applied automatically", parity: true do
      create_code({ name: "LABELLED", amount_off: "50", sale_label: "Big sale" })

      expect(response.parsed_body["offer_code"]).to include("sale_label" => nil, "auto_apply" => false)
    end

    it "strips the name of the code", parity: true do
      create_code({ name: "  PADDED  ", amount_off: "50" })

      expect(response.parsed_body["offer_code"]).to include("name" => "PADDED")
    end

    it "marks a code created by the command line tool", parity: true do
      change(:post, "/products/#{product.external_id}/offer_codes", { name: "CLI", amount_off: "50" }, headers: { "User-Agent" => "gumroad-cli/1.2.3" })

      expect(OfferCode.find_by(code: "CLI")).to be_created_via_cli
    end

    it "creates a universal code", parity: true do
      create_code({ name: "EVERYTHING", amount_off: "50", universal: "true" })

      expect(response.parsed_body["offer_code"]).to include("universal" => true)
    end

    it "creates a universal percent code", parity: true do
      create_code({ name: "EVERYPCT", offer_type: "percent", amount_off: "20", universal: true }, as: :json)

      expect(response.parsed_body["offer_code"]).to include("universal" => true, "percent_off" => 20)
    end

    it "expires the cached values of the product", parity: true do
      ProductCachedValue.create!(product:)

      create_code({ name: "FRESH", amount_off: "50" })

      expect(ProductCachedValue.where(product_id: product.id).pluck(:expired)).to eq([true])
    end

    it "creates a code through the /api prefix on the Gumroad domain", parity: true do
      create_code({ name: "VIAAPI", amount_off: "50" }, api_host: false)

      expect(response.parsed_body["offer_code"]).to include("name" => "VIAAPI")
    end

    it "refuses a name the product already uses", parity: true do
      create_code({ name: "SAVE10", amount_off: "50" })

      expect(response.parsed_body).to eq("success" => false, "message" => "Discount code must be unique.")
    end

    it "refuses a name a universal code of the seller already uses", parity: true do
      create(:universal_offer_code, user: seller, code: "ALLOFIT", amount_cents: 100)

      create_code({ name: "ALLOFIT", amount_off: "50" })

      expect(response.parsed_body["message"]).to eq("Discount code must be unique.")
    end

    it "refuses a universal name the seller already uses", parity: true do
      create(:universal_offer_code, user: seller, code: "ALLOFIT", amount_cents: 100)

      create_code({ name: "ALLOFIT", amount_off: "50", universal: "true" })

      expect(response.parsed_body["message"]).to eq("Discount code must be unique.")
    end

    it "refuses a price after the discount below the minimum", parity: true do
      create_code({ name: "TOOMUCH", amount_off: "995" })

      expect(response.parsed_body["message"]).to eq("The price after discount for all of your products must be either $0 or at least $0.99.")
    end

    it "refuses a percentage above 100", parity: true do
      create_code({ name: "OVER", offer_type: "percent", amount_off: "101" })

      expect(response.parsed_body["message"]).to eq("Please enter a discount amount that is 100% or less.")
    end

    it "refuses a negative amount", parity: true do
      create_code({ name: "NEGATIVE", amount_off: "-5" })

      expect(response.parsed_body["message"]).to eq("Please enter a positive discount amount.")
    end

    it "refuses a name with characters the format does not allow", parity: true do
      create_code({ name: "BAD CODE!", amount_off: "50" })

      expect(response.parsed_body["message"]).to eq("Discount code can only contain numbers, letters, dashes, and underscores.")
    end

    it "refuses a request without a name", parity: true do
      create_code({ amount_off: "50" })

      expect(response.parsed_body["message"]).to eq("Discount code can't be blank")
    end

    it "refuses an end date before the start date", parity: true do
      create_code({ name: "BACKWARDS", amount_off: "50", valid_at: "2099-02-01T10:00:00Z", expires_at: "2099-01-01T10:00:00Z" })

      expect(response.parsed_body["message"]).to eq("The discount code's start date must be earlier than its end date.")
    end

    it "refuses an end date without a start date", parity: true do
      create_code({ name: "NOSTART", amount_off: "50", expires_at: "2099-01-01T10:00:00Z" })

      expect(response.parsed_body["message"]).to eq("The discount code's start date must be earlier than its end date.")
    end

    it "hands a timestamp with minutes out of range to Rails", parity: true do
      create_code({ name: "ODD", amount_off: "50", valid_at: "2099-01-01T10:75:00Z" })

      expect(response.parsed_body["success"]).to eq(false)
    end

    it "hands a validity period with a fraction of a second to Rails", parity: true do
      create_code({ name: "FRACTION", amount_off: "50", valid_at: "2099-01-01T10:00:00.5Z" })

      expect(response.parsed_body).to include("success")
    end

    describe "applied automatically" do
      it "creates a universal code applied automatically", parity: true do
        create_code({ name: "AUTO", amount_off: "50", universal: "true", auto_apply: "true", sale_label: "Sale" })

        expect(response.parsed_body["offer_code"]).to include("auto_apply" => true, "sale_label" => "Sale")
      end

      it "strips the sale label and reads auto_apply true from a JSON body", parity: true do
        create_code({ name: "AUTO", amount_off: "50", universal: true, auto_apply: true, sale_label: "  Flash sale  " }, as: :json)

        expect(response.parsed_body["offer_code"]).to include("auto_apply" => true, "sale_label" => "Flash sale")
      end

      it "stores a blank sale label as none", parity: true do
        create_code({ name: "AUTO", amount_off: "50", universal: "true", auto_apply: "true", sale_label: "   " })

        expect(response.parsed_body["offer_code"]).to include("auto_apply" => true, "sale_label" => nil)
      end

      it "creates a percent code applied automatically", parity: true do
        create_code({ name: "AUTOPCT", offer_type: "percent", amount_off: "25", universal: "true", auto_apply: "true" })

        expect(response.parsed_body["offer_code"]).to include("auto_apply" => true, "percent_off" => 25)
      end

      it "refuses a code for one product", parity: true do
        create_code({ name: "AUTO", amount_off: "50", auto_apply: "true" })

        expect(response.parsed_body["message"]).to eq("Only a discount that applies to all products can be applied automatically.")
      end

      it "refuses a second code applied automatically", parity: true do
        create(:universal_offer_code, user: seller, code: "ALLOFIT", amount_cents: 100, auto_apply: true)

        create_code({ name: "AUTO", amount_off: "50", universal: "true", auto_apply: "true" })

        expect(response.parsed_body["message"]).to eq("Another discount (ALLOFIT) is already applied automatically. Turn it off first.")
      end

      it "refuses a sale label past 32 characters", parity: true do
        create_code({ name: "AUTO", amount_off: "50", universal: "true", auto_apply: "true", sale_label: "x" * 33 })

        expect(response.parsed_body["message"]).to eq("The sale label can be at most 32 characters.")
      end

      it "refuses a sale label with angle brackets", parity: true do
        create_code({ name: "AUTO", amount_off: "50", universal: "true", auto_apply: "true", sale_label: "<b>Sale</b>" })

        expect(response.parsed_body["message"]).to eq("The sale label must be plain text.")
      end

      it "reads auto_apply false as not applied automatically", parity: true do
        create_code({ name: "AUTO", amount_off: "50", universal: "true", auto_apply: "false", sale_label: "Sale" })

        expect(response.parsed_body["offer_code"]).to include("auto_apply" => false, "sale_label" => nil)
      end
    end

    it "reads a purchase limit that is not a whole number as its leading digits", parity: true do
      create_code({ name: "WORDS", amount_off: "50", max_purchase_count: "many" })

      expect(response.parsed_body["offer_code"]).to include("max_purchase_count" => 0)
    end

    it "reads an amount with a decimal point as its whole part", parity: true do
      create_code({ name: "DECIMAL", amount_off: "5.5" })

      expect(response.parsed_body["offer_code"]).to include("amount_cents" => 5)
    end

    it "hands a code on a product with options to Rails", parity: true do
      create(:variant, variant_category: create(:variant_category, link: product))

      create_code({ name: "OPTIONS", amount_off: "50" })

      expect(response.parsed_body["success"]).to eq(true)
    end

    it "hands a code on a membership to Rails", parity: true do
      membership = create(:membership_product, user: seller, name: "Club", unique_permalink: "clubmember")

      create_code({ name: "MEMBERS", amount_off: "50" }, product_id: membership.external_id)

      expect(response.parsed_body).to include("success")
    end
  end

  describe "PATCH and PUT /offer_codes/:id" do
    it "does not find an unknown offer code", parity: true do
      change(:put, "/offer_codes/unknown", { max_purchase_count: 3 })

      expect(response.parsed_body).to eq("success" => false, "message" => "The offer_code was not found.")
    end

    it "does not find the offer code of another seller", parity: true do
      other = create(:offer_code, user: create(:user, email: "other-code-seller@example.com"), code: "OTHER")

      change(:patch, "/offer_codes/#{other.external_id}", { max_purchase_count: 3 })

      expect(response.parsed_body["message"]).to eq("The offer_code was not found.")
    end

    it "does not find a deleted offer code", parity: true do
      offer_code.update!(deleted_at: Time.current)

      change(:put, "/offer_codes/#{offer_code.external_id}", { max_purchase_count: 3 })

      expect(response.parsed_body["message"]).to eq("The offer_code was not found.")
    end

    it "refuses an expires_at that is not a timestamp", parity: true do
      change(:patch, "/offer_codes/#{offer_code.external_id}", { expires_at: "soon" })

      expect(response.parsed_body["message"]).to eq("expires_at must be an RFC 3339 timestamp with a time zone, or null.")
    end

    it "refuses a request without a token", parity: true do
      change(:put, "/offer_codes/#{offer_code.external_id}", { max_purchase_count: 3 }, token: nil)

      expect(response).to have_http_status(:unauthorized)
    end

    it "updates the purchase limit with a PATCH", parity: true do
      change(:patch, "/offer_codes/#{offer_code.external_id}", { max_purchase_count: 3 })

      expect(response.parsed_body["offer_code"]).to include("max_purchase_count" => 3)
    end

    it "sets a validity period with a PUT", parity: true do
      change(:put, "/offer_codes/#{offer_code.external_id}", { valid_at: "2099-01-01T10:00:00Z", expires_at: "2099-03-01T10:00:00Z" })

      expect(response.parsed_body["offer_code"]).to include("valid_at" => "2099-01-01T10:00:00Z", "expires_at" => "2099-03-01T10:00:00Z")
    end

    it "clears the validity period with a PUT", parity: true do
      offer_code.update!(valid_at: 2.days.ago.change(usec: 0), expires_at: 30.days.from_now.change(usec: 0))

      change(:put, "/offer_codes/#{offer_code.external_id}", { valid_at: nil, expires_at: nil }, as: :json)

      expect(response.parsed_body["offer_code"]).to include("valid_at" => nil, "expires_at" => nil)
    end

    it "updates the minimum amount", parity: true do
      change(:patch, "/offer_codes/#{offer_code.external_id}", { minimum_amount_cents: "500" })

      expect(response.parsed_body["offer_code"]).to include("minimum_amount_cents" => 500)
    end

    it "clears the minimum amount and the purchase limit with blank values", parity: true do
      offer_code.update!(minimum_amount_cents: 500, max_purchase_count: 4)

      change(:patch, "/offer_codes/#{offer_code.external_id}", { minimum_amount_cents: "", max_purchase_count: "" })

      expect(response.parsed_body["offer_code"]).to include("minimum_amount_cents" => nil, "max_purchase_count" => nil)
    end

    it "keeps an untouched code as it is", parity: true do
      change(:patch, "/offer_codes/#{offer_code.external_id}", {})

      expect(response.parsed_body["offer_code"]).to include("name" => "SAVE10")
    end

    it "ignores the sale label of a code that is not applied automatically", parity: true do
      change(:patch, "/offer_codes/#{offer_code.external_id}", { sale_label: "Flash", auto_apply: "false" })

      expect(response.parsed_body["offer_code"]).to include("sale_label" => nil, "auto_apply" => false)
    end

    it "updates a universal code", parity: true do
      universal = create(:universal_offer_code, user: seller, code: "ALLOFIT", amount_cents: 100)

      change(:put, "/offer_codes/#{universal.external_id}", { max_purchase_count: 9 })

      expect(response.parsed_body["offer_code"]).to include("universal" => true, "max_purchase_count" => 9)
    end

    it "expires the cached values of the products of the code", parity: true do
      ProductCachedValue.create!(product:)

      change(:patch, "/offer_codes/#{offer_code.external_id}", { max_purchase_count: 6 })

      expect(ProductCachedValue.where(product_id: product.id).pluck(:expired)).to eq([true])
    end

    it "refuses a purchase limit below the times the code was used", parity: true do
      build(:purchase, link: product, seller:, offer_code:, purchase_state: "successful").save!(validate: false)

      change(:patch, "/offer_codes/#{offer_code.external_id}", { max_purchase_count: 0 })

      expect(response.parsed_body["message"]).to eq("You have chosen a discount code quantity that is less that the number already used. Please enter an amount no less than 1.")
    end

    it "refuses an end date before the start date on update", parity: true do
      change(:put, "/offer_codes/#{offer_code.external_id}", { valid_at: "2099-03-01T10:00:00Z", expires_at: "2099-01-01T10:00:00Z" })

      expect(response.parsed_body["message"]).to eq("The discount code's start date must be earlier than its end date.")
    end

    it "clamps a purchase limit above the maximum on update", parity: true do
      change(:patch, "/offer_codes/#{offer_code.external_id}", { max_purchase_count: "99999999" })

      expect(response.parsed_body["offer_code"]).to include("max_purchase_count" => 10_000_000)
    end

    describe "applied automatically" do
      let!(:universal) { create(:universal_offer_code, user: seller, code: "ALLOFIT", amount_cents: 100) }

      it "switches a universal code to automatic application", parity: true do
        change(:patch, "/offer_codes/#{universal.external_id}", { auto_apply: true, sale_label: "Sale" }, as: :json)

        expect(response.parsed_body["offer_code"]).to include("auto_apply" => true, "sale_label" => "Sale")
      end

      it "refuses to switch a code for one product", parity: true do
        change(:patch, "/offer_codes/#{offer_code.external_id}", { auto_apply: "true" })

        expect(response.parsed_body["message"]).to eq("Only a discount that applies to all products can be applied automatically.")
      end

      it "refuses to switch a second code", parity: true do
        create(:universal_offer_code, user: seller, code: "BLACKFRIDAY", amount_cents: 100, auto_apply: true)

        change(:patch, "/offer_codes/#{universal.external_id}", { auto_apply: "true" })

        expect(response.parsed_body["message"]).to eq("Another discount (BLACKFRIDAY) is already applied automatically. Turn it off first.")
      end

      it "switches automatic application off and drops the sale label", parity: true do
        applied = create(:universal_offer_code, user: seller, code: "BLACKFRIDAY", amount_cents: 100, auto_apply: true, sale_label: "Sale")

        change(:patch, "/offer_codes/#{applied.external_id}", { auto_apply: "false" })

        expect(response.parsed_body["offer_code"]).to include("auto_apply" => false, "sale_label" => nil)
      end

      it "changes the sale label of a code applied automatically", parity: true do
        applied = create(:universal_offer_code, user: seller, code: "BLACKFRIDAY", amount_cents: 100, auto_apply: true, sale_label: "Sale")

        change(:patch, "/offer_codes/#{applied.external_id}", { sale_label: " Flash " })

        expect(response.parsed_body["offer_code"]).to include("auto_apply" => true, "sale_label" => "Flash")
      end

      it "keeps the automatic application of a code when another limit changes", parity: true do
        applied = create(:universal_offer_code, user: seller, code: "BLACKFRIDAY", amount_cents: 100, auto_apply: true, sale_label: "Sale")

        change(:patch, "/offer_codes/#{applied.external_id}", { max_purchase_count: 7 })

        expect(response.parsed_body["offer_code"]).to include("auto_apply" => true, "max_purchase_count" => 7)
      end

      it "deletes a code applied automatically", parity: true do
        applied = create(:universal_offer_code, user: seller, code: "BLACKFRIDAY", amount_cents: 100, auto_apply: true, sale_label: "Sale")

        change(:delete, "/products/#{product.external_id}/offer_codes/#{applied.external_id}")

        expect(response.parsed_body["success"]).to eq(true)
        expect(applied.reload.deleted_at).to be_present
      end
    end

    it "reads a purchase limit written in exponent form as its leading digits", parity: true do
      change(:patch, "/offer_codes/#{offer_code.external_id}", { max_purchase_count: "1e3" })

      expect(response.parsed_body["offer_code"]).to include("max_purchase_count" => 1)
    end

    it "hands a code limited to existing customers to Rails", parity: true do
      limited = create(:offer_code, user: seller, products: [product], code: "LOYAL", amount_cents: 100, existing_customers_only: true, ownership_products: [product])

      change(:patch, "/offer_codes/#{limited.external_id}", { max_purchase_count: 2 })

      expect(response.parsed_body["success"]).to eq(true)
    end

    it "hands a universal code with an excluded product to Rails", parity: true do
      universal = create(:universal_offer_code, user: seller, code: "ALLBUT", amount_cents: 100, excluded_products: [product])

      change(:patch, "/offer_codes/#{universal.external_id}", { max_purchase_count: 2 })

      expect(response.parsed_body["success"]).to eq(true)
    end

    it "hands a code of a seller with a membership to Rails", parity: true do
      create(:membership_product, user: seller, name: "Club", unique_permalink: "clubmember")
      universal = create(:universal_offer_code, user: seller, code: "ALLOFIT", amount_cents: 100)

      change(:patch, "/offer_codes/#{universal.external_id}", { max_purchase_count: 2 })

      expect(response.parsed_body).to include("success")
    end
  end

  describe "PATCH, PUT and DELETE /products/:link_id/offer_codes/:id" do
    it "does not find the product", parity: true do
      change(:put, "/products/unknown/offer_codes/#{offer_code.external_id}", { max_purchase_count: 3 })

      expect(response.parsed_body["message"]).to eq("The product was not found.")
    end

    it "does not find an offer code that belongs to another product", parity: true do
      other_product = create(:product, user: seller, name: "Other", unique_permalink: "otherprod")

      change(:patch, "/products/#{other_product.external_id}/offer_codes/#{offer_code.external_id}", { max_purchase_count: 3 })

      expect(response.parsed_body["message"]).to eq("The offer_code was not found.")
    end

    it "refuses a validity period that is not a timestamp", parity: true do
      change(:put, "/products/#{product.external_id}/offer_codes/#{offer_code.external_id}", { valid_at: "2099-01-01" })

      expect(response.parsed_body["message"]).to eq("valid_at must be an RFC 3339 timestamp with a time zone, or null.")
    end

    it "updates the purchase limit through the product", parity: true do
      change(:patch, "/products/#{product.external_id}/offer_codes/#{offer_code.external_id}", { max_purchase_count: 7 })

      expect(response.parsed_body["offer_code"]).to include("max_purchase_count" => 7)
    end

    it "updates a universal code through the product", parity: true do
      universal = create(:universal_offer_code, user: seller, code: "ALLOFIT", amount_cents: 100)

      change(:put, "/products/#{product.external_id}/offer_codes/#{universal.external_id}", { max_purchase_count: 5 })

      expect(response.parsed_body["offer_code"]).to include("universal" => true, "max_purchase_count" => 5)
    end

    it "does not find an unknown offer code on DELETE", parity: true do
      change(:delete, "/products/#{product.external_id}/offer_codes/unknown")

      expect(response.parsed_body).to eq("success" => false, "message" => "The offer_code was not found.")
    end

    it "does not find the product on DELETE", parity: true do
      change(:delete, "/products/unknown/offer_codes/#{offer_code.external_id}")

      expect(response.parsed_body["message"]).to eq("The product was not found.")
    end

    it "ignores a malformed validity period on a deletion", parity: true do
      change(:delete, "/products/#{product.external_id}/offer_codes/#{offer_code.external_id}", { valid_at: "garbage" })

      expect(response.parsed_body["success"]).to eq(true)
      expect(offer_code.reload.deleted_at).to be_present
    end

    it "deletes a code", parity: true do
      change(:delete, "/products/#{product.external_id}/offer_codes/#{offer_code.external_id}")

      expect(response.parsed_body["message"]).to eq("The offer_code was deleted successfully.")
    end

    it "deletes a code through the /api prefix on the Gumroad domain", parity: true do
      change(:delete, "/products/#{product.external_id}/offer_codes/#{offer_code.external_id}", {}, api_host: false)

      expect(response.parsed_body["success"]).to eq(true)
    end

    it "deletes a universal code", parity: true do
      universal = create(:universal_offer_code, user: seller, code: "ALLOFIT", amount_cents: 100)

      change(:delete, "/products/#{product.external_id}/offer_codes/#{universal.external_id}")

      expect(universal.reload.deleted_at).to be_present
    end

    it "deletes a code that was used", parity: true do
      build(:purchase, link: product, seller:, offer_code:, purchase_state: "successful").save!(validate: false)

      change(:delete, "/products/#{product.external_id}/offer_codes/#{offer_code.external_id}")

      expect(response.parsed_body["success"]).to eq(true)
    end

    it "refuses to delete the default discount of a product", parity: true do
      product.update_column(:default_offer_code_id, offer_code.id)

      change(:delete, "/products/#{product.external_id}/offer_codes/#{offer_code.external_id}")

      # destroy renders error_with_offer_code without the record, so the validation message never reaches the response.
      expect(response.parsed_body).to eq("success" => false, "message" => "The offer_code was not found.")
      expect(offer_code.reload.deleted_at).to be_nil
    end

    it "hands a deletion of a universal code with an excluded product to Rails", parity: true do
      universal = create(:universal_offer_code, user: seller, code: "ALLBUT", amount_cents: 100, excluded_products: [product])

      change(:delete, "/products/#{product.external_id}/offer_codes/#{universal.external_id}")

      expect(response.parsed_body["success"]).to eq(true)
    end
  end
end
