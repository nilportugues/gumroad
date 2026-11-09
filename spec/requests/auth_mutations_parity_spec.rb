# frozen_string_literal: true

require "spec_helper"

# The POST/DELETE side of the authentication pages (login, logout, two-factor, password reset, confirmations)
# and the Devise redirects, recorded for the Next.js port (PARITY_RECORD=1) through the full Rack stack and replayed by
# nextjs/parity/__tests__/auth-mutations.replay.test.ts, which sends the last request of each example.
describe "Authentication mutations", type: :request do
  include Parity::AudienceSignedIn

  let(:user) { create(:user, name: "Auth User", username: "authuser", email: "auth-user@example.com", password: "a-long-password-1", created_at: Time.utc(2025, 1, 1)) }

  before { host! DOMAIN }

  def login_params(login_identifier, password, extra = {})
    { authenticity_token: csrf_token, user: { login_identifier:, password: }.merge(extra) }
  end

  describe "Devise redirects" do
    it "redirects /users/sign_in to /login", parity: true do
      get "/users/sign_in"

      expect(response).to redirect_to("/login")
      expect(response).to have_http_status(:moved_permanently)
    end

    it "keeps the query string on /users/sign_in", parity: true do
      get "/users/sign_in?next=%2Fdashboard&email=a%40example.com"

      expect(response).to redirect_to("/login?next=%2Fdashboard&email=a%40example.com")
    end

    it "redirects /users/sign_up to /signup", parity: true do
      get "/users/sign_up?referrer=abc"

      expect(response).to redirect_to("/signup?referrer=abc")
    end
  end

  describe "POST /login" do
    it "signs in with an email and remembers the browser", parity: true do
      post login_path, params: login_params(user.email, user.password)

      expect(response).to redirect_to("/dashboard")
      expect(set_cookies).to include("remember_user_token=")
      expect(user.reload.sign_in_count).to eq(1)
    end

    it "signs in with a username", parity: true do
      post login_path, params: login_params(user.username, user.password)

      expect(response).to redirect_to("/dashboard")
    end

    it "sends a buyer to the library", parity: true do
      buyer = create(:user, email: "auth-buyer@example.com", username: nil, password: "a-long-password-1")
      build(:purchase, purchaser: buyer, email: buyer.email).save!(validate: false)
      post login_path, params: login_params(buyer.email, buyer.password)

      expect(response).to redirect_to("/library")
    end

    it "goes to the next path", parity: true do
      post login_path, params: login_params(user.email, user.password).merge(next: "/products")

      expect(response).to redirect_to("/products")
    end

    it "ignores an unsafe next path", parity: true do
      post login_path, params: login_params(user.email, user.password).merge(next: "https://evil.example.org/phish")

      expect(response).to have_http_status(:found)
    end

    it "goes back to a valid referrer", parity: true do
      post login_path, params: login_params(user.email, user.password), headers: { "Referer" => "http://#{DOMAIN}/products/new" }

      expect(response).to redirect_to("http://#{DOMAIN}/products/new")
    end

    it "also answers POST /users/sign_in", parity: true do
      post "/users/sign_in", params: login_params(user.email, user.password)

      expect(response).to redirect_to("/dashboard")
    end

    it "signs in an Inertia form post", parity: true do
      post login_path, params: { user: { login_identifier: user.email, password: user.password } }.to_json,
                       headers: { "X-Inertia" => "true", "X-Requested-With" => "XMLHttpRequest", "Accept" => "text/html, application/xhtml+xml", "Content-Type" => "application/json", "X-CSRF-Token" => csrf_token }

      expect(response).to have_http_status(:found)
      expect(set_cookies).to include("remember_user_token=")
    end

    it "refuses an account that does not exist", parity: true do
      post login_path, params: login_params("nobody@example.com", "whatever-1")

      expect(response).to redirect_to(login_path)
      expect(response).to have_http_status(:see_other)
      expect(flash[:warning]).to eq("An account does not exist with that email.")
    end

    it "refuses a wrong password", parity: true do
      post login_path, params: login_params(user.email, "not-the-password")

      expect(response).to redirect_to(login_path)
      expect(flash[:warning]).to eq("Please try another password. The one you entered was incorrect.")
    end

    it "refuses a deleted account", parity: true do
      user.update_columns(deleted_at: Time.current)
      post login_path, params: login_params(user.email, user.password)

      expect(response).to redirect_to(login_path)
      expect(flash[:warning]).to eq(User::DELETED_ACCOUNT_LOGIN_ERROR)
    end

    it "refuses a blank login", parity: true do
      post login_path, params: { authenticity_token: csrf_token, user: { login_identifier: "", password: "x" } }

      expect(response).to redirect_to(login_path)
    end

    it "refuses a request without a user hash", parity: true do
      post login_path, params: { authenticity_token: csrf_token, user: "nope" }

      expect(response).to redirect_to(login_path)
    end

    it "starts email two-factor authentication", parity: true do
      user.update!(two_factor_authentication_enabled: true)
      post login_path, params: login_params(user.email, user.password)

      expect(response).to redirect_to(two_factor_authentication_path(next: "/dashboard"))
      expect(set_cookies).not_to include("remember_user_token=")
    end

    it "skips two-factor authentication from an IP that passed it before", parity: true do
      user.update!(two_factor_authentication_enabled: true)
      user.add_two_factor_authenticated_ip!("127.0.0.1")
      post login_path, params: login_params(user.email, user.password)

      expect(response).to redirect_to("/dashboard")
    end

    it "starts authenticator two-factor authentication", parity: true do
      user.update!(two_factor_authentication_enabled: true)
      create(:totp_credential, user:, confirmed_at: Time.current)
      post login_path, params: login_params(user.email, user.password)

      expect(response).to redirect_to(two_factor_authentication_path(next: "/dashboard"))
    end
  end

  describe "logout" do
    it "signs out with DELETE", parity: true do
      log_in(user)
      delete "/logout", params: { authenticity_token: csrf_token }

      expect(response).to have_http_status(:found)
    end

    it "signs out with GET", parity: true do
      log_in(user)
      get "/logout"

      expect(response).to have_http_status(:found)
    end

    it "redirects back to a same-host referrer", parity: true do
      log_in(user)
      delete "/logout", params: { authenticity_token: csrf_token }, headers: { "Referer" => "http://#{DOMAIN}/help" }

      expect(response).to redirect_to("http://#{DOMAIN}/help")
    end

    it "answers a signed-out DELETE /users/sign_out", parity: true do
      delete "/users/sign_out", params: { authenticity_token: csrf_token }

      expect(response).to have_http_status(:found)
    end
  end

  describe "two-factor authentication" do
    before { user.update!(two_factor_authentication_enabled: true) }

    def start_two_factor(account = user)
      post login_path, params: login_params(account.email, account.password)
      expect(response).to have_http_status(:found)
    end

    it "signs in with the token", parity: true do
      start_two_factor
      post "/two-factor", params: { authenticity_token: csrf_token, token: User::DEFAULT_AUTH_TOKEN, user_id: user.encrypted_external_id }

      expect(response).to redirect_to("/dashboard")
    end

    it "verifies a token from the emailed link", parity: true do
      start_two_factor
      get "/two-factor/verify", params: { token: User::DEFAULT_AUTH_TOKEN, user_id: user.encrypted_external_id }

      expect(response).to have_http_status(:see_other)
    end

    it "refuses a wrong token", parity: true do
      start_two_factor
      post "/two-factor", params: { authenticity_token: csrf_token, token: "123456", user_id: user.encrypted_external_id }

      expect(response).to redirect_to(two_factor_authentication_path)
      expect(flash[:warning]).to eq("Invalid token, please try again.")
    end

    it "returns to the login form without a pending login", parity: true do
      post "/two-factor", params: { authenticity_token: csrf_token, token: User::DEFAULT_AUTH_TOKEN, user_id: user.encrypted_external_id }

      expect(response).to redirect_to(login_path(next: nil))
    end

    it "is a 404 for another user's id", parity: true do
      start_two_factor
      other = create(:user)
      post "/two-factor", params: { authenticity_token: csrf_token, token: User::DEFAULT_AUTH_TOKEN, user_id: other.encrypted_external_id }

      expect(response).to have_http_status(:not_found)
    end

    it "resends the token", parity: true do
      start_two_factor
      post "/two-factor/resend_authentication_token", params: { authenticity_token: csrf_token, user_id: user.encrypted_external_id }

      expect(response).to redirect_to(two_factor_authentication_path)
      expect(flash[:notice]).to eq("Resent the authentication token, please check your inbox.")
    end

    it "cannot resend a token for the authenticator app", parity: true do
      create(:totp_credential, user:, confirmed_at: Time.current)
      start_two_factor
      post "/two-factor/resend_authentication_token", params: { authenticity_token: csrf_token, user_id: user.encrypted_external_id }

      expect(flash[:warning]).to eq("Cannot resend token for authenticator app.")
    end

    it "switches to email", parity: true do
      create(:totp_credential, user:, confirmed_at: Time.current)
      start_two_factor
      post "/two-factor/switch_to_email", params: { authenticity_token: csrf_token, user_id: user.encrypted_external_id }

      expect(response).to redirect_to(two_factor_authentication_path)
    end

    it "switches to a recovery code", parity: true do
      create(:totp_credential, user:, confirmed_at: Time.current)
      start_two_factor
      post "/two-factor/switch_to_recovery", params: { authenticity_token: csrf_token, user_id: user.encrypted_external_id }

      expect(response).to redirect_to(two_factor_authentication_path)
    end

    it "switches to the authenticator", parity: true do
      create(:totp_credential, user:, confirmed_at: Time.current)
      start_two_factor
      post "/two-factor/switch_to_authenticator", params: { authenticity_token: csrf_token, user_id: user.encrypted_external_id }

      expect(response).to redirect_to(two_factor_authentication_path)
    end
  end
end
