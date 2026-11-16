# frozen_string_literal: true

require "spec_helper"

# Password reset, email confirmation, invalidating every session and the small session/JSON endpoints of the users routes,
# recorded for the Next.js port (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/auth-account.replay.test.ts, which
# sends the last request of each example.
describe "Account authentication endpoints", type: :request do
  include Parity::AudienceSignedIn

  let(:user) { create(:user, name: "Account User", username: "accountuser", email: "account-user@example.com", password: "a-long-password-1", created_at: Time.utc(2025, 1, 1)) }
  let(:json_headers) { { "Accept" => "application/json", "X-Requested-With" => "XMLHttpRequest", "X-CSRF-Token" => csrf_token } }

  before { host! DOMAIN }

  describe "POST /users/forgot_password" do
    it "sends the reset instructions", parity: true do
      post "/users/forgot_password", params: { authenticity_token: csrf_token, user: { email: user.email } }

      expect(response).to redirect_to(login_url)
      expect(response).to have_http_status(:see_other)
      expect(flash[:notice]).to eq("Password reset sent! Please make sure to check your spam folder.")
      expect(user.reload.reset_password_token).to be_present
    end

    it "refuses an address with no account and goes back", parity: true do
      post "/users/forgot_password", params: { authenticity_token: csrf_token, user: { email: "nobody@example.com" } }, headers: { "Referer" => "http://#{DOMAIN}/users/forgot_password/new" }

      expect(response).to redirect_to("http://#{DOMAIN}/users/forgot_password/new")
      expect(flash[:warning]).to eq("An account does not exist with that email.")
    end

    it "falls back to the login page without a referrer", parity: true do
      post "/users/forgot_password", params: { authenticity_token: csrf_token, user: { email: "not-an-email" } }

      expect(response).to redirect_to(login_url)
    end

    it "does not reset a deleted account", parity: true do
      user.update_columns(deleted_at: Time.current)
      post "/users/forgot_password", params: { authenticity_token: csrf_token, user: { email: user.email } }

      expect(flash[:warning]).to eq("An account does not exist with that email.")
    end

    it "reads a scalar user param as absent", parity: true do
      post "/users/forgot_password", params: { authenticity_token: csrf_token, user: "nope" }

      expect(response).to redirect_to(login_url)
    end
  end

  describe "PUT /users/forgot_password" do
    def reset_params(token, password: "a-new-long-password-2", confirmation: password)
      { authenticity_token: csrf_token, user: { reset_password_token: token, password:, password_confirmation: confirmation } }
    end

    it "resets the password and signs in", parity: true do
      token = user.send_reset_password_instructions
      put "/users/forgot_password", params: reset_params(token)

      expect(response).to redirect_to(root_path)
      expect(response).to have_http_status(:see_other)
      expect(flash[:notice]).to eq("Your password has been reset, and you're now logged in.")
      expect(user.reload.valid_password?("a-new-long-password-2")).to eq(true)
    end

    it "also answers PATCH", parity: true do
      token = user.send_reset_password_instructions
      patch "/users/forgot_password", params: reset_params(token)

      expect(response).to have_http_status(:see_other)
    end

    it "asks for two-factor authentication first", parity: true do
      user.update!(two_factor_authentication_enabled: true)
      token = user.send_reset_password_instructions
      put "/users/forgot_password", params: reset_params(token)

      expect(response).to redirect_to(two_factor_authentication_path(next: root_path))
      expect(flash[:notice]).to eq("Your password has been reset. Please complete two-factor authentication to continue.")
    end

    it "does not sign in a deleted account", parity: true do
      token = user.send_reset_password_instructions
      user.update_columns(deleted_at: Time.current)
      put "/users/forgot_password", params: reset_params(token)

      expect(response).to redirect_to(root_path)
      expect(flash[:notice]).to eq("Your password has been reset.")
    end

    it "refuses passwords that do not match", parity: true do
      token = user.send_reset_password_instructions
      put "/users/forgot_password", params: reset_params(token, confirmation: "something-else-1")

      expect(response).to redirect_to(edit_user_password_path(reset_password_token: token))
      expect(flash[:warning]).to eq("Those two passwords didn't match.")
    end

    it "refuses a password that is too short", parity: true do
      token = user.send_reset_password_instructions
      put "/users/forgot_password", params: reset_params(token, password: "abc")

      expect(flash[:warning]).to eq("Password is too short (minimum is 4 characters)")
    end

    it "refuses a blank password", parity: true do
      token = user.send_reset_password_instructions
      put "/users/forgot_password", params: reset_params(token, password: "", confirmation: "")

      expect(flash[:warning]).to eq("Password can't be blank")
    end

    it "refuses an unknown token", parity: true do
      put "/users/forgot_password", params: reset_params("unknown-token")

      expect(flash[:warning]).to eq("That reset password token doesn't look valid (or may have expired).")
    end

    it "refuses an expired token", parity: true do
      token = user.send_reset_password_instructions
      user.update_columns(reset_password_sent_at: 25.hours.ago)
      put "/users/forgot_password", params: reset_params(token)

      expect(flash[:warning]).to eq("That reset password token doesn't look valid (or may have expired).")
    end
  end

  describe "GET /users/confirmation" do
    let(:unconfirmed) { create(:user, name: "Unconfirmed", username: "unconfirmed1", email: "unconfirmed-user@example.com", confirmed_at: nil, created_at: Time.utc(2025, 1, 1)) }

    it "confirms the account and signs the visitor in", parity: true do
      get "/users/confirmation", params: { confirmation_token: unconfirmed.confirmation_token }

      expect(response).to have_http_status(:found)
      expect(flash[:notice]).to eq("Your account has been successfully confirmed!")
      expect(unconfirmed.reload).to be_confirmed
    end

    it "explains a token that no longer resolves", parity: true do
      get "/users/confirmation", params: { confirmation_token: "superseded-token" }

      expect(response).to redirect_to(root_url)
      expect(flash[:alert]).to start_with("This confirmation link is no longer valid.")
    end

    it "says an account was already confirmed", parity: true do
      token = unconfirmed.confirmation_token
      unconfirmed.confirm
      get "/users/confirmation", params: { confirmation_token: token }

      expect(response).to redirect_to(root_url)
      expect(flash[:alert]).to eq("You have already been confirmed.")
    end

    it "keeps another signed-in visitor signed in as themselves", parity: true do
      log_in(user)
      get "/users/confirmation", params: { confirmation_token: unconfirmed.confirmation_token }

      expect(response).to have_http_status(:found)
      expect(unconfirmed.reload).to be_confirmed
    end
  end

  describe "PUT /user/invalidate_active_sessions" do
    it "signs the visitor out everywhere", parity: true do
      log_in(user)
      put "/user/invalidate_active_sessions", headers: json_headers

      expect(response).to be_successful
      expect(response.parsed_body).to eq("success" => true)
      expect(user.reload.last_active_sessions_invalidated_at).to be_present
    end

    it "also answers PATCH", parity: true do
      log_in(user)
      patch "/user/invalidate_active_sessions", headers: json_headers

      expect(response).to be_successful
    end

    it "refuses a team member who is not the owner", parity: true do
      member = create(:user, name: "Team Member")
      membership = create(:team_membership, user: member, seller: user, role: TeamMembership::ROLE_MARKETING)
      log_in(member)
      switch_to(membership)
      put "/user/invalidate_active_sessions", headers: json_headers

      expect(response).to have_http_status(:unauthorized)
    end
  end

  describe "session endpoints" do
    it "tells a signed-in visitor so", parity: true do
      log_in(user)
      get "/users/session_info"

      expect(response.parsed_body).to eq("success" => true, "is_signed_in" => true)
    end

    it "tells a signed-out visitor so", parity: true do
      get "/users/session_info"

      expect(response.parsed_body).to eq("success" => true, "is_signed_in" => false)
    end

    it "returns the current seller", parity: true do
      log_in(user)
      get "/users/current_user_data"

      expect(response).to be_successful
      expect(response.parsed_body["success"]).to eq(true)
    end

    it "refuses a signed-out visitor", parity: true do
      get "/users/current_user_data"

      expect(response).to have_http_status(:unauthorized)
      expect(response.parsed_body).to eq("success" => false)
    end

    it "says whether Twitter is linked", parity: true do
      log_in(user)
      get "/users/check_twitter_link"

      expect(response.parsed_body).to eq("success" => false)
    end
  end

  describe "GET /users/unsubscribe/:id" do
    def token(account) = account.secure_external_id(scope: "email_unsubscribe", expires_at: 2.days.from_now)

    {
      "notify" => "You have been unsubscribed from purchase notifications.",
      "free_downloads" => "You have been unsubscribed from free download notifications.",
      "seller_update" => "You have been unsubscribed from weekly sales updates.",
      "product_update" => "You have been unsubscribed from Gumroad announcements.",
    }.each do |email_type, message|
      it "unsubscribes from #{email_type}", parity: true do
        get "/users/unsubscribe/#{token(user)}", params: { email_type: }

        expect(response).to redirect_to(root_path)
        expect(flash[:notice]).to eq(message)
      end
    end

    it "changes nothing for an unknown email type", parity: true do
      get "/users/unsubscribe/#{token(user)}", params: { email_type: "nothing" }

      expect(response).to redirect_to(root_path)
    end

    it "lets a signed-in visitor use their own external id", parity: true do
      log_in(user)
      get "/users/unsubscribe/#{user.external_id}", params: { email_type: "notify" }

      expect(response).to redirect_to(root_path)
    end

    it "is a 404 for an unknown id", parity: true do
      get "/users/unsubscribe/does-not-exist", params: { email_type: "notify" }

      expect(response).to have_http_status(:not_found)
    end
  end
end
