# frozen_string_literal: true

require "spec_helper"

# The public developer and lookup pages (PublicController), recorded for the Next.js port
# (PARITY_RECORD=1). Replayed by nextjs/parity/__tests__/public-pages.replay.test.ts.
describe "Public pages", type: :request do
  include Parity::SignedInRequests

  before { host! DOMAIN }

  describe "when signed out" do
    %w[/api /ping /charge /license-key-lookup].each do |path|
      it "renders #{path} without a content security policy", parity: true do
        get path

        expect(response).to be_successful
        expect(response.headers).not_to include("Content-Security-Policy")
        expect(inertia_props_of(response)).to include("title")
      end
    end
  end

  describe "when signed in" do
    let(:seller) { create(:user, name: "Signed In Seller") }

    %w[/api /ping /charge /license-key-lookup].each do |path|
      it "renders #{path} for a seller", parity: true do
        log_in(seller, token_path: path)

        get path

        expect(response).to be_successful
        expect(inertia_props_of(response)["logged_in_user"]).to include("email" => seller.email)
      end
    end

    it "answers an Inertia visit with the page as JSON", parity: true do
      log_in(seller, token_path: "/ping")

      get "/ping", headers: { "X-Inertia" => "true", "X-Requested-With" => "XMLHttpRequest" }

      expect(response).to be_successful
      expect(response.parsed_body["component"]).to eq("Public/Ping")
    end
  end

  describe "widgets" do
    let(:seller) { create(:user, name: "Signed In Seller") }
    let!(:demo_product) { create(:product, unique_permalink: "demo", name: "Demo product", user: create(:named_seller)) }

    it "shows the demo product to a visitor", parity: true do
      get "/widgets"

      expect(response).to be_successful
      props = inertia_props_of(response)
      expect(props).to include("display_product_select" => false, "affiliated_products" => [])
      expect(props["default_product"]).to include("name" => "Demo product")
    end

    it "falls back to the demo product for a seller without products", parity: true do
      log_in(seller, token_path: "/ping")

      get "/widgets"

      expect(response).to be_successful
      expect(inertia_props_of(response)).to include("display_product_select" => true)
    end

    it "lists a seller's live products, newest first", parity: true do
      create(:product, user: seller, name: "Older", created_at: 2.days.ago)
      create(:product, user: seller, name: "Newer", custom_permalink: "newer", created_at: 1.day.ago)
      create(:product, user: seller, name: "Deleted", deleted_at: Time.current)
      log_in(seller, token_path: "/ping")

      get "/widgets"

      expect(response).to be_successful
      props = inertia_props_of(response)
      expect(props["products"].map { _1["name"] }).to eq(%w[Newer Older])
      expect(props["default_product"]["name"]).to eq("Newer")
    end
  end
end
