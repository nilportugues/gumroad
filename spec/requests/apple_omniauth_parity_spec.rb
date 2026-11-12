# frozen_string_literal: true

require "spec_helper"

# Sign in with Apple: the request phase (the redirect to Apple and the signed nonce cookie), and the form_post callback that carries a code and
# an id_token. Recorded for the Next.js port (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/apple-omniauth.replay.test.ts against a
# stand-in server that serves the recorded JWKS and token answers, holds Node to the recorded calls in order, and checks the ES256 client secret
# in the token call with the public half of the test key (spec/support/fixtures/apple_web_test_key.pem, the key the recording boots with).
# The id_token is signed with a throwaway RSA key whose public half is the recorded JWKS. The OmniAuth middleware runs for real (test_mode off).
# An example named "hands ..." is one Node leaves to Rails: Apple's code is spent by the token call, so a sign-in that would create an account or
# change one is handed back before anything is asked of Apple.
describe "Sign in with Apple", type: :request do
  include Parity::AudienceSignedIn

  let(:apple) { "https://appleid.apple.com" }
  let(:apple_sub) { "001234.abcdef0123456789.0042" }
  let(:json) { { "Content-Type" => "application/json;charset=UTF-8" } }
  let(:rsa) { OpenSSL::PKey::RSA.new(2048) }
  let(:kid) { "apple-test-kid" }
  let(:user) { create(:named_seller, name: "Apple Visitor", email: "apple.user@example.com") }

  around do |example|
    previous = OmniAuth.config.test_mode
    OmniAuth.config.test_mode = false
    example.run
  ensure
    OmniAuth.config.test_mode = previous
  end

  before do
    host! DOMAIN
    allow(ViteRuby.instance.manifest).to receive(:resolve_entries).and_return({ stylesheets: ["/vite-test.css"] })
    allow_any_instance_of(ActionView::Base).to receive(:vite_client_tag).and_return("")
    allow_any_instance_of(ActionView::Base).to receive(:vite_react_refresh_tag).and_return("")
    allow_any_instance_of(ActionView::Base).to receive(:vite_typescript_tag).and_return("")
  end

  def begin_flow(params = {})
    post "/users/auth/apple", params: { authenticity_token: csrf_token }.merge(params)
    expect(response).to have_http_status(:found)
    @nonce = Rack::Utils.parse_query(URI(response.location).query)["nonce"]
    # Apple posts back from another site, so the browser leaves its SameSite=Lax session cookie behind and sends only the nonce cookie.
    cookies.to_hash.each_key { |name| cookies.delete(name) if name.include?("session") }
  end

  def id_token(sub: apple_sub, email: "apple.user@example.com", aud: APPLE_CLIENT_ID, iss: apple, iat: Time.now.to_i - 30, exp: Time.now.to_i + 600,
               nonce: @nonce, claims: {}, key: rsa, header_kid: kid, email_verified: "true")
    payload = { iss:, aud:, exp:, iat:, sub:, nonce:, nonce_supported: true, email:, email_verified:, is_private_email: "false", auth_time: iat }.merge(claims).compact
    jwt = JSON::JWT.new(payload)
    jwt.kid = header_kid
    jwt.sign(key, :RS256).to_s
  end

  def stub_keys(status: 200, body: nil)
    jwk = JSON::JWK.new(rsa.public_key, kid:, use: "sig", alg: "RS256")
    stub_request(:get, "#{apple}/auth/keys").to_return(status:, headers: json, body: (body || { keys: [jwk] }).to_json)
  end

  def stub_token(status: 200, body: { access_token: "apple-access-token", token_type: "Bearer", expires_in: 3600, refresh_token: "apple-refresh-token", id_token: "unused" })
    stub_request(:post, "#{apple}/auth/token").to_return(status:, headers: json, body: body.to_json)
  end

  def callback(token: id_token, **params)
    post "/users/auth/apple/callback", params: { code: "apple-code-1", state: "ignored", id_token: token }.merge(params)
  end

  def link_apple_identity(owner = user)
    owner.user_external_authentications.create!(provider: "apple", uid: apple_sub)
    # Sign-in stamps updated_at; a row that is not seconds old keeps the change clear of the replay's "<now>" tolerance.
    owner.update_columns(updated_at: 1.hour.ago)
    owner
  end

  describe "POST /users/auth/apple" do
    it "sends a visitor to Apple with a nonce that a signed cookie remembers", parity: true do
      post "/users/auth/apple", params: { authenticity_token: csrf_token }

      expect(response.location).to start_with("#{apple}/auth/authorize?")
      query = Rack::Utils.parse_query(URI(response.location).query)
      expect(query).to include("client_id" => APPLE_CLIENT_ID, "response_type" => "code", "response_mode" => "form_post", "scope" => "email name",
                               "redirect_uri" => "#{PROTOCOL}://#{DOMAIN}/users/auth/apple/callback")
      expect(set_cookies).to include("_apple_oauth_nonce=")
      expect(set_cookies.downcase).to include("samesite=none", "path=/users/auth/apple", "max-age=300", "httponly")
    end

    it "keeps the page a visitor asked to return to in the cookie", parity: true do
      post "/users/auth/apple", params: { authenticity_token: csrf_token, referer: "/library" }

      expect(response).to have_http_status(:found)
      expect(set_cookies).to include("_apple_oauth_nonce=")
    end

    it "hands a request with a wrong authenticity token to Rails", parity: true do
      post "/users/auth/apple", params: { authenticity_token: "wrong" }

      expect(response).to have_http_status(:found)
    end
  end

  describe "POST /users/auth/apple/callback" do
    before { stub_keys }

    it "signs in a user who signed in with Apple before", parity: true do
      link_apple_identity
      begin_flow
      stub_token

      callback

      expect(response).to redirect_to("/dashboard")
      expect(user.reload.sign_in_count).to eq(1)
      expect(a_request(:post, "#{apple}/auth/token").with { |request| request.body.include?("grant_type=authorization_code") && request.body.include?("code=apple-code-1") }).to have_been_made
    end

    it "sends a user back to the page the sign-in started from", parity: true do
      link_apple_identity
      begin_flow(referer: "/library")
      stub_token

      callback

      expect(response).to redirect_to("/library")
    end

    it "signs in a user with the private relay address Apple gave", parity: true do
      relay_user = create(:user, name: "Relay User", email: "relay@privaterelay.appleid.com")
      link_apple_identity(relay_user)
      begin_flow
      stub_token

      callback(token: id_token(email: "relay@privaterelay.appleid.com", claims: { is_private_email: "true" }), user: { name: { firstName: "Relay", lastName: "User" } }.to_json)

      expect(response).to redirect_to("/dashboard")
    end

    it "does not let in a user whose account was deleted", parity: true do
      link_apple_identity
      user.update_columns(deleted_at: Time.current)
      begin_flow
      stub_token

      callback

      expect(response).to redirect_to("/login")
      expect(flash[:alert]).to eq(User::DELETED_ACCOUNT_LOGIN_ERROR)
    end

    it "sends a visitor to the login page when Apple refuses the code", parity: true do
      link_apple_identity
      begin_flow
      stub_token(status: 400, body: { error: "invalid_grant", error_description: "The code has expired or has been revoked." })

      callback

      expect(response).to redirect_to("/users/sign_in")
      expect(flash[:alert]).to eq("Could not authenticate you from Apple because \"Invalid credentials\".")
    end

    {
      "an id_token signed with another key" => -> { id_token(key: OpenSSL::PKey::RSA.new(2048)) },
      "an id_token for another app" => -> { id_token(aud: "com.example.other") },
      "an id_token from another issuer" => -> { id_token(iss: "https://accounts.example.com") },
      "an id_token that has expired" => -> { id_token(exp: Time.now.to_i - 60) },
      "an id_token issued in the future" => -> { id_token(iat: Time.now.to_i + 3600) },
      "an id_token for another nonce" => -> { id_token(nonce: "another-nonce") },
      "an id_token with a key id Apple does not publish" => -> { id_token(header_kid: "unknown-kid") },
    }.each do |label, build|
      it "sends a visitor with #{label} to the login page without asking Apple for a token", parity: true do
        link_apple_identity
        begin_flow

        callback(token: instance_exec(&build))

        expect(response).to redirect_to("/users/sign_in")
        expect(flash[:alert]).to start_with("Could not authenticate you from Apple because")
        expect(a_request(:post, "#{apple}/auth/token")).not_to have_been_made
      end
    end

    it "sends a visitor to the login page when Apple's keys cannot be fetched", parity: true do
      link_apple_identity
      stub_keys(status: 500, body: { error: "server_error" })
      begin_flow

      callback

      expect(response).to redirect_to("/users/sign_in")
      expect(flash[:alert]).to start_with("Could not authenticate you from Apple because")
    end

    it "treats a callback with no nonce cookie as a nonce mismatch", parity: true do
      link_apple_identity
      begin_flow
      cookies.delete("_apple_oauth_nonce")

      callback

      expect(response).to redirect_to("/users/sign_in")
      expect(flash[:alert]).to start_with("Could not authenticate you from Apple because")
    end

    def new_apple_callback(sub: "001234.newuser.0001", email: "new.apple@example.com", name: { firstName: "New", lastName: "Visitor" }, **claims)
      begin_flow
      stub_token
      params = name ? { user: { name: }.to_json } : {}
      callback(token: id_token(sub:, email:, **claims), **params)
    end

    it "creates an account for the first sign-in with Apple", parity: true do
      new_apple_callback

      expect(response).to redirect_to("/dashboard")
      created = User.find_by!(email: "new.apple@example.com")
      expect(created).to have_attributes(name: "New Visitor", provider: "apple", sign_in_count: 1)
      expect(created).to be_confirmed
      expect(created.user_external_authentications.pluck(:provider, :uid)).to eq([["apple", "001234.newuser.0001"]])
      expect(AttachPastPurchasesToUserWorker.jobs.size).to eq(1)
    end

    it "sends the first sign-in back to the page it started from", parity: true do
      begin_flow(referer: "/library")
      stub_token

      callback(token: id_token(sub: "001234.newuser.0002", email: "second.apple@example.com"))

      expect(response).to redirect_to("/library")
      expect(User.find_by!(email: "second.apple@example.com").name).to be_nil
    end

    it "creates an account with no address when Apple sent none", parity: true do
      new_apple_callback(sub: "001234.noemail.0003", email: nil)

      expect(response).to redirect_to("/dashboard")
      created = User.find_by!(name: "New Visitor")
      expect(created.email).to be_blank
      expect(created.user_external_authentications.pluck(:uid)).to eq(["001234.noemail.0003"])
    end

    it "creates an account for the private relay address with the colon of a name removed", parity: true do
      new_apple_callback(sub: "001234.relay.0004", email: "relay.new@privaterelay.appleid.com", name: { firstName: "Re:lay", lastName: "New" },
                         claims: { is_private_email: "true" })

      expect(response).to redirect_to("/dashboard")
      expect(User.find_by!(email: "relay.new@privaterelay.appleid.com").name).to eq("Relay New")
    end

    it "sends a first sign-in with an address Apple has not verified to the signup page", parity: true do
      new_apple_callback(sub: "001234.unverified.0005", email: "unverified.apple@example.com", email_verified: "false")

      expect(response).to redirect_to("/signup")
      expect(flash[:alert]).to eq("Sorry, something went wrong. Please try again.")
      expect(User.where(email: "unverified.apple@example.com")).to be_empty
    end

    it "sends a first sign-in the account rules refuse to the signup page", parity: true do
      new_apple_callback(sub: "001234.disposable.0006", email: "visitor@mailinator.com")

      expect(response).to redirect_to("/signup")
      expect(flash[:alert]).to eq("Sorry, something went wrong. Please try again.")
      expect(UserExternalAuthentication.where(uid: "001234.disposable.0006")).to be_empty
    end

    it "links the Apple identity to the confirmed account that has the same address", parity: true do
      user.update_columns(updated_at: 1.hour.ago)
      old_digest = user.reload.encrypted_password
      begin_flow
      stub_token

      callback

      expect(response).to redirect_to("/dashboard")
      expect(user.reload.encrypted_password).not_to eq(old_digest)
      expect(user.last_active_sessions_invalidated_at).to be_present
      expect(user.user_external_authentications.pluck(:provider, :uid)).to eq([["apple", apple_sub]])
    end

    it "links the Apple identity to an account that signed up with another provider", parity: true do
      user.update_columns(provider: "google_oauth2", updated_at: 1.hour.ago)
      begin_flow
      stub_token

      callback

      expect(response).to redirect_to("/dashboard")
      expect(user.reload.provider).to eq("google_oauth2")
      expect(user.last_active_sessions_invalidated_at).to be_nil
      expect(user.user_external_authentications.pluck(:uid)).to eq([apple_sub])
    end

    it "does not let in a deleted account that has the same address", parity: true do
      user.update_columns(deleted_at: Time.current, updated_at: 1.hour.ago)
      begin_flow
      stub_token

      callback

      expect(response).to redirect_to("/login")
      expect(flash[:alert]).to eq(User::DELETED_ACCOUNT_LOGIN_ERROR)
    end

    it "hands a sign-in that would adopt an unconfirmed account to Rails", parity: true do
      user.update_columns(confirmed_at: nil, confirmation_token: "pending-token")
      begin_flow
      stub_token

      callback

      expect(response).to have_http_status(:found)
    end

    it "hands a first sign-in whose address has guest purchases to Rails", parity: true do
      build(:purchase, email: "new.apple@example.com", purchaser: nil, purchase_state: "successful").save!(validate: false)
      new_apple_callback

      expect(response).to have_http_status(:found)
    end

    it "gives a user with no name the name Apple sent", parity: true do
      link_apple_identity
      user.update_columns(name: nil)
      begin_flow
      stub_token

      callback(user: { name: { firstName: "Apple", lastName: "Visitor" } }.to_json)

      expect(response).to redirect_to("/dashboard")
      expect(user.reload.name).to eq("Apple Visitor")
    end

    it "keeps a user's name when Apple sends another", parity: true do
      link_apple_identity
      begin_flow
      stub_token

      callback(user: { name: { firstName: "Someone", lastName: "Else" } }.to_json)

      expect(response).to redirect_to("/dashboard")
      expect(user.reload.name).to eq("Apple Visitor")
    end

    it "signs in a user with a pending email change without confirming it", parity: true do
      link_apple_identity
      user.update_columns(unconfirmed_email: "changed@example.com")
      begin_flow
      stub_token

      callback

      expect(response).to redirect_to("/dashboard")
      expect(user.reload.unconfirmed_email).to eq("changed@example.com")
    end

    it "confirms a user who has not confirmed the address yet", parity: true do
      link_apple_identity
      user.update_columns(confirmed_at: nil, confirmation_token: "pending-token", reset_password_token: "stale", reset_password_sent_at: 1.day.ago)
      begin_flow
      stub_token

      callback

      expect(response).to redirect_to("/dashboard")
      expect(user.reload).to be_confirmed
      expect(user.reset_password_token).to be_nil
    end

    it "hands a callback without an id_token to Rails", parity: true do
      link_apple_identity
      begin_flow
      stub_token

      post "/users/auth/apple/callback", params: { code: "apple-code-1", state: "ignored" }

      expect(response).to have_http_status(:found)
    end
  end
end
