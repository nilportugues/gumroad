# frozen_string_literal: true

require "spec_helper"

# Settings::PasskeysController the way the password settings page calls it (JSON, Accept: application/json, the CSRF token in a
# header), recorded for the Next.js port (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/settings-mutations.replay.test.ts,
# which sends the last request of each example.
#
# A WebAuthn challenge (random, kept in the session) and the verification of an attestation cannot be reproduced by a replay, so those
# paths are "hands a ..." examples: the replay asserts Node passed the request to Rails untouched and wrote nothing.
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

    it "hands a seller with room for another passkey to Rails", parity: true do
      create(:webauthn_credential, user: seller)
      log_in(seller)

      send_json(:post, registration_options_settings_passkeys_path)

      expect(response.parsed_body).to include("success" => true)
      expect(response.parsed_body["options"]).to include("challenge")
    end
  end

  describe "adding a passkey" do
    it "hands a registration without a pending challenge to Rails", parity: true do
      log_in(seller)

      send_json(:post, settings_passkeys_path, { nickname: "Laptop", id: "abc", rawId: "abc", type: "public-key" })

      expect(response).to have_http_status(:unprocessable_entity)
      expect(response.parsed_body).to eq("success" => false, "error_message" => "Could not add this passkey. Please try again.")
      expect(seller.webauthn_credentials).to be_empty
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
