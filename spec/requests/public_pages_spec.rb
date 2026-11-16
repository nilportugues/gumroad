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

    it "lists the products a seller promotes as a direct affiliate, newest affiliation first", parity: true do
      older = create(:product, name: "Older promoted", unique_permalink: "olderpr", custom_permalink: "older-custom")
      newer = create(:product, name: "Newer promoted", unique_permalink: "newerpr")
      create(:direct_affiliate, affiliate_user: seller, seller: older.user, products: [older], created_at: 3.days.ago)
      create(:direct_affiliate, affiliate_user: seller, seller: newer.user, products: [newer], created_at: 1.day.ago)
      removed = create(:product, name: "Removed promoted", unique_permalink: "removedp")
      create(:direct_affiliate, affiliate_user: seller, seller: removed.user, products: [removed], deleted_at: Time.current)
      unlisted = create(:product, name: "Banned promoted", unique_permalink: "bannedpr", banned_at: Time.current)
      create(:direct_affiliate, affiliate_user: seller, seller: unlisted.user, products: [unlisted])
      create(:product, user: seller, name: "Own product")
      log_in(seller, token_path: "/ping")

      get "/widgets"

      expect(response).to be_successful
      props = inertia_props_of(response)
      expect(props["affiliated_products"].map { _1["name"] }).to eq(["Newer promoted", "Older promoted"])
      expect(props["affiliated_products"].first["url"]).to eq(props["affiliated_products"].first["gumroad_domain_url"])
      expect(props["products"].map { _1["name"] }).to eq(["Own product"])
    end

    it "leaves out products the seller collaborates on", parity: true do
      collab_product = create(:product, name: "Collab product", unique_permalink: "collabpr")
      create(:collaborator, affiliate_user: seller, seller: collab_product.user, products: [collab_product])
      log_in(seller, token_path: "/ping")

      get "/widgets"

      expect(response).to be_successful
      expect(inertia_props_of(response)["affiliated_products"]).to eq([])
    end

    it "lists affiliated products for a seller without products of their own", parity: true do
      promoted = create(:product, name: "Only promoted", unique_permalink: "onlypro")
      create(:direct_affiliate, affiliate_user: seller, seller: promoted.user, products: [promoted])
      log_in(seller, token_path: "/ping")

      get "/widgets"

      expect(response).to be_successful
      props = inertia_props_of(response)
      expect(props["affiliated_products"].map { _1["name"] }).to eq(["Only promoted"])
      expect(props["products"].map { _1["name"] }).to eq(["Demo product"])
    end
  end
end
