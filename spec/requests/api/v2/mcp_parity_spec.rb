# frozen_string_literal: true

require "spec_helper"

# Api::V2::McpController (connector aliases and .well-known documents) and Api::V2::NotionUnfurlUrlsController through the full Rack stack,
# recorded for the Next.js port (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/api-v2-ws17c.replay.test.ts.
describe "API v2 MCP and Notion", type: :request do
  let(:seller) { create(:user, username: "dude", name: "Dude") }
  let(:application) { create(:oauth_application, owner: create(:user)) }
  let(:rpc) { { "Content-Type" => "application/json" } }

  before { host! DOMAIN }

  def auth(scopes = "view_public") = { "Authorization" => "Bearer #{create("doorkeeper/access_token", application:, resource_owner_id: seller.id, scopes:).token}" }

  %w[muse claude chatgpt].each do |client|
    it "reports the status of the #{client} connector", parity: true do
      get "/#{client}/v1/status"
    end
  end

  describe ".well-known documents" do
    it "serves the MCP discovery document", parity: true do
      get "/.well-known/mcp.json"
    end

    it "serves the OAuth authorization server metadata", parity: true do
      get "/.well-known/oauth-authorization-server"
    end

    it "serves the protected resource metadata for the default resource", parity: true do
      get "/.well-known/oauth-protected-resource"
    end

    it "serves the protected resource metadata for a connector path", parity: true do
      get "/.well-known/oauth-protected-resource/claude/v1/mcp"
    end

    it "serves the OpenAI apps challenge token", parity: true do
      ENV["OPENAI_APPS_CHALLENGE_TOKEN"] = "challenge-token-123"
      get "/.well-known/openai-apps-challenge"
    ensure
      ENV.delete("OPENAI_APPS_CHALLENGE_TOKEN")
    end
  end

  describe "the MCP endpoint" do
    it "challenges a GET without a token", parity: true do
      get "/muse/v1/mcp"
    end

    it "challenges a POST without a token", parity: true do
      post "/claude/v1/mcp", params: { jsonrpc: "2.0", id: 1, method: "ping" }.to_json, headers: rpc
    end

    it "refuses a GET with a token", parity: true do
      get "/chatgpt/v1/mcp", headers: auth
    end

    it "forbids a token without any known scope", parity: true do
      get "/muse/v1/mcp", headers: auth("mobile_api")
    end

    it "answers a tools/list call", parity: true do
      post "/muse/v1/mcp", params: { jsonrpc: "2.0", id: 1, method: "tools/list" }.to_json, headers: rpc.merge(auth)
    end

    it "hands back a body that is not JSON", parity: true do
      post "/muse/v1/mcp", params: "not json", headers: rpc
    end

    it "hands back a request from a foreign origin", parity: true do
      get "/muse/v1/mcp", headers: { "Origin" => "https://evil.example.com" }
    end
  end

  describe "MCP tool calls" do
    let(:product) { create(:product, user: seller, name: "Sketch pack", unique_permalink: "sketchpk") }
    let(:other_product) { create(:product, user: seller, name: "Icon set", unique_permalink: "iconset") }

    def call_tool(name, arguments = {}, scopes: "view_sales")
      body = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name:, arguments: } }
      post "/muse/v1/mcp", params: body.to_json, headers: rpc.merge(auth(scopes))
    end

    def sell(link, email:, price_cents:, at:, **attributes)
      build(:purchase, link:, seller:, email:, price_cents:, purchase_state: "successful", created_at: Time.utc(*at), **attributes).tap { |row| row.save!(validate: false) }
    end

    before do
      sell(product, email: "ada@example.com", price_cents: 1000, at: [2026, 3, 2, 10])
      sell(product, email: "ada@example.com", price_cents: 500, at: [2026, 3, 5, 10], stripe_refunded: true)
      sell(other_product, email: "bob@example.com", price_cents: 2500, at: [2026, 3, 3, 10])
      sell(other_product, email: "cy@example.com", price_cents: 0, at: [2026, 3, 1, 0])
      sell(other_product, email: "cy@example.com", price_cents: 700, at: [2026, 3, 2, 14, 24])
    end

    it "reports the spend of each buyer", parity: true do
      call_tool("get_customers")
    end

    it "reports the spend of a buyer in a date range", parity: true do
      call_tool("get_customers", { email: "ada@example.com", start_date: "2026-03-02", end_date: "2026-03-04" })
    end

    it "reports the buyers who went from free to paid", parity: true do
      call_tool("get_customers", { breakdown: "conversion" })
    end

    it "reports sales totals by product", parity: true do
      call_tool("get_sales_totals", { start_date: "2026-03-01", end_date: "2026-03-31" })
    end

    it "reports sales totals for one product", parity: true do
      call_tool("get_sales_totals", { start_date: "2026-03-01", end_date: "2026-03-31", product_id: other_product.unique_permalink })
    end

    it "refuses a sales totals range that is too long", parity: true do
      call_tool("get_sales_totals", { start_date: "2024-01-01", end_date: "2026-03-31" })
    end

    it "reports a sales totals product that does not exist as a tool error", parity: true do
      call_tool("get_sales_totals", { start_date: "2026-03-01", end_date: "2026-03-31", product_id: "nope" })
    end

    it "reports a sales totals product that was deleted as a tool error", parity: true do
      deleted = create(:product, user: seller, name: "Old pack", unique_permalink: "oldpack", deleted_at: Time.utc(2026, 3, 10))
      call_tool("get_sales_totals", { start_date: "2026-03-01", end_date: "2026-03-31", product_id: deleted.unique_permalink })
    end

    describe "sales totals by country" do
      before do
        sell(product, email: "dee@example.com", price_cents: 4000, at: [2026, 3, 10, 9], country: "Germany")
        sell(product, email: "eve@example.com", price_cents: 300, at: [2026, 3, 11, 9], country: "USA")
        sell(other_product, email: "fay@example.com", price_cents: 200, at: [2026, 3, 12, 9], country: "United States")
        sell(other_product, email: "gus@example.com", price_cents: 1200, at: [2026, 3, 13, 9], country: " ", ip_country: "France")
      end

      it "reports sales totals by country", parity: true do
        call_tool("get_sales_totals", { start_date: "2026-03-01", end_date: "2026-03-31", breakdown: "country" })
      end

      it "hands back a country breakdown with two countries that earned the same", parity: true do
        sell(other_product, email: "hal@example.com", price_cents: 4000, at: [2026, 3, 14, 9], country: "Japan")
        call_tool("get_sales_totals", { start_date: "2026-03-01", end_date: "2026-03-31", breakdown: "country" })
      end

      it "hands back a country breakdown with a country the list does not know", parity: true do
        sell(other_product, email: "ivy@example.com", price_cents: 1, at: [2026, 3, 15, 9], country: "Atlantis")
        call_tool("get_sales_totals", { start_date: "2026-03-01", end_date: "2026-03-31", breakdown: "country" })
      end
    end

    %w[day week month].each do |breakdown|
      it "reports sales totals by #{breakdown}", parity: true do
        call_tool("get_sales_totals", { start_date: "2026-02-20", end_date: "2026-03-31", breakdown: })
      end
    end

    it "reports sales totals by day across a daylight saving change in the seller's zone", parity: true do
      # US daylight saving began 2026-03-08 at 10:00 UTC; the sales sit on the hour on both sides of it and of the next local midnight.
      seller.update!(timezone: "Pacific Time (US & Canada)")
      sell(product, email: "dee@example.com", price_cents: 900, at: [2026, 3, 8, 9])
      sell(product, email: "eve@example.com", price_cents: 800, at: [2026, 3, 8, 10])
      sell(product, email: "fay@example.com", price_cents: 700, at: [2026, 3, 9, 6])
      sell(product, email: "gus@example.com", price_cents: 600, at: [2026, 3, 9, 7])
      call_tool("get_sales_totals", { start_date: "2026-03-01", end_date: "2026-03-10", breakdown: "day" })
    end

    it "reports sales totals by week for one product, excluding refunds and bundle members", parity: true do
      sell(product, email: "dee@example.com", price_cents: 300, at: [2026, 3, 16, 9], is_bundle_product_purchase: true)
      sell(product, email: "eve@example.com", price_cents: 300, at: [2026, 3, 17, 9], chargeback_date: Time.utc(2026, 3, 20))
      call_tool("get_sales_totals", { start_date: "2026-03-01", end_date: "2026-03-31", breakdown: "week", product_id: product.external_id })
    end

    describe "list_products" do
      def list_products(arguments = {}) = call_tool("list_products", arguments, scopes: "view_public")

      before do
        product.update_columns(created_at: Time.utc(2026, 3, 4, 10))
        other_product.update_columns(created_at: Time.utc(2026, 3, 5, 10))
      end

      it "lists the products newest first with their price and storefront url", parity: true do
        create(:product, user: seller, name: "Pay what you want", unique_permalink: "pwywpack", customizable_price: true, suggested_price_cents: 900, price_cents: 500, custom_permalink: "pwyw", created_at: Time.utc(2026, 3, 6, 10))
        create(:product, user: seller, name: "Unreleased", unique_permalink: "draftone", draft: true, created_at: Time.utc(2026, 3, 3, 10))
        list_products
      end

      it "lists a page of products and the cursor of the next", parity: true do
        list_products({ limit: 1 })
      end

      it "lists the page after a cursor", parity: true do
        list_products({ cursor: "#{Time.utc(2026, 3, 5, 10).to_i * 1_000_000}_#{other_product.id}" })
      end

      it "leaves out a deleted product and another seller's product", parity: true do
        create(:product, user: seller, name: "Gone", unique_permalink: "gonepack", deleted_at: Time.utc(2026, 3, 8))
        create(:product, user: create(:user), name: "Not mine", unique_permalink: "notmine")
        list_products
      end

      it "reports the pay what you want state of a free product with no price row", parity: true do
        create(:product, user: seller, name: "Free pack", unique_permalink: "freepack", price_cents: 0, created_at: Time.utc(2026, 3, 6, 10))
        list_products({ limit: 1 })
      end

      it "refuses a products limit of 0", parity: true do
        list_products({ limit: 0 })
      end

      it "hands back a listing that includes a tiered membership", parity: true do
        create(:membership_product, user: seller, name: "Club", unique_permalink: "clubtier", created_at: Time.utc(2026, 3, 6, 10))
        list_products
      end

      it "hands back a listing that includes a recurring product", parity: true do
        create(:subscription_product, user: seller, name: "Monthly", created_at: Time.utc(2026, 3, 6, 10))
        list_products
      end
    end

    describe "list_sales" do
      let(:deal) { create(:offer_code, user: seller, code: "half", amount_percentage: 50, universal: true) }

      before do
        # Seeds are hour-granular in the fixture, so a sale whose time is printed must fall on the hour.
        Purchase.find_by!(email: "cy@example.com", price_cents: 700).update_columns(created_at: Time.utc(2026, 3, 2, 14))
        sell(product, email: "dee@example.com", price_cents: 1500, at: [2026, 3, 6, 10], fee_cents: 150, affiliate_credit_cents: 75, offer_code: deal, country: "Germany", referrer: "https://news.example.com", ip_country: "Canada")
        sell(other_product, email: "eve@example.com", price_cents: 2000, at: [2026, 3, 7, 10], country: nil, ip_country: "France", chargeback_date: Time.utc(2026, 3, 9))
      end

      it "lists the sales newest first", parity: true do
        call_tool("list_sales")
      end

      it "lists a page of sales and the cursor of the next", parity: true do
        call_tool("list_sales", { limit: 3 })
      end

      it "lists the page after a cursor", parity: true do
        call_tool("list_sales", { limit: 3, cursor: "#{Time.utc(2026, 3, 3, 10).to_i * 1_000_000}_#{Purchase.find_by!(email: 'bob@example.com').id}" })
      end

      it "lists the sales of a buyer and a product in a time range", parity: true do
        call_tool("list_sales", { email: " ada@example.com ", product_id: product.unique_permalink, after: "2026-03-02", before: "2026-03-05T10:00:00+02:00" })
      end

      it "lists only paid sales", parity: true do
        call_tool("list_sales", { payment: "paid" })
      end

      it "lists only free sales", parity: true do
        call_tool("list_sales", { payment: "free" })
      end

      it "lists membership charges apart from one-time sales", parity: true do
        membership = create(:product, user: seller, name: "Club", unique_permalink: "clubpass", is_recurring_billing: true, subscription_duration: "monthly")
        subscription = create(:subscription, link: membership, user: nil)
        plan = create(:subscription, link: other_product, user: nil)
        plan.update_columns(flags: plan.flags | Subscription.flag_mapping["flags"][:is_installment_plan])
        sell(membership, email: "kim@example.com", price_cents: 500, at: [2026, 3, 20, 10]).update_columns(subscription_id: subscription.id)
        sell(other_product, email: "lee@example.com", price_cents: 400, at: [2026, 3, 21, 10]).update_columns(subscription_id: plan.id)
        call_tool("list_sales", { kind: "subscription" })
      end

      it "lists everything that is not a membership charge as one-time", parity: true do
        membership = create(:product, user: seller, name: "Club", unique_permalink: "clubpass", is_recurring_billing: true, subscription_duration: "monthly")
        sell(membership, email: "kim@example.com", price_cents: 500, at: [2026, 3, 20, 10]).update_columns(subscription_id: create(:subscription, link: membership, user: nil).id)
        call_tool("list_sales", { kind: "one_time" })
      end

      it "lists the UTM fields of a sale driven by a UTM link", parity: true do
        link = create(:utm_link, seller:, utm_source: "newsletter", utm_medium: "email", utm_campaign: "spring", utm_term: "sketch", utm_content: "hero")
        visit = create(:utm_link_visit, utm_link: link)
        create(:utm_link_driven_sale, utm_link: link, utm_link_visit: visit, purchase: Purchase.find_by!(email: "dee@example.com"))
        call_tool("list_sales", { limit: 1 })
      end

      it "reports a sales product that does not exist as a tool error", parity: true do
        call_tool("list_sales", { product_id: "nope" })
      end

      it "refuses a sales limit above 50", parity: true do
        call_tool("list_sales", { limit: 51 })
      end

      it "refuses a sales cursor that is not valid", parity: true do
        call_tool("list_sales", { cursor: "later" })
      end

      it "hands back a sales time that is not a date or a whole-second time", parity: true do
        call_tool("list_sales", { after: "last tuesday" })
      end

      it "hands back a sale that has two UTM links", parity: true do
        sale = Purchase.find_by!(email: "dee@example.com")
        2.times do |index|
          link = create(:utm_link, seller:, utm_source: "src#{index}", utm_campaign: "spring#{index}")
          create(:utm_link_driven_sale, utm_link: link, utm_link_visit: create(:utm_link_visit, utm_link: link), purchase: sale)
        end
        call_tool("list_sales", { limit: 2 })
      end
    end
  end

  describe "Notion unfurl" do
    it "refuses a request without a token", parity: true do
      post "/notion/unfurl", params: { uri: "https://dude.test.gumroad.com:31337/l/abc" }
    end

    it "reports a missing uri", parity: true do
      post "/notion/unfurl", headers: auth("unfurl")
    end

    it "hands back a link preview", parity: true do
      product = create(:product, user: seller, unique_permalink: "sketchpk")
      post "/notion/unfurl", params: { uri: "#{seller.subdomain_with_protocol}/l/#{product.unique_permalink}" }, headers: auth("unfurl")
    end

    it "acknowledges a removal", parity: true do
      delete "/notion/unfurl"
    end
  end
end
