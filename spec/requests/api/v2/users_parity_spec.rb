# frozen_string_literal: true

require "spec_helper"

# Api::V2::UsersController through the full Rack stack, recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/api-v2-users.replay.test.ts. The IFTTT routes are the same actions under /ifttt/v1 on the main host.
describe "API v2 user", type: :request do
  let(:seller) { create(:user, username: "dude", name: "Dude", bio: "Makes things", email: "dude@example.com") }
  let(:application) { create(:oauth_application, owner: create(:user)) }

  before { host! API_DOMAIN }

  def token_for(owner = seller, scopes: "view_public")
    create("doorkeeper/access_token", application:, resource_owner_id: owner.id, scopes:).token
  end

  # The factory charges a card; the endpoint only reads the row.
  def purchase_row(**attributes) = build(:purchase, price_cents: 100, fee_cents: 30, **attributes).tap { _1.save!(validate: false) }

  def auth(token) = { "Authorization" => "Bearer #{token}" }

  describe "GET /v2/user" do
    it "returns the public fields for a view_public token", parity: true do
      create(:product, user: seller, unique_permalink: "first")
      get "/v2/user", headers: auth(token_for)
    end

    it "adds the email for a view_sales token", parity: true do
      get "/v2/user", headers: auth(token_for(scopes: "view_sales"))
    end

    it "adds the display name and SEO fields for a view_profile token", parity: true do
      seller.seller_profile.update!(seo_title: "A title", seo_description: "A description")
      get "/v2/user", headers: auth(token_for(scopes: "view_profile"))
    end

    it "serves the same action under /api on the main domain", parity: true do
      host! DOMAIN
      get "/api/v2/user", params: { access_token: token_for(scopes: "account") }
    end

    it "refuses a request without a token", parity: true do
      get "/v2/user"
    end

    it "refuses a token whose owner was deleted", parity: true do
      token = token_for
      seller.update_columns(deleted_at: Time.current)
      get "/v2/user", headers: auth(token)
    end
  end

  describe "GET /v2/user/theme" do
    it "returns the store theme", parity: true do
      seller.seller_profile.update!(background_color: "#ff90e8", highlight_color: "#000000", font: "Inter")
      get "/v2/user/theme", headers: auth(token_for)
    end
  end

  describe "GET /v2/user/profile_layout" do
    it "returns the tabs and sections with their headers", parity: true do
      section = create(:seller_profile_products_section, seller:, header: "Albums")
      hidden = create(:seller_profile_products_section, seller:, header: "Secret", hide_header: true)
      seller.seller_profile.update!(json_data: { "tabs" => [{ "name" => "Music", "sections" => [section.id, hidden.id, 0] }, { "name" => "Other", "sections" => [] }] })
      get "/v2/user/profile_layout", headers: auth(token_for(scopes: "view_profile"))
    end

    it "offers the default products tab when the seller made none", parity: true do
      create(:product, user: seller)
      get "/v2/user/profile_layout", headers: auth(token_for(scopes: "view_profile"))
    end

    it "forbids an account token", parity: true do
      get "/v2/user/profile_layout", headers: auth(token_for(scopes: "account"))
    end

    it "forbids a view_public token", parity: true do
      get "/v2/user/profile_layout", headers: auth(token_for)
    end
  end

  describe "PUT /v2/user" do
    it "updates the name and bio", parity: true do
      put "/v2/user", params: { name: "New name", bio: "New bio" }, headers: auth(token_for(scopes: "edit_profile"))
    end

    it "accepts PATCH", parity: true do
      patch "/v2/user", params: { bio: "Patched" }, headers: auth(token_for(scopes: "account"))
    end

    it "hands back a SEO field update", parity: true do
      put "/v2/user", params: { name: "With SEO", seo_title: "Title", seo_description: "Description" }, headers: auth(token_for(scopes: "edit_profile"))
    end

    it "rejects a SEO field that is not a string", parity: true do
      put "/v2/user", params: { seo_title: { a: "b" } }, headers: auth(token_for(scopes: "edit_profile"))
    end

    it "reports validation errors", parity: true do
      put "/v2/user", params: { name: "x" * 200 }, headers: auth(token_for(scopes: "edit_profile"))
    end

    it "asks an unconfirmed seller to confirm their email", parity: true do
      seller.update_columns(confirmed_at: nil)
      put "/v2/user", params: { name: "Nope" }, headers: auth(token_for(scopes: "edit_profile"))
    end

    it "accepts a JSON body", parity: true do
      put "/v2/user", params: { name: "From JSON" }.to_json, headers: auth(token_for(scopes: "edit_profile")).merge("Content-Type" => "application/json")
    end

    it "forbids a token without edit_profile", parity: true do
      put "/v2/user", params: { name: "No" }, headers: auth(token_for)
    end
  end

  describe "custom HTML" do
    before { Feature.activate_user(:custom_html_pages, seller) }

    it "returns the stored page", parity: true do
      Page.new(pageable: seller, custom_html: "<p>Hello</p>").save!(validate: false)
      get "/v2/user/custom_html", headers: auth(token_for)
    end

    it "hands back the default profile render when no page is stored", parity: true do
      get "/v2/user/custom_html", headers: auth(token_for)
    end

    it "refuses a seller without the feature", parity: true do
      Feature.deactivate_user(:custom_html_pages, seller)
      get "/v2/user/custom_html", headers: auth(token_for)
    end

    it "requires the custom_html parameter", parity: true do
      put "/v2/user/custom_html", params: {}, headers: auth(token_for(scopes: "edit_profile"))
    end

    it "rejects a custom_html that is not a string", parity: true do
      put "/v2/user/custom_html", params: { custom_html: ["a"] }, headers: auth(token_for(scopes: "edit_profile"))
    end

    it "rejects oversized custom HTML", parity: true do
      put "/v2/user/custom_html", params: { custom_html: "a" * (Page::MAX_CUSTOM_HTML_LENGTH + 1) }, headers: auth(token_for(scopes: "edit_profile"))
    end

    it "asks an unconfirmed seller to confirm their email", parity: true do
      seller.update_columns(confirmed_at: nil)
      put "/v2/user/custom_html", params: { custom_html: "<p>x</p>" }, headers: auth(token_for(scopes: "edit_profile"))
    end

    it "hands back a valid custom HTML write", parity: true do
      put "/v2/user/custom_html", params: { custom_html: "<p>Hello</p>" }, headers: auth(token_for(scopes: "edit_profile"))
    end

    it "hands back a valid targeted edit", parity: true do
      Page.new(pageable: seller, custom_html: "<p>Hello</p>").save!(validate: false)
      post "/v2/user/custom_html/edit", params: { find: "Hello", replace: "Bye" }, headers: auth(token_for(scopes: "edit_profile"))
    end

    it "hands back a valid preview", parity: true do
      post "/v2/user/preview_custom_html", params: { custom_html: "<p>Hello</p>" }, headers: auth(token_for(scopes: "edit_profile"))
    end

    it "requires find for a targeted edit", parity: true do
      post "/v2/user/custom_html/edit", params: { replace: "x" }, headers: auth(token_for(scopes: "edit_profile"))
    end

    it "requires replace for a targeted edit", parity: true do
      post "/v2/user/custom_html/edit", params: { find: "x" }, headers: auth(token_for(scopes: "edit_profile"))
    end

    it "requires custom_html for a preview", parity: true do
      post "/v2/user/preview_custom_html", params: {}, headers: auth(token_for(scopes: "edit_profile"))
    end

    it "refuses a seller without the feature for a preview", parity: true do
      Feature.deactivate_user(:custom_html_pages, seller)
      post "/v2/user/preview_custom_html", params: { custom_html: "<p>x</p>" }, headers: auth(token_for(scopes: "edit_profile"))
    end
  end

  describe "IFTTT" do
    before { host! DOMAIN }

    it "reports its status without a token", parity: true do
      get "/ifttt/v1/status"
    end

    it "returns the user as data", parity: true do
      get "/ifttt/v1/user/info", headers: auth(token_for(scopes: "ifttt"))
    end

    it "falls back to the email when the user has no name", parity: true do
      seller.update_columns(name: nil)
      get "/ifttt/v1/user/info", headers: auth(token_for(scopes: "ifttt"))
    end

    it "hands back the sale trigger newest first", parity: true do
      product = create(:product, user: seller, name: "Sketch pack")
      purchase_row(link: product, seller:, email: "one@example.com", created_at: Time.utc(2024, 3, 1, 12))
      purchase_row(link: product, seller:, email: "two@example.com", created_at: Time.utc(2024, 3, 2, 12))
      post "/ifttt/v1/triggers/sale", params: { limit: 5 }, headers: auth(token_for(scopes: "ifttt"))
    end

    it "hands back the sale trigger after a time", parity: true do
      product = create(:product, user: seller, name: "Sketch pack")
      purchase_row(link: product, seller:, email: "one@example.com", created_at: Time.utc(2024, 3, 1, 12))
      purchase_row(link: product, seller:, email: "two@example.com", created_at: Time.utc(2024, 3, 2, 12))
      post "/ifttt/v1/triggers/sale", params: { after: Time.utc(2024, 3, 2).to_i }, headers: auth(token_for(scopes: "ifttt"))
    end

    it "hands back the sale trigger before a time", parity: true do
      product = create(:product, user: seller, name: "Sketch pack")
      purchase_row(link: product, seller:, email: "one@example.com", created_at: Time.utc(2024, 3, 1, 12))
      purchase_row(link: product, seller:, email: "two@example.com", created_at: Time.utc(2024, 3, 2, 12))
      post "/ifttt/v1/triggers/sale", params: { before: Time.utc(2024, 3, 2).to_i }, headers: auth(token_for(scopes: "ifttt"))
    end
  end
end
