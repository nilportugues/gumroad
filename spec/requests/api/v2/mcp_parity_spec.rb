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

    it "hands back a JSON-RPC call", parity: true do
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

    it "hands back a sales totals breakdown by country", parity: true do
      call_tool("get_sales_totals", { start_date: "2026-03-01", end_date: "2026-03-31", breakdown: "country" })
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
