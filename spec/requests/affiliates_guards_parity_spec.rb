# frozen_string_literal: true

require "spec_helper"

# The lookups and refusals of AffiliatesController that Node answers in front of #create, #update, #destroy,
# #subscribe_posts and #unsubscribe_posts, recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/affiliates-guards.replay.test.ts, which sends the last request of each example. An example named
# "hands a ..." records what Node passes to Rails whole: the action saves, deletes or mails.
describe "AffiliatesController guards", type: :request do
  include Parity::AudienceSignedIn

  let(:seller) { create(:named_seller, name: "Parity Seller") }
  let(:product) { create(:product, user: seller, name: "Affiliate product") }
  let(:affiliate_user) { create(:named_user, name: "Parity Affiliate") }
  let(:direct_affiliate) { create(:direct_affiliate, seller:, affiliate_user:, products: [product]) }

  before { host! DOMAIN }

  def as_team_member(role)
    member = create(:user, name: "#{role.capitalize} Member")
    membership = create(:team_membership, user: member, seller:, role:)
    log_in(member)
    switch_to(membership)
  end

  def send_json(method, path, body = {})
    token = csrf_token
    public_send(
      method, path,
      params: body.to_json,
      headers: { "X-Inertia" => "true", "X-Requested-With" => "XMLHttpRequest", "Accept" => "text/html, application/xhtml+xml", "Content-Type" => "application/json", "X-CSRF-Token" => token }
    )
  end

  def enabled_product(fee_percent: 10)
    { id: product.external_id_numeric, enabled: true, fee_percent: }
  end

  def affiliate_body(email: affiliate_user.email, apply_to_all_products: false, fee_percent: nil, products: [enabled_product])
    { affiliate: { email:, apply_to_all_products:, fee_percent:, destination_url: nil, products: } }
  end

  describe "POST /affiliates" do
    it "sends a signed-out visitor to sign in", parity: true do
      send_json(:post, affiliates_path, affiliate_body)

      expect(response).to have_http_status(:found)
      expect(response.location).to start_with("#{PROTOCOL}://#{DOMAIN}/login")
    end

    it "sends a support team member away with the role in the flash", parity: true do
      as_team_member(TeamMembership::ROLE_SUPPORT)

      send_json(:post, affiliates_path, affiliate_body)

      expect(response).to redirect_to(dashboard_url)
      expect(flash[:alert]).to eq("Your current role as Support cannot perform this action.")
    end

    it "refuses a request without an email", parity: true do
      log_in(seller)

      send_json(:post, affiliates_path, affiliate_body(email: ""))

      expect(response).to redirect_to(new_affiliate_path)
    end

    it "refuses all products without a fee", parity: true do
      log_in(seller)

      send_json(:post, affiliates_path, affiliate_body(apply_to_all_products: true, fee_percent: "", products: []))

      expect(response).to redirect_to(new_affiliate_path)
    end

    it "refuses an enabled product without a fee", parity: true do
      log_in(seller)

      send_json(:post, affiliates_path, affiliate_body(products: [enabled_product(fee_percent: "")]))

      expect(response).to redirect_to(new_affiliate_path)
    end

    it "refuses an email without a Gumroad account", parity: true do
      log_in(seller)

      send_json(:post, affiliates_path, affiliate_body(email: "nobody@example.com"))

      expect(response).to redirect_to(new_affiliate_path)
    end

    it "refuses the seller's own email", parity: true do
      log_in(seller)

      send_json(:post, affiliates_path, affiliate_body(email: seller.email))

      expect(response).to redirect_to(new_affiliate_path)
    end

    it "refuses an account that turned affiliate requests off", parity: true do
      affiliate_user.update!(disable_affiliate_requests: true)
      log_in(seller)

      send_json(:post, affiliates_path, affiliate_body)

      expect(response).to redirect_to(new_affiliate_path)
    end

    it "refuses a request with no product enabled", parity: true do
      affiliate_user
      log_in(seller)

      send_json(:post, affiliates_path, affiliate_body(products: [{ id: product.external_id_numeric, enabled: false, fee_percent: 10 }]))

      expect(response).to redirect_to(new_affiliate_path)
    end

    it "refuses an affiliate the seller already has", parity: true do
      direct_affiliate
      log_in(seller)

      send_json(:post, affiliates_path, affiliate_body)

      expect(response).to redirect_to(new_affiliate_path)
    end

    it "hands a valid affiliate to Rails", parity: true do
      affiliate_user
      log_in(seller)

      send_json(:post, affiliates_path, affiliate_body)

      expect(response).to redirect_to(affiliates_path)
    end

    it "hands a valid affiliate for all products to Rails", parity: true do
      affiliate_user
      product
      log_in(seller)

      send_json(:post, affiliates_path, affiliate_body(apply_to_all_products: true, fee_percent: 20, products: [enabled_product]))

      expect(response).to redirect_to(affiliates_path)
    end

    it "hands a request without the affiliate parameter to Rails", parity: true do
      log_in(seller)

      send_json(:post, affiliates_path, {})

      expect(response).to have_http_status(:bad_request)
    end
  end

  describe "PATCH /affiliates/:id" do
    it "answers not found for an id nobody owns", parity: true do
      log_in(seller)

      send_json(:patch, affiliate_path("not-an-id"), affiliate_body)

      expect(response).to have_http_status(:not_found)
    end

    it "answers not found for another seller's affiliate", parity: true do
      other = create(:direct_affiliate, seller: create(:user), affiliate_user: create(:user))
      log_in(seller)

      send_json(:patch, affiliate_path(other.external_id), affiliate_body)

      expect(response).to have_http_status(:not_found)
    end

    it "sends a support team member away with the role in the flash", parity: true do
      direct_affiliate
      as_team_member(TeamMembership::ROLE_SUPPORT)

      send_json(:patch, affiliate_path(direct_affiliate.external_id), affiliate_body)

      expect(response).to redirect_to(dashboard_url)
      expect(flash[:alert]).to eq("Your current role as Support cannot perform this action.")
    end

    it "refuses an edit without an email, back to the edit page", parity: true do
      log_in(seller)

      send_json(:patch, affiliate_path(direct_affiliate.external_id), affiliate_body(email: ""))

      expect(response).to have_http_status(:see_other)
      expect(response.location).to eq("#{PROTOCOL}://#{DOMAIN}/affiliates/#{direct_affiliate.id}/edit")
    end

    it "refuses an edit that moves onto another affiliate's email", parity: true do
      taken = create(:named_user, name: "Taken Affiliate", username: "takenaffiliate", email: "taken-affiliate@example.com")
      create(:direct_affiliate, seller:, affiliate_user: taken, products: [create(:product, user: seller, name: "Other product")])
      log_in(seller)

      send_json(:patch, affiliate_path(direct_affiliate.external_id), affiliate_body(email: taken.email))

      expect(response).to have_http_status(:see_other)
    end

    it "hands an edit that keeps the affiliate's own email to Rails", parity: true do
      log_in(seller)

      send_json(:patch, affiliate_path(direct_affiliate.external_id), affiliate_body)

      expect(response).to redirect_to(affiliates_path)
    end
  end

  describe "DELETE /affiliates/:id" do
    it "answers not found for an id nobody owns", parity: true do
      log_in(seller)

      send_json(:delete, affiliate_path("not-an-id"))

      expect(response).to have_http_status(:not_found)
    end

    it "sends an accountant team member away", parity: true do
      direct_affiliate
      as_team_member(TeamMembership::ROLE_ACCOUNTANT)

      send_json(:delete, affiliate_path(direct_affiliate.external_id))

      expect(response).to redirect_to(dashboard_url)
    end

    it "hands the removal to Rails", parity: true do
      log_in(seller)

      send_json(:delete, affiliate_path(direct_affiliate.external_id))

      expect(response).to redirect_to(affiliates_path)
    end
  end

  describe "GET /affiliates/:id/subscribe_posts" do
    it "answers not found for an id nobody owns", parity: true do
      get subscribe_posts_affiliate_path("not-an-id")

      expect(response).to have_http_status(:not_found)
    end

    it "hands the change to Rails", parity: true do
      get subscribe_posts_affiliate_path(direct_affiliate.external_id)

      expect(response).to have_http_status(:ok)
    end
  end

  describe "GET /affiliates/:id/unsubscribe_posts" do
    it "answers not found for an id nobody owns", parity: true do
      get unsubscribe_posts_affiliate_path("not-an-id")

      expect(response).to have_http_status(:not_found)
    end

    it "hands the change to Rails", parity: true do
      get unsubscribe_posts_affiliate_path(direct_affiliate.external_id)

      expect(response).to have_http_status(:ok)
    end
  end
end
