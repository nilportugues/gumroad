# frozen_string_literal: true

require "spec_helper"

# The seller storefront pages on a seller subdomain or custom domain (UsersController#show and
# #subscribe, AffiliateRequestsController#new), recorded for the Next.js port (PARITY_RECORD=1).
# Replayed by nextjs/parity/__tests__/storefront-profile.replay.test.ts.
describe "Storefront pages", type: :request do
  let(:seller) { create(:named_seller, name: "Parity Seller", bio: "Makes things.") }
  let(:seller_host) { seller.subdomain }

  before { host! seller_host }

  def inertia_page(response)
    page = response.body[/<script[^>]*data-page="[^"]*"[^>]*>(.*?)<\/script>/m, 1] || CGI.unescapeHTML(response.body[/\sdata-page="([^"]*)"/, 1])
    JSON.parse(page)
  end

  describe "the profile" do
    it "renders a profile with no sections and no products", parity: true do
      get "/"

      expect(response).to be_successful
      expect(inertia_page(response)["component"]).to eq("Users/Show")
      expect(inertia_page(response)["props"]["sections"]).to eq([])
    end

    it "sends a noindex header for a storefront nobody has vouched for", parity: true do
      get "/"

      expect(response.headers["X-Robots-Tag"]).to eq("noindex")
    end

    it "leaves a compliant seller's profile indexable", parity: true do
      seller.update!(user_risk_state: "compliant")

      get "/"

      expect(response).to be_successful
      expect(response.headers["X-Robots-Tag"]).to be_nil
    end

    it "renders rich text, subscribe and posts sections in their tabs", parity: true do
      post_record = create(:audience_post, :published, seller:, shown_on_profile: true, name: "On the profile", message: "<p>Body</p>")
      create(:audience_post, :published, seller:, shown_on_profile: false, name: "Hidden", message: "<p>Hidden</p>")
      text = create(:seller_profile_rich_text_section, seller:, header: "About", text: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Hello" }] }] })
      subscribe = create(:seller_profile_subscribe_section, seller:)
      posts = create(:seller_profile_posts_section, seller:, header: "Writing", shown_posts: [post_record.id])
      hidden = create(:seller_profile_rich_text_section, seller:, header: "Hidden header", hide_header: true, text: { type: "doc", content: [] })
      seller.seller_profile.json_data[:tabs] = [{ name: "Home", sections: [text.id, subscribe.id, hidden.id] }, { name: "Blog", sections: [posts.id] }]
      seller.seller_profile.save!

      get "/"

      expect(response).to be_successful
      props = inertia_page(response)["props"]
      expect(props["sections"].map { _1["type"] }).to eq(%w[SellerProfileRichTextSection SellerProfileSubscribeSection SellerProfilePostsSection SellerProfileRichTextSection])
      expect(props["tabs"].size).to eq(2)
    end

    it "serves one tab with every section when no tab points at one", parity: true do
      create(:seller_profile_rich_text_section, seller:, header: "About", text: { type: "doc", content: [] })
      seller.seller_profile.json_data[:tabs] = [{ name: "Empty", sections: [] }]
      seller.seller_profile.save!

      get "/"

      expect(response).to be_successful
      expect(inertia_page(response)["props"]["tabs"].map { _1["name"] }).to eq(["Empty"])
    end

    it "uses the seller's theme and SEO fields", parity: true do
      seller.seller_profile.update!(font: "Domine", highlight_color: "#ff0000", background_color: "#00ff00", seo_title: "A custom title", seo_description: "A custom description")

      get "/"

      expect(response).to be_successful
      expect(inertia_page(response)["props"]["_inertia_meta"].map { _1["headKey"] }).to include("custom_styles")
    end

    it "carries the seller's analytics ids", parity: true do
      seller.update!(google_analytics_id: "G-PARITY", facebook_pixel_id: "1234567890")

      get "/"

      expect(response).to be_successful
      expect(inertia_page(response)["props"]["seller_analytics"]["analytics"]["google_analytics_id"]).to eq("G-PARITY")
    end

    it "shows the ratings filter once a product shows reviews", parity: true do
      create(:product, user: seller, display_product_reviews: true, archived: true)

      get "/"

      expect(response).to be_successful
      expect(inertia_page(response)["props"]["show_ratings_filter"]).to eq(true)
    end

    it "is a 404 for a suspended seller", parity: true do
      seller.update_columns(user_risk_state: "suspended_for_fraud")

      get "/"

      expect(response).to have_http_status(:not_found)
    end

    it "sets a direct affiliate's cookie for a visit carrying ?affiliate_id=", parity: true do
      affiliate = create(:direct_affiliate, seller:)

      get "/", params: { affiliate_id: affiliate.external_id_numeric }

      expect(response).to be_successful
      expect(response.headers["Set-Cookie"].to_s).to include(affiliate.cookie_key)
    end

    it "sets a global affiliate's cookie for a visit carrying the short ?a= param", parity: true do
      affiliate = create(:user).global_affiliate

      get "/", params: { a: affiliate.external_id_numeric }

      expect(response).to be_successful
      expect(response.headers["Set-Cookie"].to_s).to include(affiliate.cookie_key)
    end

    it "sets no affiliate cookie for an unknown affiliate id", parity: true do
      get "/", params: { affiliate_id: 123_456 }

      expect(response).to be_successful
      expect(response.headers["Set-Cookie"].to_s).not_to include("_gumroad_affiliate_id_")
    end

    it "answers an Inertia visit with the page as JSON", parity: true do
      get "/", headers: { "X-Inertia" => "true", "X-Requested-With" => "XMLHttpRequest" }

      expect(response).to be_successful
      expect(response.parsed_body["component"]).to eq("Users/Show")
    end

    it "renders on a custom domain", parity: true do
      create(:custom_domain, user: seller, domain: "parity-seller.example.com")
      host! "parity-seller.example.com"

      get "/"

      expect(response).to be_successful
    end
  end

  describe "the subscribe page" do
    it "renders the subscribe form", parity: true do
      get "/subscribe"

      expect(response).to be_successful
      expect(inertia_page(response)["component"]).to eq("Users/Subscribe")
    end

    it "titles the page after the username for a seller without a name", parity: true do
      seller.update!(name: nil, bio: nil)

      get "/subscribe"

      expect(response).to be_successful
    end
  end

  describe "the affiliate request page" do
    it "renders when the seller has an enabled self-service affiliate product", parity: true do
      create(:self_service_affiliate_product, seller:, enabled: true)

      get "/affiliates"

      expect(response).to be_successful
      expect(inertia_page(response)["component"]).to eq("AffiliateRequests/New")
    end

    it "carries the success state of a submitted request", parity: true do
      create(:self_service_affiliate_product, seller:, enabled: true)

      get "/affiliates", params: { success: "true", requester_has_existing_account: "true", email: "affiliate@example.com" }

      expect(response).to be_successful
      expect(inertia_page(response)["props"]["success"]).to eq(true)
    end

    it "is a 404 without an enabled self-service affiliate product", parity: true do
      create(:self_service_affiliate_product, seller:, enabled: false)

      get "/affiliates"

      expect(response).to have_http_status(:not_found)
    end
  end
end
