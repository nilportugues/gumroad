# frozen_string_literal: true

require "spec_helper"

# Api::V2::HelpArticlesController through the full Rack stack, recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/api-v2-ws17c.replay.test.ts.
describe "API v2 help articles", type: :request do
  let(:seller) { create(:user) }
  let(:application) { create(:oauth_application, owner: create(:user)) }
  let(:headers) { { "Authorization" => "Bearer #{create("doorkeeper/access_token", application:, resource_owner_id: seller.id, scopes: "view_public").token}" } }

  before { host! API_DOMAIN }

  describe "GET /v2/help/articles" do
    it "lists every article without its body", parity: true do
      get "/v2/help/articles", headers:
    end

    it "searches the whole text of the articles", parity: true do
      get "/v2/help/articles", params: { query: "payout schedule" }, headers:
    end

    it "drops the function words of a question", parity: true do
      get "/v2/help/articles", params: { query: "how do I change my profile colors?" }, headers:
    end

    it "keeps a query made only of function words", parity: true do
      get "/v2/help/articles", params: { query: "how do I" }, headers:
    end

    it "lists everything for a blank query", parity: true do
      get "/v2/help/articles", params: { query: "  " }, headers:
    end

    it "finds nothing for words no article uses", parity: true do
      get "/v2/help/articles", params: { query: "zzzxqj" }, headers:
    end

    it "serves /api/v2 on the main domain", parity: true do
      host! DOMAIN
      get "/api/v2/help/articles", params: { query: "refund" }, headers:
    end

    it "refuses a request without a token", parity: true do
      get "/v2/help/articles"
    end
  end

  describe "GET /v2/help/articles/:slug" do
    it "returns an article as plain text", parity: true do
      get "/v2/help/articles/37-how-to-delete-your-gumroad-account", headers:
    end

    it "truncates an article past the limit with a pointer to the live page", parity: true do
      get "/v2/help/articles/74-the-analytics-dashboard", headers:
    end

    it "returns an article that holds a list of links", parity: true do
      get "/v2/help/articles/13-getting-paid", headers:
    end

    it "reports an article that does not exist", parity: true do
      get "/v2/help/articles/nope", headers:
    end
  end
end
