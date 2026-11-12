# frozen_string_literal: true

require "spec_helper"
require "webauthn/fake_client"

# Settings::PasskeysController the way the password settings page calls it (JSON, Accept: application/json, the CSRF token in a
# header), recorded for the Next.js port (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/settings-mutations.replay.test.ts,
# which sends the last request of each example.
#
# The creation options carry a random challenge that lives in the session, so the replay checks its shape and that it is the one in the
# session Node sets (and nothing else), and spec/requests/node_output_parity_spec.rb has Rails accept an attestation for Node's challenge.
# A registration is a deterministic function of the challenge in the recorded session and the attestation, so the replay sends the last
# request of each example with that session. The attestation formats the gem would have to verify with certificates, and keys other than
# ES256, are "hands a ..." examples: the replay asserts Node passed the request to Rails untouched and wrote nothing.
describe "Settings passkeys when signed in", type: :request do
  include Parity::AudienceSignedIn

  let(:seller) { create(:user, name: "Passkey Seller", username: "passkeyseller", created_at: Time.utc(2025, 1, 1)) }
  let(:json_headers) { { "Accept" => "application/json", "Content-Type" => "application/json" } }

  before { host! DOMAIN }

  def send_json(method, path, body = {})
    public_send(method, path, params: body.to_json, headers: json_headers.merge("X-CSRF-Token" => csrf_token))
  end

  def expect_update_error
    expect(response).to have_http_status(:unprocessable_entity)
    expect(response.parsed_body).to eq("success" => false, "error_message" => "Could not update this passkey.")
  end

  describe "registration options" do
    it "refuses once the seller has the maximum number of passkeys", parity: true do
      create_list(:webauthn_credential, WebauthnCredential::MAX_PER_USER, user: seller)
      log_in(seller)

      send_json(:post, registration_options_settings_passkeys_path)

      expect(response).to have_http_status(:unprocessable_entity)
      expect(response.parsed_body).to eq("success" => false, "error_message" => "You can add up to 10 passkeys.")
    end

    it "issues creation options for the discoverable flow and keeps the challenge in the session", parity: true do
      existing = create(:webauthn_credential, user: seller)
      log_in(seller)

      send_json(:post, registration_options_settings_passkeys_path)

      expect(response).to have_http_status(:ok)
      options = response.parsed_body.fetch("options")
      expect(response.parsed_body["success"]).to eq(true)
      expect(options.keys).to eq(%w[challenge timeout extensions rp user pubKeyCredParams attestation authenticatorSelection excludeCredentials])
      expect(options["rp"]).to eq("name" => "Gumroad", "id" => WebAuthn.configuration.rp_id)
      expect(options["user"]).to eq("id" => seller.external_id, "name" => seller.email, "displayName" => "Passkey Seller")
      expect(options["excludeCredentials"]).to eq([{ "type" => "public-key", "id" => existing.webauthn_id }])
      expect(Base64.urlsafe_decode64(options["challenge"]).bytesize).to eq(32)
    end

    it "lists every passkey of the seller and none of another seller's", parity: true do
      mine = create_list(:webauthn_credential, 3, user: seller)
      create(:webauthn_credential, user: create(:user))
      log_in(seller)

      send_json(:post, registration_options_settings_passkeys_path)

      expect(response.parsed_body.dig("options", "excludeCredentials").pluck("id")).to eq(mine.map(&:webauthn_id))
    end

    it "leaves the exclude list out when the seller has no passkey", parity: true do
      log_in(seller)

      send_json(:post, registration_options_settings_passkeys_path)

      expect(response.parsed_body["options"]["excludeCredentials"]).to eq([])
    end

    it "names the user by email when the seller has no name and the default username", parity: true do
      log_in(seller)
      seller.update_columns(name: nil, username: seller.external_id)

      send_json(:post, registration_options_settings_passkeys_path)

      expect(response.parsed_body.dig("options", "user", "displayName")).to eq(seller.email)
    end

    it "names the user by username when the seller has no name", parity: true do
      log_in(seller)
      seller.update_columns(name: "")

      send_json(:post, registration_options_settings_passkeys_path)

      expect(response.parsed_body.dig("options", "user", "displayName")).to eq("passkeyseller")
    end

    it "names the user by the address waiting for confirmation", parity: true do
      log_in(seller)
      seller.update_columns(name: nil, username: seller.external_id, unconfirmed_email: "new-address@example.com")

      send_json(:post, registration_options_settings_passkeys_path)

      expect(response.parsed_body.dig("options", "user", "displayName")).to eq("new-address@example.com")
    end
  end

  describe "adding a passkey" do
    let(:origin) { "#{PROTOCOL}://#{DOMAIN}" }
    let(:rp_id) { WebAuthn.configuration.rp_id }
    let(:fake_client) { WebAuthn::FakeClient.new(origin) }
    let(:refusal) { { "success" => false, "error_message" => "Could not add this passkey. Please try again." } }
    let(:icloud_aaguid) { ["fbfc3007154e4ecc8c0b6e020557d7bd"].pack("H*") }
    let(:onepassword_aaguid) { ["bada5566a7aa401fbd9645619a55120d"].pack("H*") }

    def request_challenge
      send_json(:post, registration_options_settings_passkeys_path)
      response.parsed_body.dig("options", "challenge")
    end

    def attestation(challenge, **options)
      fake_client.create(challenge:, rp_id:, user_verified: true, **options)
    end

    # An attestation the fake client cannot make: its authenticator data and attestation object are put together here.
    def custom_attestation(challenge, flags: 0x45, aaguid: SecureRandom.random_bytes(16), rp_id: self.rp_id, type: "webauthn.create",
                           origin: self.origin, fmt: "none", statement: {}, credential_id: SecureRandom.random_bytes(16), key: OpenSSL::PKey::EC.generate("prime256v1"))
      cose = COSE::Key::EC2.from_pkey(key.public_key)
      cose.alg = -7
      client_data_json = { type:, challenge:, origin:, crossOrigin: false }.to_json
      auth_data = Digest::SHA256.digest(rp_id) + [flags, 0].pack("CN") + aaguid + [credential_id.bytesize].pack("n") + credential_id + cose.serialize
      encode = ->(bytes) { Base64.urlsafe_encode64(bytes, padding: false) }
      statement = statement.call(key, auth_data + Digest::SHA256.digest(client_data_json)) if statement.respond_to?(:call)
      { "type" => "public-key", "id" => encode.(credential_id), "rawId" => encode.(credential_id),
        "response" => { "attestationObject" => encode.(CBOR.encode("fmt" => fmt, "attStmt" => statement, "authData" => auth_data)), "clientDataJSON" => encode.(client_data_json) } }
    end

    def add_passkey(credential, **extra)
      send_json(:post, settings_passkeys_path, { credential:, **extra })
    end

    def expect_refused(stored: 0)
      expect(response).to have_http_status(:unprocessable_entity)
      expect(response.parsed_body).to eq(refusal)
      expect(seller.webauthn_credentials.count).to eq(stored)
    end

    before { log_in(seller) }

    it "stores the passkey of a verified attestation under the nickname given", parity: true do
      credential = attestation(request_challenge)

      add_passkey(credential, nickname: "Work laptop")

      expect(response).to have_http_status(:created)
      stored = seller.webauthn_credentials.sole
      expect(response.parsed_body).to eq("success" => true, "passkey" => { "id" => stored.external_id, "nickname" => "Work laptop", "created_at" => stored.created_at.as_json, "last_used_at" => nil })
      expect(stored).to have_attributes(webauthn_id: credential["id"], sign_count: 0)
      expect(stored.public_key).to be_present
    end

    it "strips the nickname", parity: true do
      add_passkey(attestation(request_challenge), nickname: "  Desk key \n")

      expect(response.parsed_body.dig("passkey", "nickname")).to eq("Desk key")
    end

    it "names the passkey after a known authenticator when no nickname is given", parity: true do
      add_passkey(custom_attestation(request_challenge, aaguid: icloud_aaguid))

      expect(response.parsed_body.dig("passkey", "nickname")).to eq("iCloud Keychain")
    end

    it "names the passkey after a known authenticator when the nickname is only a space", parity: true do
      add_passkey(custom_attestation(request_challenge, aaguid: onepassword_aaguid), nickname: " ")

      expect(response.parsed_body.dig("passkey", "nickname")).to eq("1Password")
    end

    it "numbers the passkey when the authenticator is unknown", parity: true do
      create(:webauthn_credential, user: seller)

      add_passkey(attestation(request_challenge), nickname: "   ")

      expect(response.parsed_body.dig("passkey", "nickname")).to eq("Passkey 2")
    end

    it "accepts credential extension data", parity: true do
      add_passkey(attestation(request_challenge, extensions: { "credProps" => { "rk" => true } }), nickname: "With extensions")

      expect(response).to have_http_status(:created)
    end

    it "accepts a credential that is backed up", parity: true do
      add_passkey(attestation(request_challenge, backup_eligibility: true, backup_state: true), nickname: "Synced")

      expect(response).to have_http_status(:created)
    end

    it "accepts a user who is verified but was not flagged present", parity: true do
      add_passkey(attestation(request_challenge, user_present: false), nickname: "Verified only")

      expect(response).to have_http_status(:created)
    end

    it "refuses a nickname past the maximum length and stores nothing", parity: true do
      add_passkey(attestation(request_challenge), nickname: "a" * (WebauthnCredential::MAX_NICKNAME_LENGTH + 1))

      expect_refused
    end

    it "accepts a nickname of the maximum length counted in characters", parity: true do
      add_passkey(attestation(request_challenge), nickname: "é" * WebauthnCredential::MAX_NICKNAME_LENGTH)

      expect(response).to have_http_status(:created)
    end

    it "refuses a registration without a pending challenge", parity: true do
      add_passkey({ id: "abc", rawId: "abc", type: "public-key" }, nickname: "Laptop")

      expect_refused
    end

    it "spends the challenge of a refused attestation", parity: true do
      challenge = request_challenge
      add_passkey(custom_attestation(challenge, rp_id: "example.com"))
      expect_refused

      add_passkey(attestation(challenge))

      expect_refused
    end

    it "refuses an attestation made for another challenge", parity: true do
      request_challenge

      add_passkey(attestation(Base64.urlsafe_encode64(SecureRandom.random_bytes(32), padding: false)))

      expect_refused
    end

    it "refuses an attestation made on another origin", parity: true do
      add_passkey(custom_attestation(request_challenge, origin: "https://example.com"))

      expect_refused
    end

    it "refuses an attestation made for another relying party", parity: true do
      add_passkey(custom_attestation(request_challenge, rp_id: "example.com"))

      expect_refused
    end

    it "refuses an attestation whose user was not verified", parity: true do
      add_passkey(custom_attestation(request_challenge, flags: 0x41))

      expect_refused
    end

    it "refuses an attestation that neither flags the user present nor verified", parity: true do
      add_passkey(custom_attestation(request_challenge, flags: 0x40))

      expect_refused
    end

    it "refuses client data of another type", parity: true do
      add_passkey(custom_attestation(request_challenge, type: "webauthn.get"))

      expect_refused
    end

    it "refuses an attestation without attested credential data", parity: true do
      add_passkey(attestation(request_challenge, attested_credential_data: false))

      expect_refused
    end

    it "refuses an attestation statement that is not empty for the none format", parity: true do
      add_passkey(custom_attestation(request_challenge, statement: { "alg" => -7 }))

      expect_refused
    end

    it "refuses an attestation format the gem does not know", parity: true do
      add_passkey(custom_attestation(request_challenge, fmt: "bogus"))

      expect_refused
    end

    it "hands a credential with an EdDSA key to Rails", parity: true do
      add_passkey(attestation(request_challenge, credential_algorithm: "EdDSA"))

      expect_refused
    end

    it "refuses a credential without client data", parity: true do
      credential = attestation(request_challenge)

      add_passkey(credential.merge("response" => credential["response"].slice("attestationObject")))

      expect_refused
    end

    it "refuses a credential whose client data is not the expected object", parity: true do
      credential = attestation(request_challenge)

      add_passkey(credential.merge("response" => credential["response"].merge("clientDataJSON" => Base64.urlsafe_encode64({ type: "webauthn.create" }.to_json, padding: false))))

      expect_refused
    end

    it "refuses an attestation object that is text", parity: true do
      credential = attestation(request_challenge)

      add_passkey(credential.merge("response" => credential["response"].merge("attestationObject" => Base64.urlsafe_encode64(CBOR.encode("none"), padding: false))))

      expect_refused
    end

    it "refuses an attestation object with bytes after the map", parity: true do
      credential = attestation(request_challenge)
      padded = Base64.urlsafe_decode64(credential["response"]["attestationObject"]) + "\x00".b

      add_passkey(credential.merge("response" => credential["response"].merge("attestationObject" => Base64.urlsafe_encode64(padded, padding: false))))

      expect_refused
    end

    it "refuses a credential whose raw id is not its id", parity: true do
      credential = attestation(request_challenge)

      add_passkey(credential.merge("rawId" => Base64.urlsafe_encode64("other", padding: false)))

      expect_refused
    end

    it "refuses a credential that is no hash", parity: true do
      request_challenge

      send_json(:post, settings_passkeys_path, { credential: "text" })

      expect_refused
    end

    it "refuses a credential another seller registered", parity: true do
      credential = attestation(request_challenge)
      create(:webauthn_credential, user: create(:user), webauthn_id: credential["id"])

      add_passkey(credential)

      expect_refused
    end

    it "refuses the passkey past the limit with the limit message", parity: true do
      create_list(:webauthn_credential, WebauthnCredential::MAX_PER_USER - 1, user: seller)
      challenge = request_challenge
      create(:webauthn_credential, user: seller)

      add_passkey(attestation(challenge))

      expect(response).to have_http_status(:unprocessable_entity)
      expect(response.parsed_body).to eq("success" => false, "error_message" => "You can add up to 10 passkeys.")
      expect(seller.webauthn_credentials.count).to eq(WebauthnCredential::MAX_PER_USER)
    end

    it "hands a packed-format attestation to Rails", parity: true do
      signed = ->(key, data) { { "alg" => -7, "sig" => key.sign("SHA256", data) } }
      add_passkey(custom_attestation(request_challenge, fmt: "packed", statement: signed), nickname: "Self attested")

      expect(response).to have_http_status(:created)
    end

    it "hands a credential with an RS256 key to Rails", parity: true do
      add_passkey(attestation(request_challenge, credential_algorithm: "RS256"), nickname: "RSA key")

      expect(response).to have_http_status(:created)
    end

    it "hands a nickname that is not text to Rails", parity: true do
      add_passkey(attestation(request_challenge), nickname: 42)

      expect(response.parsed_body.dig("passkey", "nickname")).to eq("42")
    end
  end

  describe "renaming a passkey" do
    let!(:credential) { create(:webauthn_credential, user: seller, nickname: "MacBook Pro", created_at: Time.utc(2025, 2, 1), last_used_at: Time.utc(2025, 3, 1)) }

    before { log_in(seller) }

    it "renames the passkey", parity: true do
      send_json(:put, settings_passkey_path(credential.external_id), { nickname: "Work laptop" })

      expect(response.parsed_body).to eq(
        "success" => true,
        "passkey" => { "id" => credential.external_id, "nickname" => "Work laptop", "created_at" => "2025-02-01T00:00:00Z", "last_used_at" => "2025-03-01T00:00:00Z" }
      )
      expect(credential.reload.nickname).to eq("Work laptop")
    end

    it "strips the name", parity: true do
      send_json(:patch, settings_passkey_path(credential.external_id), { nickname: "  Work laptop \n" })

      expect(response.parsed_body["passkey"]["nickname"]).to eq("Work laptop")
    end

    it "keeps the passkey as it was when the name is unchanged", parity: true do
      send_json(:put, settings_passkey_path(credential.external_id), { nickname: " MacBook Pro " })

      expect(response.parsed_body["passkey"]["nickname"]).to eq("MacBook Pro")
    end

    it "refuses a blank name", parity: true do
      send_json(:put, settings_passkey_path(credential.external_id), { nickname: "   " })

      expect_update_error
      expect(credential.reload.nickname).to eq("MacBook Pro")
    end

    it "refuses a request without a name", parity: true do
      send_json(:put, settings_passkey_path(credential.external_id), {})

      expect_update_error
    end

    it "refuses a name past the maximum length", parity: true do
      send_json(:put, settings_passkey_path(credential.external_id), { nickname: "a" * (WebauthnCredential::MAX_NICKNAME_LENGTH + 1) })

      expect_update_error
      expect(credential.reload.nickname).to eq("MacBook Pro")
    end

    it "accepts a name of the maximum length", parity: true do
      name = "é" * WebauthnCredential::MAX_NICKNAME_LENGTH
      send_json(:put, settings_passkey_path(credential.external_id), { nickname: name })

      expect(response.parsed_body["passkey"]["nickname"]).to eq(name)
    end

    it "hands a name that is not text to Rails", parity: true do
      send_json(:put, settings_passkey_path(credential.external_id), { nickname: 42 })

      expect(response.parsed_body["passkey"]["nickname"]).to eq("42")
    end

    it "answers 404 for an unknown passkey", parity: true do
      send_json(:put, settings_passkey_path(ObfuscateIds.encrypt(credential.id + 1000)), { nickname: "Nope" })

      expect(response).to have_http_status(:not_found)
    end

    it "answers 404 for another seller's passkey", parity: true do
      other = create(:webauthn_credential, user: create(:user), nickname: "Theirs")

      send_json(:put, settings_passkey_path(other.external_id), { nickname: "Mine now" })

      expect(response).to have_http_status(:not_found)
      expect(other.reload.nickname).to eq("Theirs")
    end
  end

  describe "removing a passkey" do
    it "deletes the passkey", parity: true do
      credential = create(:webauthn_credential, user: seller)
      keep = create(:webauthn_credential, user: seller)
      log_in(seller)

      send_json(:delete, settings_passkey_path(credential.external_id))

      expect(response.parsed_body).to eq("success" => true)
      expect(seller.webauthn_credentials).to eq([keep])
    end

    it "answers 404 for an unknown passkey", parity: true do
      log_in(seller)

      send_json(:delete, settings_passkey_path(ObfuscateIds.encrypt(123_456)))

      expect(response).to have_http_status(:not_found)
    end

    it "answers 404 for another seller's passkey and keeps it", parity: true do
      other = create(:webauthn_credential, user: create(:user))
      log_in(seller)

      send_json(:delete, settings_passkey_path(other.external_id))

      expect(response).to have_http_status(:not_found)
      expect(WebauthnCredential.exists?(other.id)).to be(true)
    end
  end

  describe "authorization" do
    it "answers 401 to a team admin", parity: true do
      admin = create(:user, name: "Team Admin")
      membership = create(:team_membership, user: admin, seller:, role: TeamMembership::ROLE_ADMIN)
      credential = create(:webauthn_credential, user: seller)
      log_in(admin)
      switch_to(membership)

      send_json(:delete, settings_passkey_path(credential.external_id))

      expect(response).to have_http_status(:unauthorized)
      expect(seller.webauthn_credentials).to eq([credential])
    end

    it "answers 403 JSON to a seller without an email address", parity: true do
      log_in(seller)
      seller.update_columns(email: nil, unconfirmed_email: nil)

      send_json(:post, registration_options_settings_passkeys_path)

      expect(response).to have_http_status(:forbidden)
    end
  end
end
