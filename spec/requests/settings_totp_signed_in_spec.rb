# frozen_string_literal: true

require "spec_helper"

# The authenticator app endpoints of Settings::TotpController the way the password settings page calls them (JSON, Accept:
# application/json, the CSRF token in a header), recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/settings-mutations.replay.test.ts, which sends the last request of each example.
#
# Confirming and regenerating run in Node. The code a confirmation sends depends on the clock, so the replay swaps it for the code of the
# same interval (the example name says which: the previous or the next one), and the recovery codes are random bcrypt hashes, so the replay
# checks their shape and writes them for node_output_parity_spec.rb, where Rails redeems them. A setup draws a random secret, so the replay
# skips the secret, the URI and the QR code, and node_output_parity_spec.rb rebuilds the last two from Node's secret and compares.
describe "Settings authenticator app when signed in", type: :request do
  include Parity::AudienceSignedIn

  let(:seller) { create(:user, name: "Totp Seller", username: "totpseller", created_at: Time.utc(2025, 1, 1)) }
  let(:json_headers) { { "Accept" => "application/json", "Content-Type" => "application/json" } }

  before { host! DOMAIN }

  def send_json(method, path, body = {})
    public_send(method, path, params: body.to_json, headers: json_headers.merge("X-CSRF-Token" => csrf_token))
  end

  def expect_error(message)
    expect(response).to have_http_status(:unprocessable_entity)
    expect(response.parsed_body).to eq("success" => false, "error_message" => message)
  end

  describe "starting the setup" do
    it "refuses when the authenticator app is already enabled", parity: true do
      create(:totp_credential, :confirmed, user: seller)
      log_in(seller)

      send_json(:post, settings_totp_path)

      expect_error("Authenticator app is already enabled.")
    end

    it "starts a setup with a secret, a provisioning URI and a QR code", parity: true do
      log_in(seller)

      send_json(:post, settings_totp_path)

      credential = seller.reload.totp_credential
      expect(credential).not_to be_confirmed
      expect(response.parsed_body).to include("success" => true, "secret" => credential.otp_secret, "provisioning_uri" => credential.totp_provisioning_uri)
      expect(response.parsed_body["qr_svg"]).to start_with("<?xml")
    end

    it "replaces a pending setup with a new secret", parity: true do
      previous = create(:totp_credential, user: seller).otp_secret
      log_in(seller)

      send_json(:post, settings_totp_path)

      expect(response.parsed_body).to include("success" => true)
      expect(seller.reload.totp_credential.otp_secret).not_to eq(previous)
      expect(TotpCredential.where(user: seller).count).to eq(1)
    end
  end

  describe "confirming the setup" do
    it "refuses when no setup was started", parity: true do
      log_in(seller)

      send_json(:post, confirm_settings_totp_path, { code: "123456" })

      expect_error("No pending TOTP setup found.")
    end

    it "refuses when the setup is already confirmed", parity: true do
      create(:totp_credential, :confirmed, user: seller)
      log_in(seller)

      send_json(:post, confirm_settings_totp_path, { code: "123456" })

      expect_error("No pending TOTP setup found.")
    end

    it "answers 422 for a wrong code", parity: true do
      create(:totp_credential, user: seller)
      log_in(seller)

      send_json(:post, confirm_settings_totp_path, { code: "000000" })

      expect_error("Invalid code. Please try again.")
      expect(seller.reload.totp_credential).not_to be_confirmed
    end

    it "answers 422 when no code is sent", parity: true do
      create(:totp_credential, user: seller)
      log_in(seller)

      send_json(:post, confirm_settings_totp_path)

      expect_error("Invalid code. Please try again.")
    end

    it "answers 422 for a blank code", parity: true do
      create(:totp_credential, user: seller)
      log_in(seller)

      send_json(:post, confirm_settings_totp_path, { code: "" })

      expect_error("Invalid code. Please try again.")
    end

    def confirm_with_code_at(offset)
      credential = create(:totp_credential, user: seller)
      log_in(seller)
      send_json(:post, confirm_settings_totp_path, { code: ROTP::TOTP.new(credential.otp_secret).at(Time.current + offset) })
      credential.reload
    end

    it "confirms with the current code and shows ten recovery codes", parity: true do
      credential = confirm_with_code_at(0)

      expect(response.parsed_body["recovery_codes"].length).to eq(TotpCredential::RECOVERY_CODE_COUNT)
      expect(response.parsed_body["recovery_codes"]).to all(match(/\A[A-Z0-9]{4}-[A-Z0-9]{4}\z/))
      expect(credential).to be_confirmed
      expect(credential.recovery_codes.length).to eq(TotpCredential::RECOVERY_CODE_COUNT)
    end

    it "confirms with the code of the previous interval", parity: true do
      credential = confirm_with_code_at(-TotpCredential::DRIFT)

      expect(response.parsed_body).to include("success" => true)
      expect(credential).to be_confirmed
    end

    it "answers 422 for the code of the next interval", parity: true do
      credential = confirm_with_code_at(TotpCredential::DRIFT)

      expect_error("Invalid code. Please try again.")
      expect(credential).not_to be_confirmed
    end
  end

  describe "turning the authenticator app off" do
    it "deletes a confirmed credential", parity: true do
      create(:totp_credential, :with_recovery_codes, user: seller)
      log_in(seller)

      send_json(:delete, settings_totp_path)

      expect(response.parsed_body).to eq("success" => true)
      expect(seller.reload.totp_credential).to be_nil
    end

    it "refuses when no setup was started", parity: true do
      log_in(seller)

      send_json(:delete, settings_totp_path)

      expect_error("Authenticator app is not enabled.")
    end

    it "refuses and keeps a pending credential", parity: true do
      create(:totp_credential, user: seller)
      log_in(seller)

      send_json(:delete, settings_totp_path)

      expect_error("Authenticator app is not enabled.")
      expect(seller.reload.totp_credential).to be_present
    end
  end

  describe "regenerating recovery codes" do
    it "replaces the recovery codes of a confirmed credential", parity: true do
      credential = create(:totp_credential, :with_recovery_codes, user: seller)
      previous = credential.reload.recovery_codes
      log_in(seller)

      send_json(:post, regenerate_recovery_codes_settings_totp_path)

      expect(response.parsed_body["recovery_codes"].length).to eq(TotpCredential::RECOVERY_CODE_COUNT)
      expect(credential.reload.recovery_codes).not_to include(*previous)
    end

    it "refuses when the authenticator app is not enabled", parity: true do
      create(:totp_credential, user: seller)
      log_in(seller)

      send_json(:post, regenerate_recovery_codes_settings_totp_path)

      expect_error("Authenticator app is not enabled.")
    end
  end

  describe "authorization" do
    it "answers 401 to a team admin", parity: true do
      admin = create(:user, name: "Team Admin")
      membership = create(:team_membership, user: admin, seller:, role: TeamMembership::ROLE_ADMIN)
      create(:totp_credential, :confirmed, user: seller)
      log_in(admin)
      switch_to(membership)

      send_json(:delete, settings_totp_path)

      expect(response).to have_http_status(:unauthorized)
      expect(seller.reload.totp_credential).to be_present
    end

    it "answers 403 JSON to a seller without an email address", parity: true do
      log_in(seller)
      seller.update_columns(email: nil, unconfirmed_email: nil)

      send_json(:post, settings_totp_path)

      expect(response).to have_http_status(:forbidden)
    end
  end
end
