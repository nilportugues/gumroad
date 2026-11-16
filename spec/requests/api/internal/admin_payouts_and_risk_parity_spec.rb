# frozen_string_literal: true

require "spec_helper"

# The admin endpoints that move a payout, call SendGrid or clear fraud enforcement (Payouts#issue, ScheduledPayouts, SendgridEmails,
# StrandedBuyers#recover, LowBalanceProbationRecoveries), through the whole stack on the API host with a per-actor token. Recorded for
# the Next.js port (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/ws17e-admin-api.replay.test.ts. Node answers the refusals
# in front of the work; the "hands a ..." examples are requests that clear them, which the replay asserts reach the stand-in Rails
# untouched and write nothing. The services behind them are stubbed so recording needs no processor.
describe "Internal admin API payouts and risk recovery", type: :request do
  let(:admin) { create(:admin_user, name: "Admin User", email: "admin@example.com") }
  let(:headers) { { "Authorization" => "Bearer per-actor-token", "Host" => API_DOMAIN } }
  let(:seller) { create(:user, email: "seller@example.com", name: "Seller Name") }

  before do
    create(:admin_api_token, actor_user: admin, token_hash: AdminApiToken.hash_token("per-actor-token"))
  end

  describe "GET sendgrid_emails/check_status" do
    it "requires an email", parity: true do
      get "/internal/admin/sendgrid_emails/check_status", headers: headers

      expect(response).to have_http_status(:bad_request)
      expect(response.parsed_body).to eq("success" => false, "message" => "'email' parameter is required")
    end

    it "hands a status lookup to Rails", parity: true do
      allow(EmailSuppressionManager).to receive(:new).and_return(instance_double(EmailSuppressionManager, detailed_status: { bounces: nil }))

      get "/internal/admin/sendgrid_emails/check_status", params: { email: "buyer@example.com" }, headers: headers

      expect(response).to have_http_status(:ok)
    end
  end

  describe "POST sendgrid_emails/remove_suppression" do
    it "requires an email", parity: true do
      post "/internal/admin/sendgrid_emails/remove_suppression", headers: headers

      expect(response).to have_http_status(:bad_request)
      expect(response.parsed_body["message"]).to eq("'email' parameter is required")
    end

    it "refuses a list SendGrid does not have", parity: true do
      post "/internal/admin/sendgrid_emails/remove_suppression", params: { email: "buyer@example.com", list: "unsubscribes" }, headers: headers

      expect(response).to have_http_status(:bad_request)
      expect(response.parsed_body["message"]).to eq("Unsupported list(s): unsubscribes")
    end

    it "names every unsupported list of an array", parity: true do
      post "/internal/admin/sendgrid_emails/remove_suppression", params: { email: "buyer@example.com", list: %w[bounces nope other] }, headers: headers

      expect(response.parsed_body["message"]).to eq("Unsupported list(s): nope, other")
    end

    it "hands a removal from every list to Rails", parity: true do
      allow(EmailSuppressionManager).to receive(:new).and_return(instance_double(EmailSuppressionManager, remove_from_lists: [:bounces]))

      post "/internal/admin/sendgrid_emails/remove_suppression", params: { email: "buyer@example.com", list: "all" }, headers: headers

      expect(response).to have_http_status(:ok)
    end

    it "hands a removal from one list to Rails", parity: true do
      allow(EmailSuppressionManager).to receive(:new).and_return(instance_double(EmailSuppressionManager, remove_from_lists: [:blocks]))

      post "/internal/admin/sendgrid_emails/remove_suppression", params: { email: "buyer@example.com", list: "blocks" }, headers: headers

      expect(response.parsed_body["removed_from"]).to eq(["blocks"])
    end
  end

  describe "POST stranded_buyers/recover" do
    it "requires an email or a user id", parity: true do
      post "/internal/admin/stranded_buyers/recover", headers: headers

      expect(response).to have_http_status(:bad_request)
      expect(response.parsed_body["message"]).to eq("email or user_id is required")
    end

    it "treats blank values as missing", parity: true do
      post "/internal/admin/stranded_buyers/recover", params: { email: "  ", user_id: "" }, headers: headers

      expect(response).to have_http_status(:bad_request)
    end

    it "hands a recovery to Rails", parity: true do
      allow(Risk::StrandedBuyerRecoveryService).to receive(:call).and_return(instance_double(Risk::StrandedBuyerRecoveryService::Result, to_h: { dry_run: true }))

      post "/internal/admin/stranded_buyers/recover", params: { email: "buyer@example.com" }, headers: headers

      expect(response).to have_http_status(:ok)
    end
  end

  describe "POST low_balance_probation_recoveries" do
    def preview(**params)
      post "/internal/admin/low_balance_probation_recoveries/preview", params:, headers:, as: :json
    end

    def execute(**params)
      post "/internal/admin/low_balance_probation_recoveries/execute", params:, headers:, as: :json
    end

    it "requires user ids to preview", parity: true do
      expect { preview }.to change(AdminApiAuditLog, :count).by(1)

      expect(response).to have_http_status(:bad_request)
      expect(response.parsed_body["message"]).to eq("user_ids is required")
      expect(AdminApiAuditLog.last).to have_attributes(action: "low_balance_probation_recoveries.preview", response_status: 400, target_id: nil)
    end

    it "refuses an empty list", parity: true do
      preview(user_ids: [])

      expect(response.parsed_body["message"]).to eq("user_ids is required")
    end

    it "refuses a list holding a blank id", parity: true do
      preview(user_ids: ["abc", "  "])

      expect(response.parsed_body["message"]).to eq("user_ids is required")
    end

    it "refuses ids that are not a list", parity: true do
      preview(user_ids: "abc")

      expect(response.parsed_body["message"]).to eq("user_ids is required")
    end

    it "refuses more accounts than one request takes", parity: true do
      preview(user_ids: (1..26).map { "user#{_1}" })

      expect(response.parsed_body["message"]).to eq("at most 25 user_ids per request")
    end

    it "refuses a repeated id", parity: true do
      preview(user_ids: %w[abc def abc])

      expect(response.parsed_body["message"]).to eq("user_ids must not repeat")
    end

    it "strips the ids before it counts them", parity: true do
      preview(user_ids: ["abc", " abc "])

      expect(response.parsed_body["message"]).to eq("user_ids must not repeat")
    end

    it "requires user ids to execute", parity: true do
      execute(snapshot: "anything")

      expect(response).to have_http_status(:bad_request)
      expect(AdminApiAuditLog.last).to have_attributes(action: "low_balance_probation_recoveries.execute", response_status: 400)
    end

    it "hands a preview of accounts to Rails", parity: true do
      preview(user_ids: [seller.external_id, "unknown"])

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body["accounts"].map { _1["reason"] }).to include("user_not_found")
    end

    it "hands a snapshot that does not verify to Rails", parity: true do
      execute(user_ids: [seller.external_id], snapshot: "forged")

      expect(response).to have_http_status(:unprocessable_entity)
    end
  end

  describe "POST payouts/issue" do
    def issue(**params)
      post "/internal/admin/payouts/issue", params:, headers:
    end

    it "requires a user id", parity: true do
      issue(payout_processor: "stripe", payout_period_end_date: "2020-01-01")

      expect(response).to have_http_status(:bad_request)
    end

    it "returns not found for an unknown user", parity: true do
      issue(user_id: "unknown", payout_processor: "stripe", payout_period_end_date: "2020-01-01")

      expect(response).to have_http_status(:not_found)
    end

    it "refuses a processor that is not stripe or paypal", parity: true do
      issue(user_id: seller.external_id, payout_processor: "ach", payout_period_end_date: "2020-01-01")

      expect(response).to have_http_status(:bad_request)
      expect(response.parsed_body["message"]).to eq("payout_processor must be stripe or paypal")
    end

    it "requires the end of the payout period", parity: true do
      issue(user_id: seller.external_id, payout_processor: "paypal")

      expect(response.parsed_body["message"]).to eq("payout_period_end_date is required")
    end

    it "hands a payout to Rails", parity: true do
      allow(Payouts).to receive(:create_payments_for_balances_up_to_date_for_users).and_return([])

      issue(user_id: seller.external_id, payout_processor: "Stripe", payout_period_end_date: "2020-01-01")

      expect(response).to have_http_status(:unprocessable_entity)
    end

    it "hands a payout period that is not a date to Rails", parity: true do
      issue(user_id: seller.external_id, payout_processor: "stripe", payout_period_end_date: "not a date")

      expect(response).to have_http_status(:bad_request)
    end
  end

  describe "scheduled payouts" do
    def schedule(status)
      ScheduledPayout.create!(user: seller, action: "payout", delay_days: 21, scheduled_at: 2.days.from_now.beginning_of_day, status:, payout_amount_cents: 1000, created_by: admin)
    end

    it "requires a processor to schedule one", parity: true do
      post "/internal/admin/scheduled_payouts", params: { user_id: seller.external_id }, headers: headers

      expect(response).to have_http_status(:bad_request)
      expect(response.parsed_body["message"]).to eq("processor is required")
    end

    it "refuses a processor that is not stripe or paypal", parity: true do
      post "/internal/admin/scheduled_payouts", params: { user_id: seller.external_id, processor: "ach" }, headers: headers

      expect(response.parsed_body["message"]).to eq("processor must be stripe or paypal")
    end

    it "hands a scheduling of a payout to Rails", parity: true do
      post "/internal/admin/scheduled_payouts", params: { user_id: seller.external_id, processor: "stripe" }, headers: headers

      expect(response).to have_http_status(:unprocessable_entity)
      expect(response.parsed_body["message"]).to eq("User is not suspended.")
    end

    it "returns not found when it executes an unknown scheduled payout", parity: true do
      post "/internal/admin/scheduled_payouts/unknown/execute", headers: headers

      expect(response).to have_http_status(:not_found)
      expect(response.parsed_body["message"]).to eq("Scheduled payout not found")
    end

    it "refuses to execute a scheduled payout that already ran and audits it", parity: true do
      payout = schedule("executed")

      expect { post "/internal/admin/scheduled_payouts/#{payout.external_id}/execute", headers: headers }.to change(AdminApiAuditLog, :count).by(1)

      expect(response).to have_http_status(:unprocessable_entity)
      expect(response.parsed_body["message"]).to eq("Cannot execute a executed scheduled payout.")
      expect(AdminApiAuditLog.last).to have_attributes(action: "scheduled_payouts.execute", target_type: "ScheduledPayout", target_id: payout.id, response_status: 422)
    end

    it "refuses to execute a held scheduled payout", parity: true do
      payout = schedule("held")

      post "/internal/admin/scheduled_payouts/#{payout.external_id}/execute", headers: headers

      expect(response.parsed_body["message"]).to eq("Cannot execute a held scheduled payout.")
    end

    it "refuses to cancel a scheduled payout that already ran and audits it", parity: true do
      payout = schedule("executed")

      expect { post "/internal/admin/scheduled_payouts/#{payout.external_id}/cancel", headers: headers }.to change(AdminApiAuditLog, :count).by(1)

      expect(response).to have_http_status(:unprocessable_entity)
      expect(response.parsed_body["message"]).to eq("Cannot cancel a executed scheduled payout")
      expect(payout.reload.status).to eq("executed")
    end

    it "returns not found when it cancels an unknown scheduled payout", parity: true do
      post "/internal/admin/scheduled_payouts/unknown/cancel", headers: headers

      expect(response).to have_http_status(:not_found)
    end

    it "hands a pending scheduled payout to Rails for its execution", parity: true do
      payout = schedule("pending")
      allow_any_instance_of(ScheduledPayout).to receive(:execute!).and_return(:held)

      post "/internal/admin/scheduled_payouts/#{payout.external_id}/execute", headers: headers

      expect(response).to have_http_status(:ok)
    end

    it "hands a pending scheduled payout to Rails for its cancellation", parity: true do
      payout = schedule("pending")

      post "/internal/admin/scheduled_payouts/#{payout.external_id}/cancel", headers: headers

      expect(response).to have_http_status(:ok)
      expect(payout.reload.status).to eq("cancelled")
    end
  end
end
