# frozen_string_literal: true

require "spec_helper"

# The seller's page management UI (PagesController index, new and edit), recorded for the Next.js
# port (PARITY_RECORD=1). Replayed by nextjs/parity/__tests__/public-pages.replay.test.ts. The index
# is replayed as HTML and as an Inertia visit; new and edit are served to Inertia visits only.
describe "Seller pages", type: :request do
  include Parity::SignedInRequests

  INERTIA = { "X-Inertia" => "true", "X-Requested-With" => "XMLHttpRequest" }.freeze

  let(:seller) { create(:named_seller, name: "Jane Doe", bio: "Hand-lettered   posters and prints.") }

  before { host! DOMAIN }

  def switch_to(membership)
    post sellers_switch_path, params: { authenticity_token: csrf_token_from("/ping"), team_membership_id: membership.external_id }
    expect(response).to have_http_status(:no_content)
  end

  describe "index" do
    it "lists the slugged pages, the home entry and the product pages count", parity: true do
      create(:user_page, pageable: seller, slug: "about", title: "About", content: "<p>Hi</p>", created_at: 2.hours.ago)
      create(:user_page, pageable: seller, slug: "free-resources", title: "Free — resources", custom_html: "<main>Hello</main>", seo_title: "Free stuff", seo_description: "Things", created_at: 1.hour.ago)
      create(:user_page, pageable: seller, slug: nil, content: nil, custom_html: "<main>Home</main>")
      product = create(:product, user: seller)
      create(:user_page, pageable: product, slug: nil, content: nil, custom_html: "<main>Product</main>")
      create(:user_page, pageable: create(:product, user: seller, deleted_at: Time.current), slug: nil, content: nil, custom_html: "<main>Deleted</main>")
      log_in(seller, token_path: "/ping")

      get "/pages"

      expect(response).to be_successful
      props = inertia_props_of(response)
      expect(props["pages"].map { _1["slug"] }).to eq(%w[about free-resources])
      expect(props["product_pages_count"]).to eq(1)
      expect(props["profile"]["custom_html"]).to be(true)
    end

    it "renders for a seller without pages", parity: true do
      log_in(seller, token_path: "/ping")

      get "/pages"

      expect(response).to be_successful
      expect(inertia_props_of(response)).to include("pages" => [], "product_pages_count" => 0)
    end

    it "answers an Inertia visit with the page as JSON", parity: true do
      create(:user_page, pageable: seller, slug: "about", title: "About", content: "<p>Hi</p>")
      log_in(seller, token_path: "/ping")

      get "/pages", headers: INERTIA

      expect(response).to be_successful
      expect(response.parsed_body["component"]).to eq("Pages/Index")
    end

    %w[accountant admin marketing support].each do |role|
      it "renders for a #{role} on the team", parity: true do
        member = create(:user, name: "Team Member")
        membership = create(:team_membership, user: member, seller:, role:)
        create(:user_page, pageable: seller, slug: "about", title: "About", content: "<p>Hi</p>")
        log_in(member, token_path: "/ping")
        switch_to(membership)

        get "/pages"

        expect(response).to be_successful
        expect(inertia_props_of(response)["current_seller"]).to include("email" => seller.email)
      end
    end
  end

  describe "new" do
    it "renders the empty editor as an Inertia visit", parity: true do
      log_in(seller, token_path: "/ping")

      get "/pages/new", headers: INERTIA

      expect(response).to be_successful
      expect(response.parsed_body["props"]).to include("is_new" => true, "seller_name" => "Jane Doe")
    end

    %w[accountant support].each do |role|
      it "sends a #{role} back to the dashboard with their role in the message", parity: true do
        member = create(:user, name: "Team Member")
        membership = create(:team_membership, user: member, seller:, role:)
        log_in(member, token_path: "/ping")
        switch_to(membership)

        get "/pages/new", headers: INERTIA

        expect(response).to have_http_status(:found)
        expect(response.location).to eq("#{PROTOCOL}://#{DOMAIN}/dashboard")
        expect(flash[:alert]).to start_with("Your current role as")
      end
    end

    it "does not set the flash when the account was just switched", parity: true do
      member = create(:user, name: "Team Member")
      membership = create(:team_membership, user: member, seller:, role: "support")
      log_in(member, token_path: "/ping")
      switch_to(membership)

      get "/pages/new?account_switched=true", headers: INERTIA

      expect(response).to have_http_status(:found)
      expect(flash[:alert]).to be_nil
    end
  end

  describe "edit" do
    it "renders a rich text page", parity: true do
      create(:user_page, pageable: seller, slug: "about", title: "About us", content: "<p>Hi</p>", seo_title: "About Jane")
      log_in(seller, token_path: "/ping")

      get "/pages/about/edit", headers: INERTIA

      expect(response).to be_successful
      expect(response.parsed_body["props"]["page"]).to include("slug" => "about", "title" => "About us", "seo_title" => "About Jane")
    end

    it "does not repeat the store name that already ends the title", parity: true do
      create(:user_page, pageable: seller, slug: "about", title: "About Jane Doe", content: "<p>Hi</p>")
      log_in(seller, token_path: "/ping")

      get "/pages/about/edit", headers: INERTIA

      expect(response.parsed_body["props"]["page"]["default_seo_title"]).to eq("About Jane Doe")
    end

    it "renders the home entry with the profile's search fields", parity: true do
      seller.seller_profile.update!(seo_title: "Jane's studio", seo_description: "Posters")
      log_in(seller, token_path: "/ping")

      get "/pages/profile/edit", headers: INERTIA

      expect(response).to be_successful
      expect(response.parsed_body["props"]).to include("is_profile" => true)
      expect(response.parsed_body["props"]["page"]).to include("title" => "Home", "default_seo_description" => "Hand-lettered posters and prints.")
    end

    it "falls back to a generic description for a seller without a bio", parity: true do
      seller.update!(bio: nil)
      log_in(seller, token_path: "/ping")

      get "/pages/profile/edit", headers: INERTIA

      expect(response.parsed_body["props"]["page"]["default_seo_description"]).to eq("Get the latest products and updates from Jane Doe on Gumroad.")
    end

    it "sends an unknown page back to the list", parity: true do
      log_in(seller, token_path: "/ping")

      get "/pages/no-such-page/edit", headers: INERTIA

      expect(response).to have_http_status(:found)
      expect(response.location).to eq("#{PROTOCOL}://#{DOMAIN}/pages")
    end

    it "does not show another seller's page", parity: true do
      create(:user_page, pageable: create(:user), slug: "theirs")
      log_in(seller, token_path: "/ping")

      get "/pages/theirs/edit", headers: INERTIA

      expect(response).to have_http_status(:found)
    end
  end
end
