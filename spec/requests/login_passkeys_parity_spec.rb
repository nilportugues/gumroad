# frozen_string_literal: true

require "spec_helper"
require "webauthn/fake_client"

# Passkey login (POST /login/passkey/options and POST /login/passkey), recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/login-passkeys.replay.test.ts, which sends the last request of each example with the session cookie of the
# recording. An assertion is a deterministic function of the challenge in that session and the stored public key, so the replay
# proves Node's WebAuthn verification by replaying a recorded valid assertion and the tampered variants of it. An example named
# "hands ..." is one Node leaves to Rails.
describe "Passkey login", type: :request do
  include Parity::SignedInDashboard

  let(:user) { create(:user, email: "passkey-user@example.com", password: "a-long-password-1", created_at: Time.utc(2025, 1, 1), updated_at: Time.utc(2025, 1, 1)) }
  let(:origin) { "#{PROTOCOL}://#{DOMAIN}" }
  let(:rp_id) { WebAuthn.configuration.rp_id }
  # The relying party the authenticator registered the passkey for; a passkey of another one signs over another rp id hash.
  let(:registered_rp_id) { rp_id }
  let(:fake_client) { WebAuthn::FakeClient.new(origin) }
  let(:stored_sign_count) { 0 }
  let!(:stored_credential) do
    creation_challenge = WebAuthn::Credential.options_for_create(user: { id: user.external_id, name: user.email }).challenge
    created = fake_client.create(challenge: creation_challenge, rp_id: registered_rp_id, user_verified: true)
    credential = WebAuthn::Credential.from_create(created)
    user.webauthn_credentials.create!(webauthn_id: credential.id, public_key: credential.public_key, sign_count: stored_sign_count, nickname: "Test passkey", created_at: Time.utc(2025, 1, 2), updated_at: Time.utc(2025, 1, 2))
  end

  def json_headers(token)
    { "Content-Type" => "application/json", "Accept" => "application/json", "X-CSRF-Token" => token }
  end

  # The challenge the options request stored in the session, and the CSRF token of the same browser.
  def request_options
    token = csrf_token
    post "/login/passkey/options", params: "{}", headers: json_headers(token)
    [token, response.parsed_body.dig("options", "challenge")]
  end

  def assertion(challenge, client: fake_client, **options)
    client.get(challenge:, rp_id: registered_rp_id, user_verified: true, sign_count: 1, **options)
  end

  def sign_in_with(credential, token, **extra)
    post "/login/passkey", params: { credential:, **extra }.to_json, headers: json_headers(token)
  end

  def tampered_signature(credential)
    bytes = Base64.urlsafe_decode64(credential["response"]["signature"]).bytes
    bytes[bytes.length - 1] ^= 0x01
    credential.deep_merge("response" => { "signature" => Base64.urlsafe_encode64(bytes.pack("C*"), padding: false) })
  end

  def expect_refused
    expect(response).to have_http_status(:unprocessable_entity)
    expect(response.parsed_body).to eq("success" => false, "error_message" => Logins::PasskeysController::AUTHENTICATION_ERROR_MESSAGE)
    expect(set_cookies).not_to include("remember_user_token=")
  end

  describe "POST /login/passkey/options" do
    it "issues assertion options for the discoverable flow and keeps the challenge in the session", parity: true do
      token = csrf_token

      post "/login/passkey/options", params: "{}", headers: json_headers(token)

      expect(response).to have_http_status(:ok)
      options = response.parsed_body.fetch("options")
      expect(response.parsed_body["success"]).to eq(true)
      expect(options["allowCredentials"]).to eq([])
      expect(options["userVerification"]).to eq("required")
      expect(options["rpId"]).to eq(rp_id)
      expect(Base64.urlsafe_decode64(options["challenge"]).bytesize).to eq(32)
    end
  end

  describe "POST /login/passkey" do
    it "signs the user in with a valid assertion and remembers the browser", parity: true do
      token, challenge = request_options

      sign_in_with(assertion(challenge), token)

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body).to eq("success" => true, "redirect_location" => "/dashboard")
      expect(set_cookies).to include("remember_user_token=")
      expect(stored_credential.reload.sign_count).to eq(1)
      expect(stored_credential.last_used_at).to be_present
      expect(user.reload.sign_in_count).to eq(1)
    end

    # A passkey whose COSE key names RS256 or PS256 (the other algorithms webauthn-ruby offers by default). FakeClient only makes ES256 keys, so the
    # assertion is signed here over the same authenticator data and client data hash.
    describe "with an RSA passkey" do
      let(:rsa_key) { OpenSSL::PKey::RSA.generate(2048) }
      let(:rsa_credential_id) { Base64.urlsafe_encode64("rsa-passkey-credential-id", padding: false) }
      let(:cose_algorithm) { -257 }
      let!(:rsa_credential) do
        cose_key = COSE::Key::RSA.new(n: rsa_key.params["n"].to_s(2), e: rsa_key.params["e"].to_s(2), alg: cose_algorithm)
        user.webauthn_credentials.create!(webauthn_id: rsa_credential_id, public_key: Base64.urlsafe_encode64(cose_key.serialize, padding: false), sign_count: 0, nickname: "RSA passkey", created_at: Time.utc(2025, 1, 2), updated_at: Time.utc(2025, 1, 2))
      end

      def rsa_assertion(challenge, pss: cose_algorithm == -37, sign_count: 1)
        authenticator_data = Digest::SHA256.digest(rp_id) + [0x05, sign_count].pack("CN")
        client_data_json = { type: "webauthn.get", challenge:, origin:, crossOrigin: false }.to_json
        data = authenticator_data + Digest::SHA256.digest(client_data_json)
        signature = pss ? rsa_key.sign_pss("SHA256", data, salt_length: :max, mgf1_hash: "SHA256") : rsa_key.sign("SHA256", data)
        encode = ->(bytes) { Base64.urlsafe_encode64(bytes, padding: false) }
        { "type" => "public-key", "id" => rsa_credential_id, "rawId" => rsa_credential_id, "response" => { "authenticatorData" => encode.(authenticator_data), "clientDataJSON" => encode.(client_data_json), "signature" => encode.(signature) } }
      end

      it "signs the user in with an RS256 assertion", parity: true do
        token, challenge = request_options

        sign_in_with(rsa_assertion(challenge), token)

        expect(response).to have_http_status(:ok)
        expect(response.parsed_body).to eq("success" => true, "redirect_location" => "/dashboard")
        expect(rsa_credential.reload.sign_count).to eq(1)
      end

      it "refuses an RS256 signature that does not verify", parity: true do
        token, challenge = request_options

        sign_in_with(tampered_signature(rsa_assertion(challenge)), token)

        expect_refused
      end

      it "refuses an RS256 signature of the wrong length", parity: true do
        token, challenge = request_options
        short = rsa_assertion(challenge).deep_merge("response" => { "signature" => Base64.urlsafe_encode64("too short", padding: false) })

        sign_in_with(short, token)

        expect_refused
      end

      context "when the key names PS256" do
        let(:cose_algorithm) { -37 }

        it "signs the user in with a PS256 assertion", parity: true do
          token, challenge = request_options

          sign_in_with(rsa_assertion(challenge), token)

          expect(response).to have_http_status(:ok)
          expect(response.parsed_body).to eq("success" => true, "redirect_location" => "/dashboard")
        end

        it "refuses a PS256 signature that does not verify", parity: true do
          token, challenge = request_options

          sign_in_with(tampered_signature(rsa_assertion(challenge)), token)

          expect_refused
        end

        it "refuses a PKCS#1 signature", parity: true do
          token, challenge = request_options

          sign_in_with(rsa_assertion(challenge, pss: false), token)

          expect_refused
        end
      end
    end

    it "signs in a user who has two-factor authentication on, without the challenge", parity: true do
      user.update!(two_factor_authentication_enabled: true)
      user.update_columns(updated_at: Time.utc(2025, 1, 1))
      token, challenge = request_options

      sign_in_with(assertion(challenge), token)

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body["redirect_location"]).to eq("/dashboard")
    end

    it "sends the user to the next path it was given", parity: true do
      token, challenge = request_options

      sign_in_with(assertion(challenge), token, next: "/products")

      expect(response.parsed_body).to eq("success" => true, "redirect_location" => "/products")
    end

    it "accepts a counter above the stored one", parity: true do
      stored_credential.update_columns(sign_count: 3)
      token, challenge = request_options

      sign_in_with(assertion(challenge, sign_count: 7), token)

      expect(response).to have_http_status(:ok)
      expect(stored_credential.reload.sign_count).to eq(7)
    end

    it "accepts an assertion with a user handle", parity: true do
      token, challenge = request_options

      sign_in_with(assertion(challenge, user_handle: user.external_id), token)

      expect(response).to have_http_status(:ok)
    end

    it "refuses a request that follows no options request", parity: true do
      token = csrf_token

      sign_in_with(assertion(Base64.urlsafe_encode64(SecureRandom.random_bytes(32), padding: false)), token)

      expect_refused
    end

    it "refuses a credential nobody registered", parity: true do
      other = WebAuthn::FakeClient.new(origin)
      other.create(challenge: Base64.urlsafe_encode64(SecureRandom.random_bytes(32), padding: false), rp_id:, user_verified: true)
      token, challenge = request_options

      sign_in_with(assertion(challenge, client: other), token)

      expect_refused
    end

    it "refuses an assertion over another challenge", parity: true do
      token, = request_options

      sign_in_with(assertion(Base64.urlsafe_encode64(SecureRandom.random_bytes(32), padding: false)), token)

      expect_refused
    end

    it "refuses a signature that does not verify", parity: true do
      token, challenge = request_options

      sign_in_with(tampered_signature(assertion(challenge)), token)

      expect_refused
    end

    # OpenSSL raises for a signature it cannot parse and nothing rescues it, so Rails answers 500; Node hands such a request back.
    it "raises for a signature that is not a DER sequence" do
      token, challenge = request_options
      garbage = assertion(challenge).deep_merge("response" => { "signature" => Base64.urlsafe_encode64("not der at all", padding: false) })

      expect { sign_in_with(garbage, token) }.to raise_error(OpenSSL::PKey::PKeyError)
    end

    # Authenticator data longer than its 37 fixed bytes: attested credential data (flag 0x40) and extension data (flag 0x80). FakeClient never
    # writes either, so the passkey is an EC key of the spec's own and the assertion is signed here over the extended data.
    describe "with authenticator data that carries attested credential or extension data" do
      let(:ec_key) { OpenSSL::PKey::EC.generate("prime256v1") }
      let(:ec_credential_id) { Base64.urlsafe_encode64("ec-passkey-credential-id", padding: false) }
      let(:cose_key) { COSE::Key::EC2.from_pkey(OpenSSL::PKey.read(ec_key.public_to_der)).tap { _1.alg = -7 }.serialize }
      let(:attested_credential_data) { ("\0" * 16) + [3].pack("n") + "abc" + cose_key }
      let(:extensions) { "\xA1\x61a\x01".b }
      let!(:ec_credential) do
        user.webauthn_credentials.create!(webauthn_id: ec_credential_id, public_key: Base64.urlsafe_encode64(cose_key, padding: false), sign_count: 0, nickname: "EC passkey", created_at: Time.utc(2025, 1, 2), updated_at: Time.utc(2025, 1, 2))
      end

      def extended_assertion(challenge, flags: 0x05, tail: "".b)
        authenticator_data = Digest::SHA256.digest(rp_id) + [flags, 1].pack("CN") + tail.b
        client_data_json = { type: "webauthn.get", challenge:, origin:, crossOrigin: false }.to_json
        signature = ec_key.sign("SHA256", authenticator_data + Digest::SHA256.digest(client_data_json))
        encode = ->(bytes) { Base64.urlsafe_encode64(bytes, padding: false) }
        { "type" => "public-key", "id" => ec_credential_id, "rawId" => ec_credential_id, "response" => { "authenticatorData" => encode.(authenticator_data), "clientDataJSON" => encode.(client_data_json), "signature" => encode.(signature) } }
      end

      it "signs the user in with extension data that is one CBOR item", parity: true do
        token, challenge = request_options

        sign_in_with(extended_assertion(challenge, flags: 0x85, tail: extensions), token)

        expect(response).to have_http_status(:ok)
        expect(ec_credential.reload.sign_count).to eq(1)
      end

      it "refuses extension data that is null", parity: true do
        token, challenge = request_options

        sign_in_with(extended_assertion(challenge, flags: 0x85, tail: "\xF6"), token)

        expect_refused
      end

      it "refuses extension data followed by more bytes", parity: true do
        token, challenge = request_options

        sign_in_with(extended_assertion(challenge, flags: 0x85, tail: "\xA0\x00"), token)

        expect_refused
      end

      it "signs the user in with attested credential data holding an ES256 key", parity: true do
        token, challenge = request_options

        sign_in_with(extended_assertion(challenge, flags: 0x45, tail: attested_credential_data), token)

        expect(response).to have_http_status(:ok)
      end

      it "signs the user in with attested credential data followed by extension data", parity: true do
        token, challenge = request_options

        sign_in_with(extended_assertion(challenge, flags: 0xC5, tail: attested_credential_data + extensions), token)

        expect(response).to have_http_status(:ok)
      end

      it "refuses bytes left over after attested credential data", parity: true do
        token, challenge = request_options

        sign_in_with(extended_assertion(challenge, flags: 0x45, tail: attested_credential_data + "zz"), token)

        expect_refused
      end

      it "refuses bytes the flags do not announce", parity: true do
        token, challenge = request_options

        sign_in_with(extended_assertion(challenge, tail: "zz"), token)

        expect_refused
      end

      it "hands attested credential data whose key has no coordinates to Rails", parity: true do
        token, challenge = request_options

        sign_in_with(extended_assertion(challenge, flags: 0x45, tail: ("\0" * 16) + [3].pack("n") + "abc" + "\xA2\x01\x02\x03\x26".b), token)

        expect_refused
      end

      # Nothing rescues the EOFError of CBOR.decode(""), so Rails answers 500; Node hands such a request back.
      it "raises for extension data that is empty" do
        token, challenge = request_options

        expect { sign_in_with(extended_assertion(challenge, flags: 0x85), token) }.to raise_error(EOFError)
      end
    end

    it "refuses an assertion from another origin", parity: true do
      token, challenge = request_options
      fake_client.instance_variable_set(:@origin, "https://evil.example.com")

      sign_in_with(assertion(challenge), token)

      expect_refused
    end

    context "when the passkey was registered for another relying party" do
      let(:registered_rp_id) { "evil.example.com" }

      it "refuses an assertion signed over another rp id hash", parity: true do
        token, challenge = request_options

        sign_in_with(assertion(challenge), token)

        expect_refused
      end
    end

    it "refuses an authenticator that did not verify the user", parity: true do
      token, challenge = request_options

      sign_in_with(fake_client.get(challenge:, rp_id: registered_rp_id, user_verified: false, sign_count: 1), token)

      expect_refused
    end

    it "refuses an assertion with no user presence", parity: true do
      token, challenge = request_options

      sign_in_with(fake_client.get(challenge:, rp_id: registered_rp_id, user_present: false, user_verified: false, sign_count: 1), token)

      expect_refused
    end

    it "refuses a counter that did not advance", parity: true do
      stored_credential.update_columns(sign_count: 10)
      token, challenge = request_options

      sign_in_with(assertion(challenge, sign_count: 5), token)

      expect_refused
      expect(stored_credential.reload.sign_count).to eq(10)
    end

    it "accepts a counter of zero from a credential that never counted", parity: true do
      token, challenge = request_options

      sign_in_with(assertion(challenge, sign_count: 0), token)

      expect(response).to have_http_status(:ok)
    end

    it "refuses a deleted user", parity: true do
      user.update_columns(deleted_at: Time.utc(2025, 2, 1))
      token, challenge = request_options

      sign_in_with(assertion(challenge), token)

      expect_refused
      expect(stored_credential.reload.last_used_at).to be_nil
    end

    it "refuses a credential id that is not base64url", parity: true do
      token, challenge = request_options

      sign_in_with(assertion(challenge).merge("id" => "not base64!"), token)

      expect_refused
    end

    it "refuses a raw id that is not the credential id", parity: true do
      token, challenge = request_options

      sign_in_with(assertion(challenge).merge("rawId" => Base64.urlsafe_encode64("something else", padding: false)), token)

      expect_refused
    end

    it "refuses a credential of another type", parity: true do
      token, challenge = request_options

      sign_in_with(assertion(challenge).merge("type" => "password"), token)

      expect_refused
    end

    it "refuses a missing credential", parity: true do
      token, = request_options

      post "/login/passkey", params: "{}", headers: json_headers(token)

      expect_refused
    end

    it "refuses a credential that is not an object", parity: true do
      token, = request_options

      post "/login/passkey", params: { credential: "passkey" }.to_json, headers: json_headers(token)

      expect_refused
    end

    it "refuses a response with no signature", parity: true do
      token, challenge = request_options
      malformed = assertion(challenge)
      malformed["response"].delete("signature")

      sign_in_with(malformed, token)

      expect_refused
    end


    describe "when the browser is already signed in" do
      let(:other_user) { create(:user, email: "other-user@example.com", password: "a-long-password-2", created_at: Time.utc(2025, 1, 1), updated_at: Time.utc(2025, 1, 1)) }

      it "issues assertion options to a signed-in visitor", parity: true do
        log_in(user)
        token = csrf_token

        post "/login/passkey/options", params: "{}", headers: json_headers(token)

        expect(response).to have_http_status(:ok)
        expect(response.parsed_body["success"]).to eq(true)
        expect(response.parsed_body.dig("options", "rpId")).to eq(rp_id)
      end

      it "signs in again with the passkey of the account it is signed in to", parity: true do
        log_in(user)
        token, challenge = request_options

        sign_in_with(assertion(challenge), token)

        expect(response).to have_http_status(:ok)
        expect(response.parsed_body).to eq("success" => true, "redirect_location" => "/dashboard")
        # Devise's sign_in does nothing for the account the browser is already signed in to.
        expect(set_cookies).not_to include("remember_user_token=")
        expect(user.reload.sign_in_count).to eq(1)
        expect(stored_credential.reload.sign_count).to eq(1)
      end

      it "switches to the account of the passkey", parity: true do
        log_in(other_user)
        token, challenge = request_options

        sign_in_with(assertion(challenge), token)

        expect(response).to have_http_status(:ok)
        expect(response.parsed_body).to eq("success" => true, "redirect_location" => "/dashboard")
        expect(set_cookies).to include("remember_user_token=")
        expect(user.reload.sign_in_count).to eq(1)
      end
    end

    # User::DeviseInternal#active_for_authentication? is always true, so Devise's activatable hook never refuses an unconfirmed address.
    it "signs in an account whose address is unconfirmed", parity: true do
      user.update_columns(confirmed_at: nil)
      token, challenge = request_options

      sign_in_with(assertion(challenge), token)

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body).to eq("success" => true, "redirect_location" => "/dashboard")
      expect(set_cookies).to include("remember_user_token=")
      expect(user.reload.sign_in_count).to eq(1)
      expect(user.confirmed_at).to be_nil
    end

    describe "with a guest cart in the browser" do
      let(:seller) { create(:user, created_at: Time.utc(2025, 1, 3)) }
      let(:guest_product) { create(:product, user: seller, name: "Guest line", created_at: Time.utc(2025, 1, 3)) }
      let(:shared_product) { create(:product, user: seller, name: "Shared line", created_at: Time.utc(2025, 1, 3)) }
      let(:own_product) { create(:product, user: seller, name: "Own line", created_at: Time.utc(2025, 1, 3)) }
      let!(:guest_cart) do
        cart = create(:cart, :guest, browser_guid: "passkey-guid", email: "guest-cart@example.com", return_url: "https://example.com/back", reject_ppp_discount: true,
                                     discount_codes: [{ "code" => "GUEST", "fromUrl" => true }, { "code" => "BOTH", "fromUrl" => false }])
        create(:cart_product, cart:, product: guest_product, referrer: "https://example.com/ref", url_parameters: { "utm_source" => "newsletter" })
        create(:cart_product, cart:, product: shared_product)
        cart
      end

      # The cart statements that write, in the order Rails sent them; the replay compares the rows they leave.
      def cart_write_statements
        statements = []
        subscriber = ActiveSupport::Notifications.subscribe("sql.active_record") do |*, payload|
          statements << payload[:sql][/\A(INSERT INTO|UPDATE) `\w+`/] if payload[:sql].start_with?("INSERT INTO `cart", "UPDATE `cart")
        end
        yield
        statements
      ensure
        ActiveSupport::Notifications.unsubscribe(subscriber)
      end

      before { cookies[:_gumroad_guid] = "passkey-guid" }

      it "gives the guest cart to a user who has none", parity: true do
        token, challenge = request_options

        statements = cart_write_statements { sign_in_with(assertion(challenge), token) }

        expect(response).to have_http_status(:ok)
        expect(response.parsed_body).to eq("success" => true, "redirect_location" => "/dashboard")
        expect(statements).to eq(["UPDATE `carts`"])
        expect(guest_cart.reload.user).to eq(user)
        expect(guest_cart.email).to eq("guest-cart@example.com")
        expect(guest_cart).to be_alive
      end

      it "merges the guest cart into the cart the user already has and deletes the guest cart", parity: true do
        own_cart = create(:cart, user:, browser_guid: "old-browser", discount_codes: [{ "code" => "BOTH", "fromUrl" => false }, { "code" => "OWN", "fromUrl" => false }])
        create(:cart_product, cart: own_cart, product: own_product)
        create(:cart_product, cart: own_cart, product: shared_product, quantity: 3)
        token, challenge = request_options

        statements = cart_write_statements { sign_in_with(assertion(challenge), token) }

        expect(response).to have_http_status(:ok)
        expect(statements.first).to eq("INSERT INTO `cart_products`")
        expect(statements.last).to eq("UPDATE `carts`")
        own_cart.reload
        expect(own_cart.alive_cart_products.map(&:product_id)).to match_array([own_product.id, shared_product.id, guest_product.id])
        expect(own_cart.alive_cart_products.find_by(product_id: shared_product.id).quantity).to eq(3)
        expect(own_cart.discount_codes.map { _1["code"] }).to eq(%w[BOTH OWN GUEST])
        expect(own_cart).to have_attributes(return_url: "https://example.com/back", reject_ppp_discount: true, browser_guid: "passkey-guid", email: "guest-cart@example.com")
        expect(guest_cart.reload).to be_deleted
      end

      it "merges into an empty cart of the user and keeps its return url", parity: true do
        own_cart = create(:cart, user:, browser_guid: "old-browser", return_url: "https://example.com/own")
        token, challenge = request_options

        sign_in_with(assertion(challenge), token)

        expect(response).to have_http_status(:ok)
        expect(own_cart.reload.alive_cart_products.count).to eq(2)
        expect(own_cart.return_url).to eq("https://example.com/own")
        expect(guest_cart.reload).to be_deleted
      end

      it "hands a browser with two guest carts to Rails", parity: true do
        second = build(:cart, :guest, browser_guid: "passkey-guid")
        second.save!(validate: false)
        create(:cart_product, cart: second, product: own_product)
        token, challenge = request_options

        sign_in_with(assertion(challenge), token)

        expect(response).to have_http_status(:ok)
      end
    end
  end
end
