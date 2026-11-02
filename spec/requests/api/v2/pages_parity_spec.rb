# frozen_string_literal: true

require "spec_helper"

# Api::V2::PagesController through the full Rack stack, recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/api-v2-ws17c.replay.test.ts.
describe "API v2 pages", type: :request do
  let(:seller) { create(:user, username: "dude", name: "Dude", email: "dude@example.com") }
  let(:application) { create(:oauth_application, owner: create(:user)) }

  before { host! API_DOMAIN }

  def auth(scopes = "view_public") = { "Authorization" => "Bearer #{create("doorkeeper/access_token", application:, resource_owner_id: seller.id, scopes:).token}" }

  # Page validation moderates the content, which the endpoint under test does not do for reads.
  def page_row(**attributes) = Page.new(pageable: seller, **attributes).tap { _1.save!(validate: false) }

  describe "GET /v2/pages" do
    it "lists the seller's slugged pages with their content", parity: true do
      page_row(slug: "about", title: "About", content: "Hello", seo_title: "About me", created_at: 2.days.ago)
      page_row(slug: "shop", title: "Shop", custom_html: "<p>Shop</p>", created_at: 1.day.ago)
      page_row(slug: nil, custom_html: "<p>Root</p>")
      Page.new(pageable: create(:user), slug: "other", title: "Other").save!(validate: false)
      get "/v2/pages", headers: auth
    end

    it "lists only the metadata", parity: true do
      page_row(slug: "about", title: "About", content: "Hello")
      get "/v2/pages", params: { metadata_only: "true" }, headers: auth
    end

    it "lists nothing for a seller without pages", parity: true do
      get "/v2/pages", headers: auth
    end

    it "serves /api/v2 on the main domain", parity: true do
      host! DOMAIN
      page_row(slug: "about", title: "About")
      get "/api/v2/pages", headers: auth
    end

    it "refuses a request without a token", parity: true do
      get "/v2/pages"
    end
  end

  describe "GET /v2/pages/:id" do
    it "returns a custom HTML page with its document", parity: true do
      page_row(slug: "shop", title: "Shop", custom_html: "<p>Shop</p>")
      get "/v2/pages/shop", headers: auth
    end

    it "returns only the source when asked", parity: true do
      page_row(slug: "about", title: "About", content: "Hello")
      get "/v2/pages/about", params: { source_only: "true" }, headers: auth
    end

    it "hands back the rendered document of a rich text page", parity: true do
      page_row(slug: "about", title: "About", content: "Hello")
      get "/v2/pages/about", headers: auth
    end

    it "reports a page that does not exist", parity: true do
      get "/v2/pages/nope", headers: auth
    end

    it "does not serve the profile root page", parity: true do
      page_row(slug: nil, custom_html: "<p>Root</p>")
      get "/v2/pages/profile", headers: auth
    end
  end

  describe "writes" do
    it "requires a title", parity: true do
      post "/v2/pages", params: { content: "x" }, headers: auth("edit_profile")
    end

    it "refuses content and custom_html together", parity: true do
      post "/v2/pages", params: { title: "T", content: "x", custom_html: "<p>x</p>" }, headers: auth("edit_profile")
    end

    it "refuses content that is not a string", parity: true do
      post "/v2/pages", params: { title: "T", content: ["x"] }, headers: auth("edit_profile")
    end

    it "refuses a SEO field that is not a string", parity: true do
      post "/v2/pages", params: { title: "T", seo_title: { a: 1 } }, headers: auth("edit_profile")
    end

    it "refuses custom_html without the feature", parity: true do
      post "/v2/pages", params: { title: "T", custom_html: "<p>x</p>" }, headers: auth("edit_profile")
    end

    it "forbids an account token", parity: true do
      post "/v2/pages", params: { title: "T" }, headers: auth("account")
    end

    it "asks an unconfirmed seller to confirm their email", parity: true do
      seller.update_columns(confirmed_at: nil)
      post "/v2/pages", params: { title: "T" }, headers: auth("edit_profile")
    end

    it "hands back a valid page", parity: true do
      post "/v2/pages", params: { title: "About me", content: "Hello" }, headers: auth("edit_profile")
    end

    it "hands back a valid update", parity: true do
      page_row(slug: "about", title: "About", content: "Hello")
      patch "/v2/pages/about", params: { title: "New title" }, headers: auth("edit_profile")
    end

    it "reports an update of a page that does not exist", parity: true do
      patch "/v2/pages/nope", params: { title: "x" }, headers: auth("edit_profile")
    end

    it "hands back a deletion", parity: true do
      page_row(slug: "about", title: "About", content: "Hello")
      delete "/v2/pages/about", headers: auth("edit_profile")
    end

    it "reports a deletion of a page that does not exist", parity: true do
      delete "/v2/pages/nope", headers: auth("edit_profile")
    end
  end
end
