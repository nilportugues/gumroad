# frozen_string_literal: true

require "spec_helper"

# POST /mobile/forgot_password on the API host (User::PasswordsController#create through the mobile route), recorded for the Next.js port
# (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/auth-mutations.replay.test.ts, which sends the last request of each example. An
# example named "hands ..." is one Node leaves to Rails: the replay asserts it reached Rails and wrote nothing.
describe "Mobile forgot password", type: :request do
  include Parity::AudienceSignedIn
  include Parity::MobileApi

  let!(:user) { create(:user, email: "mobile-reset@example.com", username: "mobilereset", password: "a-long-password-1") }

  it "sends the reset instructions and redirects to the login page", parity: true do
    post "/mobile/forgot_password", params: { user: { email: user.email } }

    expect(response).to have_http_status(:see_other)
    expect(user.reload.reset_password_token).to be_present
  end

  it "answers an unknown address with the warning redirect", parity: true do
    post "/mobile/forgot_password", params: { user: { email: "nobody@example.com" } }

    expect(response).to have_http_status(:found)
  end

  it "answers a malformed address with the warning redirect", parity: true do
    post "/mobile/forgot_password", params: { user: { email: "not-an-email" } }

    expect(response).to have_http_status(:found)
  end

  it "answers a request with no user", parity: true do
    post "/mobile/forgot_password"

    expect(response).to have_http_status(:found)
  end

  it "does not send instructions to a deleted account", parity: true do
    user.update_columns(deleted_at: Time.current)
    post "/mobile/forgot_password", params: { user: { email: user.email } }

    expect(response).to have_http_status(:found)
  end

  it "goes back to the referrer after a refusal", parity: true do
    post "/mobile/forgot_password", params: { user: { email: "nobody@example.com" } }, headers: { "Referer" => "http://#{API_DOMAIN}/somewhere" }

    expect(response).to have_http_status(:found)
  end

  it "accepts a JSON body", parity: true do
    post "/mobile/forgot_password", params: { user: { email: user.email } }.to_json, headers: { "Content-Type" => "application/json" }

    expect(response).to have_http_status(:see_other)
  end
end
