# frozen_string_literal: true

require "spec_helper"

# Enabling, rotating and disabling ping signing the way the advanced settings page calls it (JSON, the CSRF token in a header), recorded
# for the Next.js port (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/settings-mutations.replay.test.ts, which sends the last
# request of each example. The secret is random, so the replay skips its value and asserts its shape and that it is the one stored.
describe "Settings ping signing when signed in", type: :request do
  include Parity::AudienceSignedIn

  let(:seller) { create(:user, name: "Signing Seller", username: "signingseller", created_at: Time.utc(2025, 1, 1)) }
  let(:json_headers) { { "Accept" => "application/json", "X-Requested-With" => "XMLHttpRequest", "Content-Type" => "application/json" } }

  before { host! DOMAIN }

  def send_json(method, path)
    public_send(method, path, params: {}.to_json, headers: json_headers.merge("X-CSRF-Token" => csrf_token))
  end

  def as_team_member(role)
    member = create(:user, name: "#{role.capitalize} Member")
    membership = create(:team_membership, user: member, seller:, role:)
    log_in(member)
    switch_to(membership)
  end

  describe "rotating the secret" do
    it "gives a seller who has not opted in a secret", parity: true do
      log_in(seller)

      send_json(:post, settings_rotate_ping_signing_secret_path)

      expect(response).to be_successful
      expect(response.parsed_body).to eq("success" => true, "secret" => seller.reload.ping_signing_secret)
      expect(response.parsed_body["secret"]).to match(/\A\h{64}\z/)
    end

    it "replaces the secret of a seller who already signs", parity: true do
      seller.create_ping_signing_setting!(secret: "before-rotation")
      log_in(seller)

      send_json(:post, settings_rotate_ping_signing_secret_path)

      expect(response.parsed_body["secret"]).to match(/\A\h{64}\z/)
      expect(seller.reload.ping_signing_secret).to eq(response.parsed_body["secret"])
      expect(PingSigningSetting.where(user: seller).count).to eq(1)
    end

    it "lets an admin team member rotate the seller's secret", parity: true do
      as_team_member(TeamMembership::ROLE_ADMIN)

      send_json(:post, settings_rotate_ping_signing_secret_path)

      expect(response).to be_successful
      expect(seller.reload.ping_signing_secret).to eq(response.parsed_body["secret"])
    end

    it "does not let a marketing team member rotate the secret", parity: true do
      seller.create_ping_signing_setting!(secret: "before-rotation")
      as_team_member(TeamMembership::ROLE_MARKETING)

      send_json(:post, settings_rotate_ping_signing_secret_path)

      expect(response).to have_http_status(:unauthorized)
      expect(seller.reload.ping_signing_secret).to eq("before-rotation")
    end

    it "asks a user without an email to add one", parity: true do
      log_in(seller)
      seller.update_columns(email: nil, unconfirmed_email: nil)

      send_json(:post, settings_rotate_ping_signing_secret_path)

      expect(response).to have_http_status(:forbidden)
      expect(PingSigningSetting.count).to eq(0)
    end
  end

  describe "disabling signing" do
    it "removes the secret of a seller who signs", parity: true do
      seller.create_ping_signing_setting!(secret: "s3cret")
      log_in(seller)

      send_json(:delete, settings_disable_ping_signing_path)

      expect(response).to be_successful
      expect(response.parsed_body).to eq("success" => true)
      expect(seller.reload.ping_signing_secret).to be_nil
    end

    it "succeeds for a seller who never enabled signing", parity: true do
      log_in(seller)

      send_json(:delete, settings_disable_ping_signing_path)

      expect(response.parsed_body).to eq("success" => true)
      expect(PingSigningSetting.count).to eq(0)
    end

    it "leaves another seller's secret alone", parity: true do
      other = create(:user, username: "othersigner")
      other.create_ping_signing_setting!(secret: "theirs")
      seller.create_ping_signing_setting!(secret: "mine")
      log_in(seller)

      send_json(:delete, settings_disable_ping_signing_path)

      expect(other.reload.ping_signing_secret).to eq("theirs")
      expect(seller.reload.ping_signing_secret).to be_nil
    end

    it "does not let a support team member disable signing", parity: true do
      seller.create_ping_signing_setting!(secret: "s3cret")
      as_team_member(TeamMembership::ROLE_SUPPORT)

      send_json(:delete, settings_disable_ping_signing_path)

      expect(response).to have_http_status(:unauthorized)
      expect(seller.reload.ping_signing_secret).to eq("s3cret")
    end
  end
end
