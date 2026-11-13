# frozen_string_literal: true

require "spec_helper"

# The refusals of PagesController that Node answers (#create, #update, #destroy, #preview and #products), recorded for the Next.js
# port (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/pages-controller.replay.test.ts, which sends the last request of
# each example. An example named "hands a ..." records what Node passes to Rails whole.
describe "PagesController guards", type: :request do
  include Parity::AudienceSignedIn

  let(:seller) { create(:named_seller, name: "Pages Guard Seller", username: "pagesguard", created_at: Time.utc(2025, 1, 1)) }
  let(:inertia_headers) do
    { "X-Inertia" => "true", "X-Requested-With" => "XMLHttpRequest", "Accept" => "text/html, application/xhtml+xml", "Content-Type" => "application/json", "Referer" => "http://#{DOMAIN}/pages" }
  end

  before { host! DOMAIN }

  def send_form(method, path, body = {})
    token = csrf_token
    public_send(method, path, params: body.to_json, headers: inertia_headers.merge("X-CSRF-Token" => token))
  end

  def as_team_member(role)
    member = create(:user, name: "#{role.capitalize} Member")
    membership = create(:team_membership, user: member, seller:, role:)
    log_in(member)
    switch_to(membership)
  end

  def rich_page(**attributes)
    create(:user_page, pageable: seller, slug: "about-me", title: "About me", content: "<p>Hello</p>", **attributes)
  end

  def custom_page
    create(:user_page, pageable: seller, slug: "my-landing", title: "Landing", content: nil, custom_html: "<main><h1>Landing</h1></main>")
  end

  def profile_takeover
    create(:user_page, pageable: seller, slug: nil, title: nil, content: nil, custom_html: "<main><h1>Home</h1></main>")
  end

  describe "POST /pages" do
    it "refuses a page with a blank title and content", parity: true do
      log_in(seller)

      send_form(:post, pages_path, title: "   ", content: "")

      expect(response).to redirect_to(new_page_path)
      expect(seller.pages.count).to eq(0)
    end

    it "refuses a page with no title and no content", parity: true do
      log_in(seller)

      send_form(:post, pages_path)

      expect(response).to redirect_to(new_page_path)
    end

    it "refuses search fields that are too long", parity: true do
      log_in(seller)

      send_form(:post, pages_path, title: "", content: "", seo_title: "t" * 71, seo_description: "d" * 321)

      expect(response).to redirect_to(new_page_path)
    end

    it "squishes the search fields before it counts them", parity: true do
      log_in(seller)

      send_form(:post, pages_path, title: "", content: "", seo_title: "#{'t ' * 35}   ", seo_description: "   ")

      expect(response).to redirect_to(new_page_path)
    end

    it "sends a support member to the dashboard", parity: true do
      as_team_member(:support)

      send_form(:post, pages_path, title: "", content: "")

      expect(response).to redirect_to(dashboard_path)
    end

    it "lets a marketing member through to the validation", parity: true do
      as_team_member(:marketing)

      send_form(:post, pages_path, title: "", content: "")

      expect(response).to redirect_to(new_page_path)
    end

    it "hands a page with a title to Rails", parity: true do
      log_in(seller)

      send_form(:post, pages_path, title: "About me", content: "<p>Hello</p>")

      expect(response).to redirect_to(edit_page_path("about-me"))
      expect(seller.pages.pluck(:slug)).to eq(["about-me"])
    end

    it "hands a title that is not text to Rails", parity: true do
      log_in(seller)

      send_form(:post, pages_path, title: ["About me"], content: "")

      expect(response).to redirect_to(edit_page_path("about-me"))
    end
  end

  describe "PATCH /pages/:slug" do
    before { log_in(seller) }

    it "sends an unknown slug back to the list", parity: true do
      send_form(:patch, "/pages/nothing-here", title: "", content: "")

      expect(response).to redirect_to(pages_path)
    end

    it "does not find the page of another seller", parity: true do
      other = create(:user, name: "Other Seller", email: "other@example.com", username: "otherseller")
      create(:user_page, pageable: other, slug: "about-me", title: "About me")

      send_form(:patch, "/pages/about-me", title: "", content: "")

      expect(response).to redirect_to(pages_path)
    end

    it "refuses a blank title and content", parity: true do
      rich_page

      send_form(:patch, "/pages/about-me", title: "", content: "")

      expect(response).to redirect_to(edit_page_path("about-me"))
      expect(seller.pages.first.title).to eq("About me")
    end

    it "refuses a request that sends neither title nor content", parity: true do
      rich_page

      send_form(:put, "/pages/about-me")

      expect(response).to redirect_to(edit_page_path("about-me"))
    end

    it "refuses search fields that are too long", parity: true do
      rich_page

      send_form(:patch, "/pages/about-me", title: "", content: "", seo_title: "t" * 71)

      expect(response).to redirect_to(edit_page_path("about-me"))
    end

    it "sends the profile entry with nothing to write to the list", parity: true do
      send_form(:patch, "/pages/profile")

      expect(response).to redirect_to(pages_path)
    end

    it "hands a valid edit to Rails", parity: true do
      rich_page

      send_form(:patch, "/pages/about-me", title: "About us", content: "<p>Hello</p>")

      expect(response).to redirect_to(edit_page_path("about-me"))
      expect(seller.pages.first.title).to eq("About us")
    end

    it "hands the search fields of a custom HTML page to Rails", parity: true do
      custom_page

      send_form(:patch, "/pages/my-landing", seo_title: "Landing")

      expect(response).to redirect_to(edit_page_path("my-landing"))
    end

    it "saves the search fields of the profile", parity: true do
      send_form(:patch, "/pages/profile", seo_title: "Home")

      expect(response).to redirect_to(edit_page_path("profile"))
    end

    it "removes the custom HTML of the profile takeover", parity: true do
      profile_takeover

      send_form(:patch, "/pages/profile", remove_custom_html: true)

      expect(response).to redirect_to(edit_page_path("profile"))
    end
  end

  describe "PATCH /pages/:slug by a team member" do
    it "sends a support member to the dashboard", parity: true do
      rich_page
      as_team_member(:support)

      send_form(:patch, "/pages/about-me", title: "", content: "")

      expect(response).to redirect_to(dashboard_path)
    end
  end

  describe "DELETE /pages/:slug" do
    it "sends an unknown slug back to the list", parity: true do
      log_in(seller)

      send_form(:delete, "/pages/nothing-here")

      expect(response).to redirect_to(pages_path)
    end

    it "leaves the profile entry alone", parity: true do
      log_in(seller)

      send_form(:delete, "/pages/profile")

      expect(response).to redirect_to(pages_path)
    end

    it "sends a support member to the dashboard", parity: true do
      rich_page
      as_team_member(:support)

      send_form(:delete, "/pages/about-me")

      expect(response).to redirect_to(dashboard_path)
      expect(seller.pages.count).to eq(1)
    end
  end

  describe "GET /pages/:slug/preview" do
    it "sends an unknown slug back to the list", parity: true do
      log_in(seller)

      get "/pages/nothing-here/preview"

      expect(response).to redirect_to(pages_path)
    end

    it "answers 404 to a profile with no custom HTML", parity: true do
      log_in(seller)

      get "/pages/profile/preview"

      expect(response).to have_http_status(:not_found)
    end

    it "lets an accountant member through to the 404", parity: true do
      as_team_member(:accountant)

      get "/pages/profile/preview"

      expect(response).to have_http_status(:not_found)
    end

    it "hands the preview of a rich text page to Rails", parity: true do
      rich_page
      log_in(seller)

      get "/pages/about-me/preview"

      expect(response).to have_http_status(:ok)
    end

    it "hands the preview of a custom HTML page to Rails", parity: true do
      custom_page
      log_in(seller)

      get "/pages/my-landing/preview"

      expect(response).to have_http_status(:ok)
    end

    it "hands the preview of the profile takeover to Rails", parity: true do
      profile_takeover
      log_in(seller)

      get "/pages/profile/preview"

      expect(response).to have_http_status(:ok)
    end
  end

  describe "GET /pages/:slug/products" do
    it "sends an unknown slug back to the list", parity: true do
      log_in(seller)

      get "/pages/nothing-here/products"

      expect(response).to redirect_to(pages_path)
    end

    it "answers 404 to a page that is not the profile", parity: true do
      rich_page
      log_in(seller)

      get "/pages/about-me/products"

      expect(response).to have_http_status(:not_found)
    end

    it "answers a bad request to the profile's catalogue without a window", parity: true do
      log_in(seller)

      get "/pages/profile/products"

      expect(response).to have_http_status(:bad_request)
    end

    it "answers a slice of the profile's catalogue", parity: true do
      create(:product, user: seller, name: "Guide")
      profile_takeover
      log_in(seller)

      get "/pages/profile/products", params: { offset: 0, limit: 10 }

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body["products"].map { |product| product["name"] }).to eq(["Guide"])
    end

    it "answers a slice of the profile's catalogue before the takeover is saved", parity: true do
      log_in(seller)

      get "/pages/profile/products", params: { offset: 0, limit: 10 }

      expect(response.parsed_body).to include("success" => true, "products_total" => 0)
    end

    it "answers a slice to a team member who may see pages", parity: true do
      create(:product, user: seller, name: "Guide")
      as_team_member(:admin)

      get "/pages/profile/products", params: { offset: 0, limit: 10 }

      expect(response).to have_http_status(:ok)
    end

    it "hands the slice of a profile that references prices to Rails", parity: true do
      create(:user_page, pageable: seller, slug: nil, title: nil, content: nil, custom_html: "<span data-gumroad-product=\"abc\" data-gumroad-field=\"price\">$1</span>")
      log_in(seller)

      get "/pages/profile/products", params: { offset: 0, limit: 10 }

      expect(response).to have_http_status(:ok)
    end
  end
end
