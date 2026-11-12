# frozen_string_literal: true

require "spec_helper"

# The create_draft_product tool of Mcp::Server through the full Rack stack, recorded for the Next.js port and replayed by
# nextjs/parity/__tests__/api-v2-ws17c.replay.test.ts. Node saves a plain digital draft (a USD price above zero and a description with no markup);
# every other call goes to Rails whole, in an example named "hands ... back". `parity_timeline` records the order of the statements and jobs.
describe "API v2 MCP product writes", type: :request, parity_timeline: true do
  let(:seller) { create(:user, username: "dude", name: "Dude") }
  let(:application) { create(:oauth_application, owner: create(:user)) }
  let(:rpc) { { "Content-Type" => "application/json" } }
  let(:created) { Link.order(:id).last }

  before { host! DOMAIN }

  def auth(scopes) = { "Authorization" => "Bearer #{create("doorkeeper/access_token", application:, resource_owner_id: seller.id, scopes:).token}" }

  def call_tool(name, arguments = {}, scopes: "edit_products")
    body = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name:, arguments: } }
    post "/muse/v1/mcp", params: body.to_json, headers: rpc.merge(auth(scopes))
  end

  def create_draft(arguments, **options) = call_tool("create_draft_product", arguments, **options)

  describe "create_draft_product" do
    it "saves a draft with a name, a description and a price", parity: true do
      create_draft({ name: "Notebook", description: "Dotted pages", price_cents: 500 })

      expect(created.draft).to be true
      expect(created.purchase_disabled_at).to be_present
      expect(created.price_cents).to eq(500)
    end

    it "saves a draft with no description", parity: true do
      create_draft({ name: "Notebook", price_cents: 1200 })

      expect(created.description).to eq("")
    end

    it "strips the name", parity: true do
      create_draft({ name: "  Notebook \n", price_cents: 500 })

      expect(created.name).to eq("Notebook")
    end

    it "accepts the account scope", parity: true do
      create_draft({ name: "Notebook", price_cents: 500 }, scopes: "account")
    end

    it "reports a name over 255 characters as a tool error", parity: true do
      create_draft({ name: "a" * 256, price_cents: 500 })

      expect(Link.count).to eq(0)
    end

    it "reports a price over the maximum as a tool error", parity: true do
      create_draft({ name: "Notebook", price_cents: 2_147_483_648 })
    end

    it "refuses a blank name", parity: true do
      create_draft({ name: "   ", price_cents: 500 })

      expect(Link.count).to eq(0)
    end

    it "refuses a negative price", parity: true do
      create_draft({ name: "Notebook", price_cents: -1 })
    end

    it "requires the price of a product", parity: true do
      create_draft({ name: "Notebook" })
    end

    it "refuses tiers on a digital product", parity: true do
      create_draft({ name: "Notebook", price_cents: 500, tiers: [] })
    end

    it "refuses a price on a membership", parity: true do
      create_draft({ name: "Club", product_type: "membership", price_cents: 500 })
    end

    it "refuses a membership with a malformed tier", parity: true do
      create_draft({ name: "Club", product_type: "membership", tiers: [{ name: "Gold" }] })
    end

    it "refuses a membership with no tiers", parity: true do
      create_draft({ name: "Club", product_type: "membership" })
    end

    it "refuses a tier with an unknown key", parity: true do
      create_draft({ name: "Club", product_type: "membership", tiers: [{ name: "Gold", price_cents: 500, recurrence: "monthly", color: "gold" }] })
    end

    it "refuses a tier that is not an object", parity: true do
      create_draft({ name: "Club", product_type: "membership", tiers: ["Gold"] })
    end

    it "refuses a tier with a blank name", parity: true do
      create_draft({ name: "Club", product_type: "membership", tiers: [{ name: " ", price_cents: 500, recurrence: "monthly" }] })
    end

    it "refuses a tier with a negative price", parity: true do
      create_draft({ name: "Club", product_type: "membership", tiers: [{ name: "Gold", price_cents: -5, recurrence: "monthly" }] })
    end

    it "refuses a tier priced over the maximum", parity: true do
      create_draft({ name: "Club", product_type: "membership", tiers: [{ name: "Gold", price_cents: 2_147_483_648, recurrence: "monthly" }] })
    end

    it "refuses a tier with an unknown recurrence", parity: true do
      create_draft({ name: "Club", product_type: "membership", tiers: [{ name: "Gold", price_cents: 500, recurrence: "weekly" }] })
    end

    it "refuses tiers that bill at different intervals", parity: true do
      create_draft({ name: "Club", product_type: "membership", tiers: [{ name: "Gold", price_cents: 500, recurrence: "monthly" }, { name: "Silver", price_cents: 100, recurrence: "yearly" }] })
    end

    it "hands a free product back to Rails", parity: true do
      create_draft({ name: "Freebie", price_cents: 0 })
    end

    it "hands a description with markup back to Rails", parity: true do
      create_draft({ name: "Notebook", description: "<p>Dotted pages</p>", price_cents: 500 })
    end

    it "hands a membership back to Rails", parity: true do
      create_draft({ name: "Club", product_type: "membership", tiers: [{ name: "Gold", price_cents: 500, recurrence: "monthly" }] })
    end

    it "hands a seller who prices in another currency back to Rails", parity: true do
      seller.update_columns(currency_type: "eur")
      create_draft({ name: "Notebook", price_cents: 500 })
    end

    it "hands a call without the edit scope back to Rails", parity: true do
      create_draft({ name: "Notebook", price_cents: 500 }, scopes: "view_sales")
    end
  end
end
