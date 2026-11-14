# frozen_string_literal: true

require "spec_helper"

# The writes of Api::Internal::Admin::UsersController that send mail, move a user through the risk state machine, queue a refund job
# or create a credit, through the whole stack on the API host with a per-actor token. Recorded for the Next.js port
# (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/ws17e-admin-api.replay.test.ts. Node answers the parameter and lookup
# refusals and the branches that change nothing; the "hands a ..." examples are requests that clear them, which the replay asserts
# reach the stand-in Rails untouched and write nothing. The services behind them are stubbed so recording needs no processor.
describe "Internal admin API user write guards", type: :request do
  let(:admin) { create(:admin_user, name: "Admin User", email: "admin@example.com") }
  let(:headers) { { "Authorization" => "Bearer per-actor-token", "Host" => API_DOMAIN } }
  let(:user) { create(:user, email: "subject@example.com", name: "Subject User") }

  before do
    create(:admin_api_token, actor_user: admin, token_hash: AdminApiToken.hash_token("per-actor-token"))
  end

  def post_json(path, **params)
    post "/internal/admin/users/#{path}", params:, headers:, as: :json
  end

  describe "POST reset_password" do
    it "requires a user id", parity: true do
      post_json("reset_password")

      expect(response).to have_http_status(:bad_request)
      expect(response.parsed_body["message"]).to start_with("user_id is required for mutating admin actions")
    end

    it "answers 404 for an unknown user", parity: true do
      post_json("reset_password", user_id: "unknown")

      expect(response).to have_http_status(:not_found)
    end

    it "answers 404 for a soft-deleted user", parity: true do
      user.update_columns(deleted_at: 1.day.ago)

      post_json("reset_password", user_id: user.external_id)

      expect(response).to have_http_status(:not_found)
    end

    it "refuses when the expected email is not the user's", parity: true do
      post_json("reset_password", user_id: user.external_id, expected_email: "someone-else@example.com")

      expect(response).to have_http_status(:conflict)
    end

    it "hands a reset to Rails", parity: true do
      allow_any_instance_of(User).to receive(:send_reset_password_instructions)

      expect { post_json("reset_password", user_id: user.external_id, expected_email: "SUBJECT@example.com") }.to change(AdminApiAuditLog, :count).by(1)

      expect(response).to have_http_status(:ok)
    end
  end

  describe "POST update_email" do
    it "requires a user id", parity: true do
      post_json("update_email", new_email: "new@example.com")

      expect(response).to have_http_status(:bad_request)
    end

    it "requires the new email", parity: true do
      post_json("update_email", user_id: user.external_id)

      expect(response.parsed_body["message"]).to eq("new_email is required")
    end

    it "refuses a new email that is not an address", parity: true do
      post_json("update_email", user_id: user.external_id, new_email: "not-an-email")

      expect(response.parsed_body["message"]).to eq("Invalid new email format")
    end

    it "answers 404 for an unknown user", parity: true do
      post_json("update_email", user_id: "unknown", new_email: "new@example.com")

      expect(response).to have_http_status(:not_found)
    end

    it "refuses the address the user already has, ignoring case, and records the attempt", parity: true do
      expect { post_json("update_email", user_id: user.external_id, new_email: "Subject@Example.com") }.to change(AdminApiAuditLog, :count).by(1)

      expect(response).to have_http_status(:unprocessable_entity)
      expect(response.parsed_body["message"]).to eq("New email is the same as the current email")
      expect(AdminApiAuditLog.last).to have_attributes(action: "users.update_email", response_status: 422)
    end

    it "hands an email change to Rails", parity: true do
      post_json("update_email", user_id: user.external_id, new_email: "new@example.com")

      expect(response).to have_http_status(:ok)
    end
  end

  describe "POST two_factor_authentication" do
    it "requires the enabled flag", parity: true do
      post_json("two_factor_authentication", user_id: user.external_id)

      expect(response.parsed_body["message"]).to eq("enabled is required")
    end

    it "answers 404 for an unknown user", parity: true do
      post_json("two_factor_authentication", user_id: "unknown", enabled: false)

      expect(response).to have_http_status(:not_found)
    end

    it "hands a change to Rails, even when it turns the flag off", parity: true do
      post_json("two_factor_authentication", user_id: user.external_id, enabled: false)

      expect(response).to have_http_status(:ok)
    end
  end

  describe "POST mark_compliant" do
    it "answers 404 for an unknown user", parity: true do
      post_json("mark_compliant", user_id: "unknown")

      expect(response).to have_http_status(:not_found)
    end

    it "reports an account that is already compliant and records the call", parity: true do
      user.update_columns(user_risk_state: "compliant")

      expect { post_json("mark_compliant", user_id: user.external_id) }.to change(AdminApiAuditLog, :count).by(1)

      expect(response.parsed_body).to include("success" => true, "status" => "already_compliant", "message" => "User is already compliant")
    end

    it "refuses to lift a suspension nobody asked to lift", parity: true do
      user.update_columns(user_risk_state: "suspended_for_fraud")

      post_json("mark_compliant", user_id: user.external_id, clear_suspension: "false")

      expect(response).to have_http_status(:unprocessable_entity)
      expect(response.parsed_body["message"]).to eq("User is suspended_for_fraud; pass clear_suspension=true to lift the suspension as well")
    end

    it "refuses a suspension for a policy violation the same way", parity: true do
      user.update_columns(user_risk_state: "suspended_for_tos_violation")

      post_json("mark_compliant", user_id: user.external_id)

      expect(response).to have_http_status(:unprocessable_entity)
    end

    it "hands a user who is not compliant to Rails", parity: true do
      post_json("mark_compliant", user_id: user.external_id, note: "Reviewed")

      expect(response).to have_http_status(:ok)
    end

    it "hands a lifted suspension to Rails", parity: true do
      user.update_columns(user_risk_state: "suspended_for_fraud")

      post_json("mark_compliant", user_id: user.external_id, clear_suspension: "yes")

      expect(response).to have_http_status(:ok)
    end
  end

  describe "POST suspend_for_fraud" do
    it "answers 404 for an unknown user", parity: true do
      post_json("suspend_for_fraud", user_id: "unknown")

      expect(response).to have_http_status(:not_found)
    end

    it "reports an account that is already suspended for fraud", parity: true do
      user.update_columns(user_risk_state: "suspended_for_fraud")

      expect { post_json("suspend_for_fraud", user_id: user.external_id, suspension_note: "Again") }.to change(AdminApiAuditLog, :count).by(1)

      expect(response.parsed_body).to include("status" => "already_suspended", "message" => "User is already suspended for fraud")
    end

    it "hands a suspension to Rails, also for an account suspended for a policy violation", parity: true do
      user.update_columns(user_risk_state: "suspended_for_tos_violation")

      post_json("suspend_for_fraud", user_id: user.external_id)

      expect(response).to have_http_status(:unprocessable_entity)
    end

    it "hands a suspension of a compliant account to Rails", parity: true do
      post_json("suspend_for_fraud", user_id: user.external_id)

      expect(response).to have_http_status(:ok)
    end
  end

  describe "POST suspend_for_tos_violation" do
    it "reports an account that is already suspended for a policy violation", parity: true do
      user.update_columns(user_risk_state: "suspended_for_tos_violation")

      post_json("suspend_for_tos_violation", user_id: user.external_id)

      expect(response.parsed_body).to include("status" => "already_suspended", "message" => "User is already suspended for a policy violation")
    end

    it "hands a suspension to Rails", parity: true do
      post_json("suspend_for_tos_violation", user_id: user.external_id)

      expect(response).to have_http_status(:ok)
    end
  end

  describe "POST flag_for_tos_violation" do
    let(:product) { create(:product, user:) }

    it "requires a product id", parity: true do
      post_json("flag_for_tos_violation", user_id: user.external_id)

      expect(response.parsed_body["message"]).to eq("product_id is required")
    end

    it "answers 404 for an unknown user", parity: true do
      post_json("flag_for_tos_violation", user_id: "unknown", product_id: product.external_id)

      expect(response).to have_http_status(:not_found)
    end

    it "answers 404 for an unknown product", parity: true do
      post_json("flag_for_tos_violation", user_id: user.external_id, product_id: "unknown")

      expect(response.parsed_body["message"]).to eq("Product not found")
    end

    it "answers 404 for a product that was deleted", parity: true do
      product.update_columns(deleted_at: 1.day.ago)

      post_json("flag_for_tos_violation", user_id: user.external_id, product_id: product.external_id)

      expect(response).to have_http_status(:not_found)
    end

    it "refuses a product that belongs to someone else", parity: true do
      other = create(:product)

      post_json("flag_for_tos_violation", user_id: user.external_id, product_id: other.external_id)

      expect(response).to have_http_status(:unprocessable_entity)
      expect(response.parsed_body["message"]).to eq("Product does not belong to user")
    end

    it "hands a flag to Rails", parity: true do
      post_json("flag_for_tos_violation", user_id: user.external_id, product_id: product.external_id)

      expect(response).to have_http_status(:ok)
    end
  end

  describe "POST refund_all_for_fraud" do
    it "requires a user id", parity: true do
      post_json("refund_all_for_fraud", expected_email: "subject@example.com", expected_purchase_count: 0)

      expect(response).to have_http_status(:bad_request)
    end

    it "requires the expected email", parity: true do
      post_json("refund_all_for_fraud", user_id: user.external_id, expected_purchase_count: 0)

      expect(response.parsed_body["message"]).to eq("expected_email is required")
    end

    it "requires the expected purchase count", parity: true do
      post_json("refund_all_for_fraud", user_id: user.external_id, expected_email: "subject@example.com")

      expect(response.parsed_body["message"]).to eq("expected_purchase_count is required")
    end

    it "refuses an expected purchase count that is not a non-negative integer", parity: true do
      post_json("refund_all_for_fraud", user_id: user.external_id, expected_email: "subject@example.com", expected_purchase_count: "-1")

      expect(response.parsed_body["message"]).to eq("expected_purchase_count must be a non-negative integer")
    end

    it "answers 404 for an unknown user", parity: true do
      post_json("refund_all_for_fraud", user_id: "unknown", expected_email: "subject@example.com", expected_purchase_count: 0)

      expect(response).to have_http_status(:not_found)
    end

    it "refuses an account that is not suspended", parity: true do
      post_json("refund_all_for_fraud", user_id: user.external_id, expected_email: "subject@example.com", expected_purchase_count: 0)

      expect(response).to have_http_status(:unprocessable_entity)
      expect(response.parsed_body["message"]).to eq("User must be suspended to refund all purchases for fraud")
    end

    it "hands a suspended account to Rails", parity: true do
      user.update_columns(user_risk_state: "suspended_for_fraud")

      post_json("refund_all_for_fraud", user_id: user.external_id, expected_email: "subject@example.com", expected_purchase_count: 0, block_buyers: true)

      expect(response).to have_http_status(:ok)
    end
  end

  describe "POST refund_balance" do
    it "requires the expected email", parity: true do
      post_json("refund_balance", user_id: user.external_id, expected_purchase_count: 0, expected_total_amount_cents: 0)

      expect(response.parsed_body["message"]).to eq("expected_email is required")
    end

    it "requires the expected figures", parity: true do
      post_json("refund_balance", user_id: user.external_id, expected_email: "subject@example.com", expected_purchase_count: 0)

      expect(response.parsed_body["message"]).to eq("expected_total_amount_cents is required")
    end

    it "refuses an expected total that is not a non-negative integer", parity: true do
      post_json("refund_balance", user_id: user.external_id, expected_email: "subject@example.com", expected_purchase_count: 0, expected_total_amount_cents: "12.5")

      expect(response.parsed_body["message"]).to eq("expected_total_amount_cents must be a non-negative integer")
    end

    it "refuses an account that is not suspended", parity: true do
      post_json("refund_balance", user_id: user.external_id, expected_email: "subject@example.com", expected_purchase_count: 0, expected_total_amount_cents: 0)

      expect(response.parsed_body["message"]).to eq("User must be suspended to refund unpaid purchases")
    end

    it "answers 409 with the current figures when the expected ones are off", parity: true do
      user.update_columns(user_risk_state: "suspended_for_tos_violation")

      expect { post_json("refund_balance", user_id: user.external_id, expected_email: "subject@example.com", expected_purchase_count: 2, expected_total_amount_cents: 500) }.not_to change(AdminApiAuditLog, :count)

      expect(response).to have_http_status(:conflict)
      expect(response.parsed_body).to include("success" => false, "message" => "Expected unpaid balance does not match current unpaid balance", "current" => { "count" => 0, "total" => 0, "total_amount_cents" => 0, "currency" => "usd" })
    end

    it "hands a refund whose figures match to Rails", parity: true do
      user.update_columns(user_risk_state: "suspended_for_fraud")

      post_json("refund_balance", user_id: user.external_id, expected_email: "subject@example.com", expected_purchase_count: 0, expected_total_amount_cents: 0)

      expect(response).to have_http_status(:ok)
    end
  end

  describe "POST add_credit" do
    it "answers 404 for an unknown user", parity: true do
      post_json("add_credit", user_id: "unknown", amount_cents: 100, reason: "Goodwill")

      expect(response).to have_http_status(:not_found)
    end

    it "requires an amount", parity: true do
      post_json("add_credit", user_id: user.external_id, reason: "Goodwill")

      expect(response.parsed_body["message"]).to eq("amount_cents is required")
    end

    it "refuses an amount that is not an integer", parity: true do
      post_json("add_credit", user_id: user.external_id, amount_cents: "1.5", reason: "Goodwill")

      expect(response.parsed_body["message"]).to eq("amount_cents must be an integer")
    end

    it "refuses an amount of zero", parity: true do
      post_json("add_credit", user_id: user.external_id, amount_cents: 0, reason: "Goodwill")

      expect(response.parsed_body["message"]).to eq("amount_cents must not be zero")
    end

    it "requires a reason", parity: true do
      post_json("add_credit", user_id: user.external_id, amount_cents: -100, reason: "  ")

      expect(response.parsed_body["message"]).to eq("reason is required")
    end

    it "hands a credit to Rails", parity: true do
      credit = instance_double(Credit, id: 1, amount_cents: 100, reason: "Goodwill", crediting_user: admin, created_at: Time.current)
      allow(Credit).to receive(:create_for_credit!).and_return(credit)

      post_json("add_credit", user_id: user.external_id, amount_cents: 100, reason: "Goodwill")

      expect(response).to have_http_status(:ok)
    end
  end

  describe "POST restore_bank_payout_rail" do
    it "answers 404 for an unknown user", parity: true do
      post_json("restore_bank_payout_rail", user_id: "unknown")

      expect(response).to have_http_status(:not_found)
    end

    it "hands a restore to Rails", parity: true do
      post_json("restore_bank_payout_rail", user_id: user.external_id)

      expect(response).to have_http_status(:unprocessable_entity)
    end
  end
end
