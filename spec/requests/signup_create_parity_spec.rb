# frozen_string_literal: true

require "spec_helper"

# POST /signup (SignupController#create), recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/signup-create.replay.test.ts, which sends the last request of each example. An example named "hands ..." is one Node
# leaves to Rails: the replay asserts it reached Rails and wrote nothing.
describe "Signup create", type: :request do
  include Parity::AudienceSignedIn

  before { host! DOMAIN }

  def signup_params(user_params, extra = {})
    { authenticity_token: csrf_token, user: user_params }.merge(extra)
  end

  describe "a new account" do
    it "creates the account, signs it in and goes to the dashboard", parity: true do
      post "/signup", params: signup_params(email: "new-seller@example.com", password: "a-long-signup-password")

      expect(response).to have_http_status(:found)
      user = User.find_by!(email: "new-seller@example.com")
      expect(user.confirmed?).to eq(false)
      expect(set_cookies).to include("_gumroad_two_factor_")
    end

    it "answers JSON with the redirect location", parity: true do
      post "/signup", params: signup_params(email: "json-seller@example.com", password: "a-long-signup-password"), headers: { "Accept" => "application/json" }

      expect(response.parsed_body["success"]).to eq(true)
    end

    it "goes to the next path", parity: true do
      post "/signup", params: signup_params({ email: "next-seller@example.com", password: "a-long-signup-password" }, next: "/products")

      expect(response).to have_http_status(:found)
    end

    it "records the terms agreement", parity: true do
      post "/signup", params: signup_params(email: "terms-seller@example.com", password: "a-long-signup-password", terms_accepted: "1")

      expect(User.find_by!(email: "terms-seller@example.com").tos_agreements.count).to eq(1)
    end

    it "marks a buyer signup", parity: true do
      post "/signup", params: signup_params(email: "buyer-signup@example.com", password: "a-long-signup-password", buyer_signup: "true")

      expect(User.find_by!(email: "buyer-signup@example.com").buyer_signup).to eq(true)
    end
  end

  describe "refusals" do
    it "asks for an email address", parity: true do
      post "/signup", params: signup_params(email: "", password: "a-long-signup-password")

      expect(response).to redirect_to("/signup")
    end

    it "asks for a password", parity: true do
      post "/signup", params: signup_params(email: "no-password@example.com", password: "")

      expect(response).to redirect_to("/signup")
    end

    it "refuses an email that is not an address", parity: true do
      post "/signup", params: signup_params(email: "not-an-email", password: "a-long-signup-password")

      expect(response).to redirect_to("/signup")
    end

    it "refuses a password that is too short", parity: true do
      post "/signup", params: signup_params(email: "short@example.com", password: "abc")

      expect(response).to redirect_to("/signup")
    end

    it "answers a refusal in JSON", parity: true do
      post "/signup", params: signup_params(email: "short-json@example.com", password: "abc"), headers: { "Accept" => "application/json" }

      expect(response.parsed_body["success"]).to eq(false)
    end

    it "refuses a user that is a plain string", parity: true do
      post "/signup", params: { authenticity_token: csrf_token, user: "seller" }

      expect(response).to redirect_to("/signup")
    end

    it "refuses a request with no user", parity: true do
      post "/signup", params: { authenticity_token: csrf_token }

      expect(response).to redirect_to("/signup")
    end
  end

  describe "a visitor who is already signed in" do
    let(:signed_in) { create(:user, email: "signed-in@example.com", password: "a-long-existing-2", created_at: Time.utc(2025, 1, 1)) }

    before { log_in(signed_in) }

    it "sends them home without creating an account", parity: true do
      post "/signup", params: signup_params(email: "ignored@example.com", password: "a-long-signup-password")

      expect(response).to redirect_to("/dashboard")
      expect(User.find_by(email: "ignored@example.com")).to be_nil
    end

    it "sends them to the next path", parity: true do
      post "/signup", params: signup_params({ email: "ignored@example.com", password: "a-long-signup-password" }, next: "/products")

      expect(response).to redirect_to("/products")
    end
  end

  describe "an address that is taken" do
    let!(:existing) { create(:user, email: "taken@example.com", password: "a-long-existing-1") }

    it "refuses a different password", parity: true do
      post "/signup", params: signup_params(email: "taken@example.com", password: "another-password-1")

      expect(response).to redirect_to("/signup")
    end

    it "signs in with the account's own password", parity: true do
      post "/signup", params: signup_params(email: "taken@example.com", password: "a-long-existing-1")

      expect(response).to have_http_status(:found)
      expect(set_cookies).to include("_gumroad_app_session")
    end

    it "refuses an address held by a deleted account", parity: true do
      existing.update_columns(deleted_at: Time.current)
      post "/signup", params: signup_params(email: "taken@example.com", password: "another-password-1")

      expect(response).to redirect_to("/signup")
    end
  end

  describe "branches left to Rails" do
    it "hands a referral to Rails", parity: true do
      referrer = create(:user)
      post "/signup", params: signup_params({ email: "referred@example.com", password: "a-long-signup-password" }, referral: referrer.external_id)

      expect(User.find_by!(email: "referred@example.com")).to be_present
    end

    it "hands a signup that attaches a purchase to Rails", parity: true do
      purchase = build(:purchase, email: "purchase-signup@example.com", purchase_state: "successful")
      purchase.save!(validate: false)
      post "/signup", params: signup_params(email: "purchase-signup@example.com", password: "a-long-signup-password", purchase_id: purchase.external_id)

      expect(purchase.reload.purchaser).to eq(User.find_by!(email: "purchase-signup@example.com"))
    end
  end
end
