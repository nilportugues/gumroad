# frozen_string_literal: true

require "spec_helper"

# Api::V2::UtmLinksController through the full Rack stack, recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/api-v2-ws17c.replay.test.ts.
describe "API v2 UTM links", type: :request do
  let(:seller) { create(:user, username: "dude", name: "Dude") }
  let(:application) { create(:oauth_application, owner: create(:user)) }
  let!(:product) { create(:product, user: seller, name: "Sketch pack", unique_permalink: "sketchpk") }

  before { host! API_DOMAIN }

  def token_for(scopes) = create("doorkeeper/access_token", application:, resource_owner_id: seller.id, scopes:).token
  def auth(scopes) = { "Authorization" => "Bearer #{token_for(scopes)}" }

  describe "GET /v2/utm_links" do
    it "lists the seller's live links newest first with their targets", parity: true do
      create(:utm_link, seller:, title: "Profile", created_at: 3.days.ago)
      create(:utm_link, seller:, title: "Product", target_resource_type: :product_page, target_resource_id: product.id, utm_term: "spring", utm_content: "banner", created_at: 2.days.ago, total_clicks: 12, unique_clicks: 7)
      create(:utm_link, seller:, title: "Subscribe", target_resource_type: :subscribe_page, disabled_at: Time.current, created_at: 1.day.ago)
      create(:utm_link, seller:, title: "Gone", deleted_at: Time.current)
      create(:utm_link, title: "Someone else's")
      get "/v2/utm_links", headers: auth("view_public")
    end

    it "lists nothing for a seller without links", parity: true do
      get "/v2/utm_links", headers: auth("view_public")
    end

    it "serves /api/v2 on the main domain", parity: true do
      host! DOMAIN
      create(:utm_link, seller:, title: "Profile")
      get "/api/v2/utm_links", headers: auth("view_public")
    end

    it "refuses a request without a token", parity: true do
      get "/v2/utm_links"
    end
  end

  describe "GET /v2/utm_links/:id" do
    it "returns the link", parity: true do
      link = create(:utm_link, seller:, title: "Product", target_resource_type: :product_page, target_resource_id: product.id)
      get "/v2/utm_links/#{link.external_id}", headers: auth("view_public")
    end

    it "reports a link that does not exist", parity: true do
      get "/v2/utm_links/nonexistent", headers: auth("view_public")
    end

    it "reports another seller's link as missing", parity: true do
      get "/v2/utm_links/#{create(:utm_link).external_id}", headers: auth("view_public")
    end

    it "reports a deleted link as missing", parity: true do
      get "/v2/utm_links/#{create(:utm_link, seller:, deleted_at: Time.current).external_id}", headers: auth("view_public")
    end
  end

  describe "POST /v2/utm_links" do
    let(:params) { { title: "Launch", target_resource_type: "profile_page", utm_source: "twitter", utm_medium: "social", utm_campaign: "launch" } }

    it "creates a link to the profile page", parity: true do
      post "/v2/utm_links", params:, headers: auth("edit_products")
    end

    it "creates a link to one of the seller's products", parity: true do
      post "/v2/utm_links", params: params.merge(target_resource_type: "product_page", target_resource_id: product.external_id, utm_term: "spring", utm_content: "banner"), headers: auth("edit_products")
    end

    it "creates a link to a subscribe page from a JSON body", parity: true do
      post "/v2/utm_links", params: params.merge(target_resource_type: "subscribe_page").to_json, headers: auth("edit_products").merge("Content-Type" => "application/json")
    end

    it "does not point a link at another seller's product", parity: true do
      other = create(:product)
      post "/v2/utm_links", params: params.merge(target_resource_type: "product_page", target_resource_id: other.external_id), headers: auth("edit_products")
    end

    it "requires the UTM fields and a title", parity: true do
      post "/v2/utm_links", params: { target_resource_type: "profile_page" }, headers: auth("edit_products")
    end

    it "rejects an unknown target type", parity: true do
      post "/v2/utm_links", params: params.merge(target_resource_type: "nowhere"), headers: auth("edit_products")
    end

    it "rejects a UTM field over the length limit", parity: true do
      post "/v2/utm_links", params: params.merge(utm_source: "s" * 201), headers: auth("edit_products")
    end

    it "rejects a duplicate destination with the same UTM fields", parity: true do
      create(:utm_link, seller:, utm_source: "twitter", utm_medium: "social", utm_campaign: "launch")
      post "/v2/utm_links", params:, headers: auth("edit_products")
    end

    it "ignores a UTM parameter that is not a string", parity: true do
      post "/v2/utm_links", params: params.merge(utm_term: { a: "b" }), headers: auth("edit_products")
    end

    it "forbids a view_public token", parity: true do
      post "/v2/utm_links", params:, headers: auth("view_public")
    end
  end

  describe "PATCH /v2/utm_links/:id" do
    let!(:link) { create(:utm_link, seller:, title: "Old", utm_source: "twitter", utm_medium: "social", utm_campaign: "launch") }

    it "updates the title and UTM fields", parity: true do
      patch "/v2/utm_links/#{link.external_id}", params: { title: "New", utm_source: "mastodon", utm_term: "t" }, headers: auth("edit_products")
    end

    it "accepts PUT", parity: true do
      put "/v2/utm_links/#{link.external_id}", params: { title: "Put" }, headers: auth("edit_products")
    end

    it "does not change the destination", parity: true do
      patch "/v2/utm_links/#{link.external_id}", params: { target_resource_type: "product_page", target_resource_id: product.external_id }, headers: auth("edit_products")
    end

    it "rejects a blank title", parity: true do
      patch "/v2/utm_links/#{link.external_id}", params: { title: "" }, headers: auth("edit_products")
    end

    it "rejects fields another link already uses", parity: true do
      create(:utm_link, seller:, utm_source: "mastodon", utm_medium: "social", utm_campaign: "launch")
      patch "/v2/utm_links/#{link.external_id}", params: { utm_source: "mastodon" }, headers: auth("edit_products")
    end

    it "reports a missing link", parity: true do
      patch "/v2/utm_links/missing", params: { title: "x" }, headers: auth("edit_products")
    end
  end

  describe "disable, enable and delete" do
    let!(:link) { create(:utm_link, seller:, title: "Toggle") }

    it "disables a link", parity: true do
      put "/v2/utm_links/#{link.external_id}/disable", headers: auth("edit_products")
    end

    it "enables a disabled link", parity: true do
      link.update!(disabled_at: 1.day.ago)
      put "/v2/utm_links/#{link.external_id}/enable", headers: auth("edit_products")
    end

    it "deletes a link", parity: true do
      delete "/v2/utm_links/#{link.external_id}", headers: auth("edit_products")
    end

    it "reports a missing link when disabling", parity: true do
      put "/v2/utm_links/missing/disable", headers: auth("edit_products")
    end

    it "forbids deleting with a view_public token", parity: true do
      delete "/v2/utm_links/#{link.external_id}", headers: auth("view_public")
    end
  end
end
