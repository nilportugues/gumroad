# frozen_string_literal: true

require "spec_helper"

# The fetch calls the customers page makes (app/javascript/data/customers.ts): updating a call's URL, enabling and disabling a license
# and editing its uses. Recorded for the Next.js port (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/ws12b.replay.test.ts,
# which sends the last request of each example and compares the status, the JSON and every row it wrote.
describe "Customer actions when signed in", type: :request, elasticsearch_wait_for_refresh: true do
  include Parity::AudienceSignedIn

  let(:seller) { create(:user, :eligible_for_service_products, name: "Selling Seller") }
  let(:json_headers) { { "Accept" => "application/json, text/html", "Content-Type" => "application/json" } }

  before { host! DOMAIN }

  def send_json(method, path, body = nil)
    token = csrf_token
    headers = json_headers.merge("X-CSRF-Token" => token)
    public_send(method, path, params: body&.to_json, headers:)
  end

  def as_team_member(role)
    member = create(:user, name: "#{role.to_s.capitalize} Member")
    membership = create(:team_membership, user: member, seller:, role:)
    log_in(member)
    switch_to(membership)
  end

  describe "updating the URL of a call" do
    let(:product) { create(:call_product, :available_for_a_year, user: seller) }
    let(:purchase) { create(:call_purchase, seller:, link: product) }
    let(:call) { purchase.call }

    it "saves the URL", parity: true do
      log_in(seller)

      send_json(:put, call_path(call.external_id), call_url: "https://zoom.example.com/j/thing")

      expect(response).to have_http_status(:no_content)
      expect(call.reload.call_url).to eq("https://zoom.example.com/j/thing")
    end

    it "clears the URL", parity: true do
      call.update!(call_url: "https://zoom.example.com/j/thing")
      log_in(seller)

      send_json(:patch, call_path(call.external_id), call_url: nil)

      expect(response).to have_http_status(:no_content)
      expect(call.reload.call_url).to be_nil
    end

    it "ignores attributes a seller cannot set", parity: true do
      log_in(seller)

      send_json(:put, call_path(call.external_id), call_url: "https://zoom.example.com/j/other", start_time: "2030-01-01T00:00:00Z")

      expect(response).to have_http_status(:no_content)
      expect(call.reload.start_time).not_to eq(Time.utc(2030, 1, 1))
    end

    it "lets a support team member save the URL", parity: true do
      as_team_member(TeamMembership::ROLE_SUPPORT)

      send_json(:put, call_path(call.external_id), call_url: "https://zoom.example.com/j/support")

      expect(response).to have_http_status(:no_content)
    end

    it "does not let a marketing team member save the URL", parity: true do
      as_team_member(TeamMembership::ROLE_MARKETING)

      send_json(:put, call_path(call.external_id), call_url: "https://zoom.example.com/j/marketing")

      expect(response).to have_http_status(:unauthorized)
      expect(response.parsed_body["error"]).to eq("Your current role as Marketing cannot perform this action.")
      expect(call.reload.call_url).not_to eq("https://zoom.example.com/j/marketing")
    end

    it "does not let a seller change the call of another seller", parity: true do
      other_call = create(:call_purchase, link: create(:call_product, :available_for_a_year)).call
      log_in(seller)

      send_json(:put, call_path(other_call.external_id), call_url: "https://zoom.example.com/j/other")

      expect(response).to have_http_status(:unauthorized)
      expect(other_call.reload.call_url).not_to eq("https://zoom.example.com/j/other")
    end

    it "answers 404 for an unknown call", parity: true do
      log_in(seller)

      send_json(:put, call_path("nope"), call_url: "https://zoom.example.com/j/thing")

      expect(response).to have_http_status(:not_found)
    end
  end

  describe "managing a license" do
    let(:product) { create(:product, user: seller, is_licensed: true) }
    let(:purchase) { create(:purchase, link: product, seller:) }
    let(:license) { create(:license, link: product, purchase:, uses: 3) }
    let(:license_id) { license.secure_external_id(scope: License::MANAGE_SECURE_ID_SCOPE) }

    it "disables the license", parity: true do
      log_in(seller)

      send_json(:put, license_path(license_id, enabled: false))

      expect(response).to have_http_status(:no_content)
      expect(license.reload).to be_disabled
    end

    it "enables the license", parity: true do
      license.disable!
      log_in(seller)

      send_json(:put, license_path(license_id, enabled: true))

      expect(response).to have_http_status(:no_content)
      expect(license.reload).not_to be_disabled
    end

    it "sets the uses", parity: true do
      log_in(seller)

      send_json(:put, license_path(license_id, uses: 7))

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body).to eq("uses" => 7)
    end

    it "adjusts the uses by a delta", parity: true do
      log_in(seller)

      send_json(:put, license_path(license_id, adjust_uses: -2))

      expect(response.parsed_body).to eq("uses" => 1)
    end

    it "does not take the uses below zero", parity: true do
      log_in(seller)

      send_json(:put, license_path(license_id, adjust_uses: -10))

      expect(response.parsed_body).to eq("uses" => 0)
    end

    it "resets the uses", parity: true do
      log_in(seller)

      send_json(:put, license_path(license_id, reset_uses: true))

      expect(response).to have_http_status(:no_content)
      expect(license.reload.uses).to eq(0)
    end

    it "rejects uses that are not a whole number", parity: true do
      log_in(seller)

      send_json(:put, license_path(license_id, uses: "1_000"))

      expect(response).to have_http_status(:unprocessable_entity)
      expect(response.parsed_body["error"]).to eq("Uses must be a whole number between 0 and 1000000.")
    end

    it "rejects uses above the ceiling", parity: true do
      log_in(seller)

      send_json(:put, license_path(license_id, uses: 1_000_001))

      expect(response).to have_http_status(:unprocessable_entity)
    end

    it "does not let a marketing team member change the license", parity: true do
      as_team_member(TeamMembership::ROLE_MARKETING)

      send_json(:put, license_path(license_id, enabled: false))

      expect(response).to have_http_status(:unauthorized)
      expect(license.reload).not_to be_disabled
    end

    it "answers 404 for an id that is not a license token", parity: true do
      log_in(seller)

      send_json(:put, license_path("nope", enabled: false))

      expect(response).to have_http_status(:not_found)
      expect(response.parsed_body).to eq("success" => false, "error" => "Not found")
    end

    # LicensesController authorizes against the signed-in seller, not the license's: any seller holding the token can edit it.
    it "lets a seller edit a license of another seller when it holds the token", parity: true do
      other = create(:license, link: create(:product, is_licensed: true), purchase: create(:purchase), uses: 1)
      log_in(seller)

      send_json(:put, license_path(other.secure_external_id(scope: License::MANAGE_SECURE_ID_SCOPE), uses: 2))

      expect(response).to have_http_status(:ok)
      expect(other.reload.uses).to eq(2)
    end
  end

  describe "revoking access to a purchase" do
    # A free sale with no processor columns passes the financial-transaction validation the revoke update re-runs.
    let(:product) { create(:product, user: seller, price_cents: 0) }
    let(:purchase) do
      build(:purchase, link: product, seller:, purchase_state: "successful", price_cents: 0, stripe_transaction_id: nil, stripe_fingerprint: nil, charge_processor_id: nil, merchant_account: nil).tap { |record| record.save!(validate: false) }
    end

    it "revokes access", parity: true do
      log_in(seller)

      send_json(:put, revoke_access_purchase_path(purchase.external_id))

      expect(response).to have_http_status(:no_content)
      expect(purchase.reload.is_access_revoked).to eq(true)
    end

    it "restores access", parity: true do
      purchase.update!(is_access_revoked: true)
      log_in(seller)

      send_json(:put, undo_revoke_access_purchase_path(purchase.external_id))

      expect(response).to have_http_status(:no_content)
      expect(purchase.reload.is_access_revoked).to eq(false)
    end

    it "does not revoke access that is already revoked", parity: true do
      purchase.update!(is_access_revoked: true)
      log_in(seller)

      send_json(:put, revoke_access_purchase_path(purchase.external_id))

      expect(response).to have_http_status(:unauthorized)
    end

    it "does not restore access that was never revoked", parity: true do
      log_in(seller)

      send_json(:put, undo_revoke_access_purchase_path(purchase.external_id))

      expect(response).to have_http_status(:unauthorized)
    end

    it "does not revoke access to a refunded purchase", parity: true do
      purchase.update!(stripe_refunded: true)
      log_in(seller)

      send_json(:put, revoke_access_purchase_path(purchase.external_id))

      expect(response).to have_http_status(:unauthorized)
    end

    it "lets a support team member revoke access", parity: true do
      as_team_member(:support)

      send_json(:put, revoke_access_purchase_path(purchase.external_id))

      expect(response).to have_http_status(:no_content)
    end

    it "does not let a marketing team member revoke access", parity: true do
      as_team_member(:marketing)

      send_json(:put, revoke_access_purchase_path(purchase.external_id))

      expect(response).to have_http_status(:unauthorized)
    end

    it "answers 404 for another seller's purchase", parity: true do
      other = build(:purchase, link: create(:product), purchase_state: "successful").tap { |record| record.save!(validate: false) }
      log_in(seller)

      send_json(:put, revoke_access_purchase_path(other.external_id))

      expect(response).to have_http_status(:not_found)
      expect(response.parsed_body).to eq("success" => false, "error" => "Not found")
    end
  end
end
