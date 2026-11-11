# frozen_string_literal: true

require "spec_helper"

# The authenticator app endpoints of Settings::TotpController the way the password settings page calls them (JSON, Accept:
# application/json, the CSRF token in a header), recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/settings-mutations.replay.test.ts, which sends the last request of each example.
#
# A secret, recovery codes (bcrypt-hashed) and the check of a code against the clock cannot be reproduced by a replay, so those paths are
# "hands a ..." examples: the replay asserts Node passed the request to Rails untouched and wrote nothing.
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

    it "hands a first setup to Rails", parity: true do
      log_in(seller)

      send_json(:post, settings_totp_path)

      expect(response.parsed_body).to include("success" => true)
      expect(seller.reload.totp_credential).not_to be_confirmed
    end

    it "hands a repeated setup to Rails", parity: true do
      create(:totp_credential, user: seller)
      log_in(seller)

      send_json(:post, settings_totp_path)

      expect(response.parsed_body).to include("success" => true)
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

    it "hands a code for a pending setup to Rails", parity: true do
      create(:totp_credential, user: seller)
      log_in(seller)

      send_json(:post, confirm_settings_totp_path, { code: "000000" })

      expect_error("Invalid code. Please try again.")
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
    it "hands a confirmed credential to Rails", parity: true do
      create(:totp_credential, :with_recovery_codes, user: seller)
      log_in(seller)

      send_json(:post, regenerate_recovery_codes_settings_totp_path)

      expect(response.parsed_body["recovery_codes"].length).to eq(TotpCredential::RECOVERY_CODE_COUNT)
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
