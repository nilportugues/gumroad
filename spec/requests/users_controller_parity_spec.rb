# frozen_string_literal: true

require "spec_helper"

# The guards, redirects and small reads of UsersController that render no page (#edit, #landing_version, the 404s of #landing_iframe_content
# and #landing_products, #coffee's receipt redirect, #deactivate's refusal and the early answers of #add_purchase_to_library), recorded for
# the Next.js port (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/users-controller.replay.test.ts, which sends the last request
# of each example. Examples named "hands ..." record what Node passes to Rails whole.
describe "UsersController", type: :request do
  include Parity::AudienceSignedIn

  let(:seller) { create(:named_seller, name: "Parity Seller") }
  let(:other_seller) { create(:user, username: "otherseller", name: "Other Seller") }
  let(:json_headers) { { "Accept" => "application/json", "Content-Type" => "application/json" } }

  def team_member(role)
    member = create(:user, name: "#{role.capitalize} Member")
    membership = create(:team_membership, user: member, seller:, role:)
    log_in(member)
    switch_to(membership)
  end

  def publish_custom_html(user)
    user.update!(custom_html: "<section><h1>Landing</h1></section>")
    user.page.update_columns(updated_at: Time.utc(2025, 3, 4, 5, 6, 7))
    Feature.activate_user(:custom_html_pages, user)
  end

  describe "GET /:username/edit" do
    before { host! DOMAIN }

    it "redirects the signed-in seller to the profile settings", parity: true do
      log_in(seller)

      get "/#{seller.username}/edit"

      expect(response).to have_http_status(:found)
      expect(response.location).to end_with("/profile")
    end

    it "redirects a support member acting as the seller", parity: true do
      team_member(:support)

      get "/#{seller.username}/edit"

      expect(response).to have_http_status(:found)
      expect(response.location).to end_with("/profile")
    end

    it "answers not found for another seller's name", parity: true do
      log_in(seller)

      get "/#{other_seller.username}/edit"

      expect(response).to have_http_status(:not_found)
    end

    it "answers not found for a name nobody owns", parity: true do
      log_in(seller)

      get "/nobody-here/edit"

      expect(response).to have_http_status(:not_found)
    end

    it "answers not found for a deleted account", parity: true do
      log_in(seller)
      other_seller.update_columns(deleted_at: Time.utc(2025, 1, 1))

      get "/#{other_seller.username}/edit"

      expect(response).to have_http_status(:not_found)
    end

    it "finds the account by its external id", parity: true do
      log_in(seller)

      get "/#{seller.external_id}/edit"

      expect(response).to have_http_status(:found)
      expect(response.location).to end_with("/profile")
    end

    it "sends a signed-out visitor to the login page", parity: true do
      get "/#{seller.username}/edit"

      expect(response).to have_http_status(:found)
      expect(response.location).to include("/login")
    end
  end

  describe "GET /edit on the seller's own host" do
    it "redirects the signed-in seller to the profile settings", parity: true do
      host! DOMAIN
      log_in(seller)
      host! seller.subdomain

      get "/edit"

      expect(response).to have_http_status(:found)
    end
  end

  describe "GET landing/version" do
    before { host! DOMAIN }

    it "reports nothing to a visitor", parity: true do
      publish_custom_html(seller)

      get "/#{seller.username}/landing/version"

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body).to eq("present" => false, "version" => nil)
    end

    it "reports the live version to the owner", parity: true do
      publish_custom_html(seller)
      log_in(seller)

      get "/#{seller.username}/landing/version"

      expect(response.parsed_body).to eq("present" => true, "version" => Time.utc(2025, 3, 4, 5, 6, 7).to_i)
    end

    it "reports nothing to the owner without saved custom HTML", parity: true do
      log_in(seller)

      get "/#{seller.username}/landing/version"

      expect(response.parsed_body).to eq("present" => false, "version" => nil)
    end

    it "reports nothing to the owner while the feature is off", parity: true do
      seller.update!(custom_html: "<p>Saved</p>")
      log_in(seller)

      get "/#{seller.username}/landing/version"

      expect(response.parsed_body).to eq("present" => false, "version" => nil)
    end

    it "answers not found for a name nobody owns", parity: true do
      get "/nobody-here/landing/version"

      expect(response).to have_http_status(:not_found)
    end

    it "reports the version on the seller's own host", parity: true do
      publish_custom_html(seller)
      host! seller.subdomain

      get "/landing/version"

      expect(response.parsed_body).to eq("present" => false, "version" => nil)
    end
  end

  describe "GET landing/embed and landing/products" do
    it "answers an empty not found to the embed of a seller without custom HTML", parity: true do
      host! DOMAIN

      get "/#{seller.username}/landing/embed"

      expect(response).to have_http_status(:not_found)
      expect(response.body).to be_blank
      expect(response.headers["X-Robots-Tag"]).to eq("noindex")
    end

    it "answers an empty not found to the embed while the feature is off", parity: true do
      host! DOMAIN
      seller.update!(custom_html: "<p>Saved</p>")

      get "/#{seller.username}/landing/embed"

      expect(response).to have_http_status(:not_found)
    end

    it "answers an empty not found to the embed on the seller's own host", parity: true do
      host! seller.subdomain

      get "/landing/embed"

      expect(response).to have_http_status(:not_found)
    end

    it "answers an empty not found to the products slice of a seller without custom HTML", parity: true do
      host! DOMAIN

      get "/#{seller.username}/landing/products", params: { offset: 0, limit: 10 }

      expect(response).to have_http_status(:not_found)
      expect(response.body).to be_blank
    end

    it "answers an empty not found to the products slice on the seller's own host", parity: true do
      host! seller.subdomain

      get "/landing/products", params: { offset: 0, limit: 10 }

      expect(response).to have_http_status(:not_found)
    end

    it "answers not found for a name nobody owns", parity: true do
      host! DOMAIN

      get "/nobody-here/landing/embed"

      expect(response).to have_http_status(:not_found)
    end

    it "hands the embed of live custom HTML to Rails", parity: true do
      host! DOMAIN
      publish_custom_html(seller)

      get "/#{seller.username}/landing/embed"

      expect(response).to have_http_status(:ok)
      expect(response.body).to include("Landing")
    end

    it "hands the products slice of live custom HTML to Rails", parity: true do
      host! DOMAIN
      publish_custom_html(seller)

      get "/#{seller.username}/landing/products", params: { offset: 0, limit: 10 }

      expect(response).to have_http_status(:ok)
    end
  end

  describe "GET /coffee on the seller's own host" do
    before do
      # Service products need an account older than 30 days.
      seller.update_columns(created_at: 60.days.ago)
      host! seller.subdomain
    end

    it "redirects a receipt notice to the page itself", parity: true do
      get "/coffee", params: { purchase_email: "buyer@example.com" }

      expect(response).to have_http_status(:found)
      expect(response.location).to end_with("/coffee")
    end

    it "answers not found without a coffee product", parity: true do
      get "/coffee"

      expect(response).to have_http_status(:not_found)
    end

    it "answers not found when the coffee product is archived", parity: true do
      create(:coffee_product, user: seller).update!(archived: true)

      get "/coffee"

      expect(response).to have_http_status(:not_found)
    end

    it "hands a seller with a coffee product to Rails", parity: true do
      create(:coffee_product, user: seller)

      get "/coffee"

      expect(response).to have_http_status(:ok)
    end
  end

  describe "POST /users/deactivate" do
    before { host! DOMAIN }

    it "refuses a team admin with the role's message", parity: true do
      team_member(:admin)

      post "/users/deactivate", params: {}.to_json, headers: json_headers.merge("X-CSRF-Token" => csrf_token)

      expect(response).to have_http_status(:unauthorized)
      expect(response.parsed_body["success"]).to eq(false)
    end

    it "hands an owner's closure to Rails", parity: true do
      log_in(seller)

      post "/users/deactivate", params: {}.to_json, headers: json_headers.merge("X-CSRF-Token" => csrf_token)

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body["success"]).to eq(true)
    end
  end

  describe "POST /add_purchase_to_library" do
    let(:product) { create(:product, user: seller) }
    let(:buyer) { create(:named_user, name: "Library Buyer", email: "library-buyer@example.com") }
    let!(:purchase) { create(:free_purchase, link: product, purchaser: nil, email: "guest@example.com", ip_address: "203.0.113.9") }

    before { host! DOMAIN }

    def add_to_library(user = { purchase_id: purchase.external_id, purchase_email: purchase.email })
      post "/add_purchase_to_library", params: { authenticity_token: csrf_token, user: }
    end

    it "answers failure when the user param is missing", parity: true do
      post "/add_purchase_to_library", params: { authenticity_token: csrf_token }

      expect(response.parsed_body).to eq("success" => false)
    end

    it "answers failure when the user param is a string", parity: true do
      post "/add_purchase_to_library", params: { authenticity_token: csrf_token, user: "guest" }

      expect(response.parsed_body).to eq("success" => false)
    end

    it "answers failure for an unknown purchase", parity: true do
      add_to_library(purchase_id: "unknown", purchase_email: purchase.email)

      expect(response.parsed_body).to eq("success" => false)
    end

    it "answers failure for another email", parity: true do
      add_to_library(purchase_id: purchase.external_id, purchase_email: "someone-else@example.com")

      expect(response.parsed_body).to eq("success" => false)
    end

    it "answers failure for an email that differs in case", parity: true do
      add_to_library(purchase_id: purchase.external_id, purchase_email: "GUEST@example.com")

      expect(response.parsed_body).to eq("success" => false)
    end

    it "answers failure for a purchase locked against reassignment", parity: true do
      purchase.is_reassignment_locked = true
      purchase.update_columns(flags: purchase.flags)

      add_to_library

      expect(response.parsed_body).to eq("success" => false)
    end

    it "answers failure for the seller's own test purchase", parity: true do
      purchase.update_columns(purchaser_id: seller.id)

      add_to_library

      expect(response.parsed_body).to eq("success" => false)
    end

    it "answers failure to a signed-out visitor when no account owns the email", parity: true do
      add_to_library

      expect(response.parsed_body).to eq("success" => false)
    end

    it "refuses a seller moving a customer's purchase into their account", parity: true do
      log_in(seller)

      add_to_library

      expect(response.parsed_body).to eq("success" => false, "error_message" => "This is your customer's purchase, so it can't be moved into your account.")
    end

    it "hands a purchase moved into a signed-in buyer's library to Rails", parity: true do
      log_in(buyer)

      add_to_library

      expect(response.parsed_body["success"]).to eq(true)
    end

    it "hands an email an account owns to Rails", parity: true do
      create(:user, email: purchase.email, password: "a-correct-password-1")

      add_to_library(purchase_id: purchase.external_id, purchase_email: purchase.email, password: "wrong")

      expect(response.parsed_body).to eq("success" => false)
    end

    it "hands a purchase id that is not text to Rails", parity: true do
      add_to_library(purchase_id: ["a"], purchase_email: purchase.email)

      expect(response.parsed_body).to eq("success" => false)
    end
  end
end
