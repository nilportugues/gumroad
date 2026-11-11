# frozen_string_literal: true

require "spec_helper"

# Api::Internal::Admin::ScheduledPayoutsController#index, StrandedBuyersController#scan, PayoutsController#index/#pause/#resume,
# FeatureAnnouncementCampaignsController#preview, StripeRestraintNoticesController#create and PurchasesController#reassign through
# the whole stack, on the API host with a per-actor token. Recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/ws17e-admin-api.replay.test.ts. The "hands a ..." examples are requests the port leaves to Rails (a payout
# schedule, a pause or resume that changes the user, a rendered mail, a notice, a reassignment): the replay asserts they reach the
# stand-in Rails untouched and write nothing.
describe "Internal admin API payout reads and the writes that stay in front of Rails", type: :request do
  let(:admin) { create(:admin_user, name: "Admin User", email: "admin@example.com") }
  let(:headers) { { "Authorization" => "Bearer per-actor-token", "Host" => API_DOMAIN } }
  let(:seller) { create(:user, email: "seller@example.com", name: "Seller Name") }

  before do
    create(:admin_api_token, actor_user: admin, token_hash: AdminApiToken.hash_token("per-actor-token"))
  end

  describe "GET scheduled_payouts" do
    it "lists the scheduled payouts newest first with what the reviewer needs about each seller", parity: true do
      taxonomy = Taxonomy.find_or_create_by!(slug: "design")
      other_taxonomy = Taxonomy.find_or_create_by!(slug: "software")
      create(:product, user: seller, taxonomy:)
      create(:product, user: seller, taxonomy:)
      create(:product, user: seller, taxonomy: other_taxonomy)
      create(:product, user: seller, deleted_at: 1.day.ago)
      create(:collaborator, seller:, affiliate_user: create(:user, email: "collab@example.com"))
      create(:direct_affiliate, seller:, affiliate_user: create(:user, email: "affiliate@example.com"), deleted_at: 1.day.ago)
      merchant_account = create(:merchant_account, user: seller)
      create(:balance, user: seller, merchant_account:, amount_cents: 123_456, state: "unpaid")
      create(:balance, user: seller, merchant_account:, amount_cents: 500, state: "paid", date: 20.days.ago.to_date)
      seller.update_columns(user_risk_state: "flagged_for_fraud")
      create(:comment, commentable: seller, comment_type: "flagged", content: "Flagged", created_at: 2.days.ago)
      older = create(:scheduled_payout, user: seller, status: "executed", executed_at: 1.day.ago, scheduled_at: 3.days.ago, created_at: 5.days.ago, created_by: admin)
      newer = create(:scheduled_payout, user: seller, action: "hold", processor: nil, payout_amount_cents: 99, created_at: 1.day.ago)

      get "/internal/admin/scheduled_payouts", headers: headers

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body["scheduled_payouts"].map { _1["external_id"] }).to eq([newer.external_id, older.external_id])
      expect(response.parsed_body["scheduled_payouts"].first).to include("product_count" => 3, "incoming_affiliate_count" => 1, "unpaid_balance_formatted" => "$1,234.56")
      expect(response.parsed_body["limit"]).to eq(20)
    end

    it "lists the payouts of a seller whose account is suspended", parity: true do
      seller.update_columns(user_risk_state: "suspended_for_tos_violation")
      create(:scheduled_payout, user: seller)
      create(:scheduled_payout, user: create(:user, email: "other@example.com"))

      get "/internal/admin/scheduled_payouts", params: { email: "seller@example.com" }, headers: headers

      expect(response.parsed_body["scheduled_payouts"].size).to eq(1)
      expect(response.parsed_body["scheduled_payouts"].first["risk_state"]).to include("status" => "Suspended", "suspended" => true)
    end

    it "filters by status, ignoring blank entries, and caps the limit", parity: true do
      create(:scheduled_payout, user: seller, status: "pending")
      create(:scheduled_payout, user: create(:user, email: "other@example.com"), status: "flagged")
      create(:scheduled_payout, user: create(:user, email: "third@example.com"), status: "cancelled")

      get "/internal/admin/scheduled_payouts", params: { status: ["flagged", "", "pending"], limit: "9999" }, headers: headers
      expect(response.parsed_body["scheduled_payouts"].size).to eq(2)
      expect(response.parsed_body["limit"]).to eq(50)

      get "/internal/admin/scheduled_payouts", params: { status: "cancelled", limit: "1" }, headers: headers
      expect(response.parsed_body["scheduled_payouts"].size).to eq(1)
      expect(response.parsed_body["limit"]).to eq(1)
    end

    it "uses the default limit for one that is zero, negative or not a number", parity: true do
      get "/internal/admin/scheduled_payouts", params: { limit: "-3" }, headers: headers
      expect(response.parsed_body["limit"]).to eq(20)

      get "/internal/admin/scheduled_payouts", params: { limit: "ten" }, headers: headers
      expect(response.parsed_body["limit"]).to eq(20)

      get "/internal/admin/scheduled_payouts", params: { limit: "1_0abc" }, headers: headers
      expect(response.parsed_body["limit"]).to eq(10)
    end

    it "lists nothing when no payout was scheduled", parity: true do
      get "/internal/admin/scheduled_payouts", headers: headers

      expect(response.parsed_body).to eq("success" => true, "scheduled_payouts" => [], "limit" => 20)
    end

    it "refuses a status it does not know", parity: true do
      get "/internal/admin/scheduled_payouts", params: { status: %w[pending archived] }, headers: headers

      expect(response).to have_http_status(:bad_request)
      expect(response.parsed_body["message"]).to eq("status is invalid")
    end

    it "answers 404 for a user it cannot find", parity: true do
      get "/internal/admin/scheduled_payouts", params: { user_id: "unknown" }, headers: headers

      expect(response).to have_http_status(:not_found)
    end

    it "answers 404 for a soft-deleted user", parity: true do
      seller.update_columns(deleted_at: 1.day.ago)

      get "/internal/admin/scheduled_payouts", params: { user_id: seller.external_id }, headers: headers

      expect(response).to have_http_status(:not_found)
    end

    it "rejects a request without a token", parity: true do
      get "/internal/admin/scheduled_payouts", headers: { "Host" => API_DOMAIN }

      expect(response).to have_http_status(:unauthorized)
    end
  end

  describe "GET stranded_buyers/scan" do
    it "reports no candidates when no checkout was declined by a block", parity: true do
      get "/internal/admin/stranded_buyers/scan", params: { limit: "5" }, headers: headers

      expect(response.parsed_body).to eq("success" => true, "candidates" => [], "count" => 0, "total" => 0, "truncated" => false)
    end

    it "ignores a declined checkout older than the lookback window", parity: true do
      old = build(:purchase, purchase_state: "failed", error_code: "blocked_ip_address", email: "old@example.com", created_at: 31.days.ago)
      old.save!(validate: false)

      get "/internal/admin/stranded_buyers/scan", headers: headers

      expect(response.parsed_body["total"]).to eq(0)
    end

    it "hands a scan that finds a blocked checkout to Rails", parity: true do
      build(:purchase, purchase_state: "failed", error_code: "blocked_browser_guid", email: "blocked@example.com", created_at: 2.days.ago).save!(validate: false)

      get "/internal/admin/stranded_buyers/scan", headers: headers

      expect(response).to have_http_status(:ok)
    end
  end

  describe "GET payouts" do
    it "requires a way to find the user", parity: true do
      get "/internal/admin/payouts", headers: headers

      expect(response).to have_http_status(:bad_request)
    end

    it "answers 404 for an unknown user", parity: true do
      get "/internal/admin/payouts", params: { email: "nobody@example.com" }, headers: headers

      expect(response).to have_http_status(:not_found)
    end

    it "hands the list of a seller to Rails", parity: true do
      get "/internal/admin/payouts", params: { user_id: seller.external_id }, headers: headers

      expect(response).to have_http_status(:ok)
    end
  end

  describe "POST payouts/pause" do
    it "requires a user id", parity: true do
      post "/internal/admin/payouts/pause", headers:, as: :json

      expect(response).to have_http_status(:bad_request)
    end

    it "answers 404 for an unknown user", parity: true do
      post "/internal/admin/payouts/pause", params: { user_id: "unknown" }, headers:, as: :json

      expect(response).to have_http_status(:not_found)
    end

    it "refuses when the expected email is not the user's", parity: true do
      post "/internal/admin/payouts/pause", params: { user_id: seller.external_id, expected_email: "other@example.com" }, headers:, as: :json

      expect(response).to have_http_status(:conflict)
    end

    it "reports payouts an admin already paused and records the call", parity: true do
      seller.update!(payouts_paused_internally: true, payouts_paused_by: admin.id)

      expect { post "/internal/admin/payouts/pause", params: { user_id: seller.external_id, reason: "Again" }, headers:, as: :json }.to change(AdminApiAuditLog, :count).by(1)

      expect(response.parsed_body).to eq("success" => true, "user_id" => seller.external_id, "status" => "already_paused", "message" => "Payouts are already paused by admin", "payouts_paused" => true)
      expect(Comment.count).to eq(0)
    end

    it "hands a pause to Rails", parity: true do
      post "/internal/admin/payouts/pause", params: { user_id: seller.external_id, reason: "Review" }, headers:, as: :json

      expect(response).to have_http_status(:ok)
    end

    it "hands a pause to Rails when Stripe paused the payouts", parity: true do
      seller.update!(payouts_paused_internally: true, payouts_paused_by: User::PAYOUT_PAUSE_SOURCE_STRIPE)

      post "/internal/admin/payouts/pause", params: { user_id: seller.external_id }, headers:, as: :json

      expect(response).to have_http_status(:ok)
    end
  end

  describe "POST payouts/resume" do
    it "answers 404 for an unknown user", parity: true do
      post "/internal/admin/payouts/resume", params: { user_id: "unknown" }, headers:, as: :json

      expect(response).to have_http_status(:not_found)
    end

    it "reports payouts that are not paused and records the call", parity: true do
      expect { post "/internal/admin/payouts/resume", params: { user_id: seller.external_id }, headers:, as: :json }.to change(AdminApiAuditLog, :count).by(1)

      expect(response.parsed_body).to eq("success" => true, "user_id" => seller.external_id, "status" => "not_paused", "message" => "Payouts are not paused by admin", "payouts_paused" => false)
    end

    it "reports that payouts the seller paused themselves stay paused", parity: true do
      seller.update!(payouts_paused_by_user: true)

      post "/internal/admin/payouts/resume", params: { user_id: seller.external_id }, headers:, as: :json

      expect(response.parsed_body).to include("status" => "not_paused", "payouts_paused" => true)
    end

    it "hands a resume of payouts an admin paused to Rails", parity: true do
      seller.update!(payouts_paused_internally: true, payouts_paused_by: admin.id)

      post "/internal/admin/payouts/resume", params: { user_id: seller.external_id }, headers:, as: :json

      expect(response).to have_http_status(:ok)
    end
  end

  describe "GET feature_announcement_campaigns/:id/preview" do
    let!(:campaign) { create(:feature_announcement_campaign, :draft, key: "launch") }

    it "requires a per-actor token", parity: true do
      get "/internal/admin/feature_announcement_campaigns/launch/preview", headers: { "Host" => API_DOMAIN }

      expect(response).to have_http_status(:unauthorized)
    end

    it "answers 404 for a campaign that does not exist and leaves the token's last use alone", parity: true do
      expect { get "/internal/admin/feature_announcement_campaigns/missing/preview", headers: }.not_to change { AdminApiToken.last.reload.last_used_at }

      expect(response).to have_http_status(:not_found)
      expect(response.parsed_body["message"]).to eq("Campaign not found")
    end

    it "hands the rendered email to Rails", parity: true do
      get "/internal/admin/feature_announcement_campaigns/#{campaign.key}/preview", headers: headers

      expect(response).to have_http_status(:ok)
    end
  end

  describe "POST stripe_restraint_notices" do
    let(:valid) { { stripe_account_id: "acct_1ABC", firm_name: "Smith & Jones LLP", firm_email: "counsel@example.com", notice_key: "case-2026-001" } }

    def notice(**params)
      post "/internal/admin/stripe_restraint_notices", params: valid.merge(params), headers:, as: :json
    end

    it "refuses an account id that is not a Stripe account", parity: true do
      notice(stripe_account_id: "cus_123")

      expect(response).to have_http_status(:unprocessable_entity)
      expect(response.parsed_body["message"]).to eq("stripe_account_id must be a Stripe account id (acct_...)")
    end

    it "requires the firm name", parity: true do
      notice(firm_name: "   ")

      expect(response.parsed_body["message"]).to eq("firm_name is required")
    end

    it "refuses a firm name that is too long", parity: true do
      notice(firm_name: "a" * 201)

      expect(response.parsed_body["message"]).to eq("firm_name is too long")
    end

    it "refuses a firm name with control characters", parity: true do
      notice(firm_name: "Smith\nJones")

      expect(response.parsed_body["message"]).to eq("firm_name contains control characters")
    end

    it "refuses a firm email that is not a single address", parity: true do
      notice(firm_email: "A <counsel@example.com>")

      expect(response.parsed_body["message"]).to eq("firm_email must be a single email address")
    end

    it "refuses a notice key with spaces", parity: true do
      notice(notice_key: "case 2026")

      expect(response.parsed_body["message"]).to eq("notice_key must be 1-200 printable characters without spaces")
    end

    it "treats values that are not text as missing", parity: true do
      notice(firm_name: 5)

      expect(response.parsed_body["message"]).to eq("firm_name is required")
    end

    it "answers 404 when no account uses the Stripe account", parity: true do
      notice

      expect(response).to have_http_status(:not_found)
      expect(response.parsed_body["message"]).to eq("No Gumroad account uses Stripe account acct_1ABC")
    end

    it "answers 404 for an account whose id differs only in case", parity: true do
      create(:merchant_account, user: seller, charge_processor_merchant_id: "acct_1abc")

      notice

      expect(response).to have_http_status(:not_found)
    end

    it "refuses an account whose owner was deleted", parity: true do
      create(:merchant_account, user: seller, charge_processor_merchant_id: "acct_1ABC")
      seller.update_columns(deleted_at: 1.day.ago)

      notice

      expect(response).to have_http_status(:unprocessable_entity)
      expect(response.parsed_body["message"]).to eq("The Gumroad account for acct_1ABC is deleted")
    end

    it "refuses an account that belongs to two live accounts", parity: true do
      create(:merchant_account, user: seller, charge_processor_merchant_id: "acct_1ABC")
      build(:merchant_account, user: create(:user, email: "second@example.com"), charge_processor_merchant_id: "acct_1ABC").save!(validate: false)

      notice

      expect(response).to have_http_status(:conflict)
    end

    it "requires a per-actor token", parity: true do
      post "/internal/admin/stripe_restraint_notices", params: valid, headers: { "Host" => API_DOMAIN }, as: :json

      expect(response).to have_http_status(:unauthorized)
    end

    it "leaves the token's last use alone on a dry run", parity: true do
      expect { notice(stripe_account_id: "cus_123", dry_run: "true") }.not_to change { AdminApiToken.last.reload.last_used_at }
    end

    it "stamps the token when the notice is for real", parity: true do
      expect { notice(stripe_account_id: "cus_123", dry_run: "false") }.to change { AdminApiToken.last.reload.last_used_at }
    end

    it "hands a preview for a live account to Rails", parity: true do
      create(:merchant_account, user: seller, charge_processor_merchant_id: "acct_1ABC")

      notice

      expect(response).to have_http_status(:ok)
    end

    it "hands a notice for a live account to Rails", parity: true do
      create(:merchant_account, user: seller, charge_processor_merchant_id: "acct_1ABC")
      allow(StripeRestraintNoticeEmailJob).to receive(:perform_async).and_return("jid")

      notice(dry_run: false)

      expect(response).to have_http_status(:ok)
    end
  end

  describe "POST purchases/reassign" do
    def reassign(**params)
      post "/internal/admin/purchases/reassign", params:, headers:, as: :json
    end

    it "requires both addresses and records the attempt", parity: true do
      expect { reassign(from: "old@example.com") }.to change(AdminApiAuditLog, :count).by(1)

      expect(response).to have_http_status(:bad_request)
      expect(response.parsed_body["message"]).to eq("Both 'from' and 'to' email addresses are required")
      expect(AdminApiAuditLog.last).to have_attributes(action: "purchases.reassign", target_id: nil, response_status: 400)
    end

    it "treats blank addresses as missing", parity: true do
      reassign(from: "  ", to: "")

      expect(response).to have_http_status(:bad_request)
    end

    it "refuses the same address written in another case", parity: true do
      reassign(from: "Old@example.com", to: "old@EXAMPLE.com")

      expect(response).to have_http_status(:unprocessable_entity)
      expect(response.parsed_body["message"]).to eq("from and to emails are the same")
    end

    it "answers 404 when no purchase was made with the address", parity: true do
      reassign(from: "nobody@example.com", to: "new@example.com")

      expect(response).to have_http_status(:not_found)
      expect(response.parsed_body["message"]).to eq("No purchases found for email: nobody@example.com")
    end

    it "redacts the addresses in the audit row", parity: true do
      reassign(from: "nobody@example.com", to: "new@example.com")

      expect(AdminApiAuditLog.last.params_snapshot).to include("from" => "[REDACTED]", "to" => "[REDACTED]")
    end

    it "hands a reassignment of a buyer's purchases to Rails", parity: true do
      build(:purchase, email: "old@example.com", purchase_state: "successful", charge_processor_id: "paypal", stripe_transaction_id: "PAYPAL-TXN-1", merchant_account: nil).save!(validate: false)

      result = Purchase::ReassignByEmailService::Result.new(success: true, reassigned_purchase_ids: [1], reason: nil)
      allow_any_instance_of(Purchase::ReassignByEmailService).to receive(:perform).and_return(result)

      reassign(from: "old@example.com", to: "new@example.com")

      expect(response).to have_http_status(:ok)
    end
  end
end
