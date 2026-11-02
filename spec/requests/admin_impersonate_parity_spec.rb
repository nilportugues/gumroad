# frozen_string_literal: true

require "spec_helper"

# Admin::BaseController's team-member entry points recorded through the full Rack stack after a real login, for the Next.js port
# (PARITY_RECORD=1); replayed by nextjs/parity/__tests__/ws17e-admin-api.replay.test.ts. spec/requests/admin/impersonate_spec.rb
# switches forgery protection off, which a recording of DELETE must not do.
describe "Admin impersonation entry points", type: :request do
  include Parity::AudienceSignedIn

  let(:admin) { create(:admin_user, name: "Gumlord") }
  let(:seller) do
    user = create(:named_seller)
    create(:merchant_account, user:, charge_processor_merchant_id: "acct_1TestImpersonate")
    user
  end

  before { host! DOMAIN }

  describe "GET /admin/impersonate" do
    it "impersonates a seller by email", parity: true do
      log_in(admin)

      get admin_impersonate_path(user_identifier: seller.email)

      expect(response).to redirect_to(products_path)
      expect($redis.get(RedisKey.impersonated_user(admin.id)).to_i).to eq(seller.id)
    end

    it "impersonates a seller by username", parity: true do
      log_in(admin)

      get admin_impersonate_path(user_identifier: seller.username)

      expect(response).to redirect_to(products_path)
    end

    it "impersonates a seller by Stripe account id", parity: true do
      log_in(admin)

      get admin_impersonate_path(user_identifier: seller.merchant_accounts.sole.charge_processor_merchant_id)

      expect(response).to redirect_to(products_path)
    end

    it "impersonates a seller by external id and replaces an earlier impersonation", parity: true do
      log_in(admin)
      other = create(:user)
      get admin_impersonate_path(user_identifier: other.email)

      get admin_impersonate_path(user_identifier: seller.external_id)

      expect($redis.get(RedisKey.impersonated_user(admin.id)).to_i).to eq(seller.id)
    end

    it "redirects with an alert when the user is not found", parity: true do
      log_in(admin)

      get admin_impersonate_path(user_identifier: "nobody@example.com")

      expect(response).to redirect_to(root_path)
      expect(flash[:alert]).to eq("User not found")
    end

    it "redirects with an alert when no identifier is given", parity: true do
      log_in(admin)

      get admin_impersonate_path

      expect(response).to redirect_to(root_path)
    end

    it "sends a non-team member to the root", parity: true do
      log_in(create(:user))

      get admin_impersonate_path(user_identifier: seller.email)

      expect(response).to redirect_to(root_path)
    end

    it "sends a signed-out visitor to the login page", parity: true do
      get admin_impersonate_path(user_identifier: seller.email)

      expect(response).to redirect_to(login_path(next: admin_impersonate_path))
    end

    it "answers a signed-out JSON request with 404", parity: true do
      get admin_impersonate_path(user_identifier: seller.email), headers: { "Accept" => "application/json" }

      expect(response).to have_http_status(:not_found)
    end
  end

  describe "DELETE /admin/unimpersonate" do
    it "stops impersonating", parity: true do
      log_in(admin)
      get admin_impersonate_path(user_identifier: seller.email)
      expect($redis.get(RedisKey.impersonated_user(admin.id))).to be_present

      delete admin_unimpersonate_path, as: :json, headers: { "X-CSRF-Token" => csrf_token }

      expect(response.parsed_body["redirect_to"]).to eq(root_url)
      expect($redis.get(RedisKey.impersonated_user(admin.id))).to be_nil
    end
  end

  describe "GET /admin/redirect_to_stripe_dashboard" do
    it "redirects to the seller's Stripe account", parity: true do
      log_in(admin)

      get admin_redirect_to_stripe_dashboard_path(user_identifier: seller.email)

      expect(response).to redirect_to("https://dashboard.stripe.com/test/connect/accounts/acct_1TestImpersonate")
    end

    it "redirects with an alert when the seller has no Stripe account", parity: true do
      log_in(admin)

      get admin_redirect_to_stripe_dashboard_path(user_identifier: create(:named_seller).email)

      expect(response).to redirect_to(root_path)
      expect(flash[:alert]).to eq("Stripe account not found")
    end

    it "redirects with an alert when the user is not found", parity: true do
      log_in(admin)

      get admin_redirect_to_stripe_dashboard_path(user_identifier: "nobody@example.com")

      expect(response).to redirect_to(root_path)
    end
  end
end
