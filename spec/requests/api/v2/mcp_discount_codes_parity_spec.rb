# frozen_string_literal: true

require "spec_helper"

# The create_discount_code and update_discount_code tools of Mcp::Server through the full Rack stack, recorded for the Next.js port and
# replayed by nextjs/parity/__tests__/api-v2-ws17c.replay.test.ts. Node saves a plain code (no tiers, customer limits, exclusions or options)
# on products that are not memberships and have no options; every other call goes to Rails whole, in an example named "hands ... back".
# `parity_timeline` records the order of the statements and jobs inside each call.
describe "API v2 MCP discount codes", type: :request, parity_timeline: true do
  let(:seller) { create(:user, username: "dude", name: "Dude") }
  let(:application) { create(:oauth_application, owner: create(:user)) }
  let(:rpc) { { "Content-Type" => "application/json" } }
  let!(:product) { create(:product, user: seller, name: "Pencil", unique_permalink: "pencilpk", price_cents: 1000, created_at: 2.days.ago) }
  let(:created) { OfferCode.order(:id).last }

  before { host! DOMAIN }

  def auth(scopes) = { "Authorization" => "Bearer #{create("doorkeeper/access_token", application:, resource_owner_id: seller.id, scopes:).token}" }

  def call_tool(name, arguments = {}, scopes: "edit_products")
    body = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name:, arguments: } }
    post "/muse/v1/mcp", params: body.to_json, headers: rpc.merge(auth(scopes))
  end

  def create_code(arguments, **options) = call_tool("create_discount_code", arguments, **options)

  def update_code(arguments, **options) = call_tool("update_discount_code", arguments, **options)

  describe "create_discount_code" do
    it "creates a percentage code for all products", parity: true do
      create_code({ code: "TENOFF", percent_off: 10 })

      expect(created).to be_universal
      expect(created.amount_percentage).to eq(10)
    end

    it "creates a code for one product", parity: true do
      create_code({ code: "PENCIL", percent_off: 25, product_id: "pencilpk" })

      expect(created.products).to eq([product])
    end

    it "finds the product by external id with the account scope", parity: true do
      create_code({ code: "PENCIL", percent_off: 25, product_id: product.external_id }, scopes: "account")
    end

    it "creates a fixed amount code for all products", parity: true do
      create_code({ code: "FIVEOFF", amount_cents: 500 })

      expect(created.amount_cents).to eq(500)
      expect(created.currency_type).to eq("usd")
    end

    it "creates a fixed amount code for one product", parity: true do
      create_code({ code: "FIVEOFF", amount_cents: 500, product_id: "pencilpk" })
    end

    it "strips the code", parity: true do
      create_code({ code: "  TRIMMED \n", percent_off: 10 })

      expect(created.code).to eq("TRIMMED")
    end

    it "sets the validity period", parity: true do
      create_code({ code: "WINDOW", percent_off: 10, valid_at: "2099-01-01T10:00:00Z", expires_at: "2099-02-01T08:00:00+02:00" })
    end

    it "starts a code that only has an end date now", parity: true do
      create_code({ code: "ENDING", percent_off: 10, expires_at: "2099-02-01T08:00:00Z" })
    end

    it "limits how many times the code can be used", parity: true do
      create_code({ code: "LIMITED", percent_off: 10, max_purchase_count: 5 })

      expect(created.max_purchase_count).to eq(5)
    end

    it "accepts a limit of zero", parity: true do
      create_code({ code: "NONE", percent_off: 10, max_purchase_count: 0 })
    end

    it "reports a code that the seller already uses for all products as a tool error", parity: true do
      create(:offer_code, user: seller, code: "TENOFF", universal: true, products: [], currency_type: nil, amount_percentage: 10, amount_cents: nil)
      create_code({ code: "TENOFF", percent_off: 20 })
    end

    it "reports a code with a character that is not allowed as a tool error", parity: true do
      create_code({ code: "TEN OFF", percent_off: 10 })
    end

    it "reports a fixed amount that takes the product below the minimum price as a tool error", parity: true do
      create_code({ code: "TOOMUCH", amount_cents: 995, product_id: "pencilpk" })
    end

    it "reports an end date before the start date as a tool error", parity: true do
      create_code({ code: "BACKWARDS", percent_off: 10, valid_at: "2099-02-01T00:00:00Z", expires_at: "2099-01-01T00:00:00Z" })
    end

    it "refuses a blank code", parity: true do
      create_code({ code: " ", percent_off: 10 })
    end

    it "refuses a percentage above 100", parity: true do
      create_code({ code: "TOOBIG", percent_off: 101 })
    end

    it "refuses a percentage of zero", parity: true do
      create_code({ code: "ZERO", percent_off: 0 })
    end

    it "refuses both kinds of amount", parity: true do
      create_code({ code: "BOTH", percent_off: 10, amount_cents: 100 })
    end

    it "refuses a code with no amount", parity: true do
      create_code({ code: "NOTHING" })
    end

    it "refuses an amount of zero cents", parity: true do
      create_code({ code: "FREE", amount_cents: 0 })
    end

    it "refuses a negative limit", parity: true do
      create_code({ code: "NEGATIVE", percent_off: 10, max_purchase_count: -1 })
    end

    it "refuses a blank product id", parity: true do
      create_code({ code: "BLANK", percent_off: 10, product_id: " " })
    end

    it "refuses a start year before 1000", parity: true do
      create_code({ code: "ANCIENT", percent_off: 10, valid_at: "0999-01-01T00:00:00Z" })
    end

    it "does not find the product of another seller", parity: true do
      other = create(:product, user: create(:user), unique_permalink: "otherpk")
      create_code({ code: "OTHER", percent_off: 10, product_id: other.external_id })
    end

    it "hands a time that is not a whole-second timestamp back to Rails", parity: true do
      create_code({ code: "FRACTION", percent_off: 10, expires_at: "2099-02-01T08:00:00.5Z" })
    end

    it "hands a time that is not a time back to Rails", parity: true do
      create_code({ code: "GARBAGE", percent_off: 10, expires_at: "soon" })
    end

    it "hands a code for a membership back to Rails", parity: true do
      membership = create(:membership_product, user: seller, unique_permalink: "clubpk")
      create_code({ code: "CLUB", percent_off: 10, product_id: membership.external_id })
    end

    it "hands a call without the edit scope back to Rails", parity: true do
      create_code({ code: "TENOFF", percent_off: 10 }, scopes: "view_sales")
    end
  end

  describe "update_discount_code" do
    let!(:universal) { create(:offer_code, user: seller, code: "TENOFF", universal: true, products: [], currency_type: nil, amount_percentage: 10, amount_cents: nil, created_at: 2.days.ago, updated_at: 2.days.ago) }
    let!(:scoped) { create(:offer_code, user: seller, code: "PENCIL", products: [product], amount_cents: 100, created_at: 2.days.ago, updated_at: 2.days.ago) }

    it "changes the percentage of a code for all products", parity: true do
      update_code({ code: "TENOFF", percent_off: 20 })

      expect(universal.reload.amount_percentage).to eq(20)
    end

    it "changes the amount of a code for one product", parity: true do
      update_code({ code: "PENCIL", product_id: "pencilpk", amount_cents: 200 })

      expect(scoped.reload.amount_cents).to eq(200)
    end

    it "changes the limit", parity: true do
      update_code({ code: "TENOFF", max_purchase_count: 3 })
    end

    it "sets an end date and starts the code from its creation", parity: true do
      update_code({ code: "TENOFF", expires_at: "2099-02-01T08:00:00Z" })
    end

    it "sets both ends of the validity period", parity: true do
      update_code({ code: "PENCIL", product_id: "pencilpk", valid_at: "2099-01-01T00:00:00Z", expires_at: "2099-03-01T00:00:00Z" })
    end

    it "strips the code it looks for", parity: true do
      update_code({ code: " TENOFF ", max_purchase_count: 3 })
    end

    it "reports a code that has been used more often than the new limit as a tool error", parity: true do
      universal.update_columns(max_purchase_count: nil)
      sale = build(:purchase, link: product, offer_code: universal, purchase_state: "successful")
      sale.save!(validate: false)
      update_code({ code: "TENOFF", max_purchase_count: 0 })
    end

    it "reports a fixed amount that takes the product below the minimum price as a tool error", parity: true do
      update_code({ code: "PENCIL", product_id: "pencilpk", amount_cents: 995 })
    end

    it "does not find a code that covers all products when a product is given", parity: true do
      update_code({ code: "TENOFF", product_id: "pencilpk", percent_off: 5 })
    end

    it "does not find a code that is limited to a product when none is given", parity: true do
      update_code({ code: "PENCIL", percent_off: 5 })
    end

    it "does not find a deleted code", parity: true do
      universal.update_columns(deleted_at: Time.current)
      update_code({ code: "TENOFF", percent_off: 5 })
    end

    it "refuses a call that changes nothing", parity: true do
      update_code({ code: "TENOFF" })
    end

    it "refuses both kinds of amount", parity: true do
      update_code({ code: "TENOFF", percent_off: 10, amount_cents: 100 })
    end

    it "refuses a percentage above 100", parity: true do
      update_code({ code: "TENOFF", percent_off: 101 })
    end

    it "refuses a blank code", parity: true do
      update_code({ code: "", percent_off: 10 })
    end

    it "hands a change from a percentage to a fixed amount back to Rails", parity: true do
      update_code({ code: "TENOFF", amount_cents: 100 })
    end

    it "hands a change from a fixed amount to a percentage back to Rails", parity: true do
      update_code({ code: "PENCIL", product_id: "pencilpk", percent_off: 10 })
    end

    it "hands a code with duration tiers back to Rails", parity: true do
      universal.update_columns(ownership_duration_tiers: [{ "months" => 3, "amount_percentage" => 10 }])
      update_code({ code: "TENOFF", max_purchase_count: 3 })
    end

    it "hands a call without the edit scope back to Rails", parity: true do
      update_code({ code: "TENOFF", percent_off: 20 }, scopes: "view_sales")
    end
  end

  describe "expire_discount_code" do
    let!(:universal) { create(:offer_code, user: seller, code: "TENOFF", universal: true, products: [], currency_type: nil, amount_percentage: 10, amount_cents: nil, created_at: 2.days.ago, updated_at: 2.days.ago) }
    let!(:scoped) { create(:offer_code, user: seller, code: "PENCIL", products: [product], amount_cents: 100, created_at: 2.days.ago, updated_at: 2.days.ago) }

    def expire_code(arguments, **options) = call_tool("expire_discount_code", arguments, **options)

    it "ends a code for all products now", parity: true do
      expire_code({ code: "TENOFF" })

      expect(universal.reload.expires_at).to be_within(5.seconds).of(Time.current)
    end

    it "ends a code for one product now", parity: true do
      expire_code({ code: "PENCIL", product_id: "pencilpk" })

      expect(scoped.reload.expires_at).to be_present
    end

    it "moves the start of a code that has not started yet back before its end", parity: true do
      universal.update_columns(valid_at: 3.days.from_now)
      expire_code({ code: "TENOFF" })

      expect(universal.reload.valid_at).to be < universal.expires_at
    end

    it "keeps the start of a code that started long ago", parity: true do
      universal.update_columns(valid_at: 1.day.ago)
      expire_code({ code: "TENOFF" })

      expect(universal.reload.valid_at).to be_within(5.seconds).of(1.day.ago)
    end

    it "ends a code whose end date is still ahead", parity: true do
      universal.update_columns(valid_at: 1.day.ago, expires_at: 10.days.from_now)
      expire_code({ code: "TENOFF" })
    end

    it "strips the code it looks for", parity: true do
      expire_code({ code: "  TENOFF \n" })

      expect(universal.reload.expires_at).to be_present
    end

    it "ends a code whose discount the product price no longer takes, skipping the price check", parity: true do
      product.prices.alive.first.update_columns(price_cents: 150)
      expect(scoped.reload).not_to be_valid
      expire_code({ code: "PENCIL", product_id: "pencilpk" })

      expect(scoped.reload.expires_at).to be_present
    end

    it "ends a code on a membership", parity: true do
      membership = create(:membership_product, user: seller, unique_permalink: "clubpk")
      build(:offer_code, user: seller, code: "CLUB", products: [membership], amount_percentage: 10, amount_cents: nil, currency_type: nil, created_at: 2.days.ago, updated_at: 2.days.ago).save!(validate: false)
      expire_code({ code: "CLUB", product_id: "clubpk" })
    end

    it "reports a code that has already expired and changes nothing", parity: true do
      universal.update_columns(valid_at: 3.days.ago, expires_at: 1.day.ago)
      expire_code({ code: "TENOFF" })
    end

    it "reports a code that expired in the current second as already expired", parity: true do
      universal.update_columns(valid_at: 3.days.ago, expires_at: Time.current.change(usec: 0))
      expire_code({ code: "TENOFF" })
    end

    it "does not find a code that covers all products when a product is given", parity: true do
      expire_code({ code: "TENOFF", product_id: "pencilpk" })
    end

    it "does not find a deleted code", parity: true do
      universal.update_columns(deleted_at: 1.hour.ago)
      expire_code({ code: "TENOFF" })
    end

    it "refuses a blank code", parity: true do
      expire_code({ code: " " })
    end

    it "hands a code with duration tiers back to Rails", parity: true do
      universal.update_columns(ownership_duration_tiers: [{ "months" => 0, "amount_percentage" => 10 }, { "months" => 3, "amount_percentage" => 20 }])
      expire_code({ code: "TENOFF" })
    end

    it "hands a call without the edit scope back to Rails", parity: true do
      expire_code({ code: "TENOFF" }, scopes: "view_sales")
    end
  end
end
