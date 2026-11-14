# frozen_string_literal: true

require "spec_helper"

# Api::Internal::Admin::UsersController#purchases, #related, #social_connections and #radar_stats through the whole stack, on the API
# host with a per-actor token. Recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/ws17e-admin-api.replay.test.ts. The "hands a ..." examples are requests the port leaves to Rails (a Stripe
# risk level, a funnel event, an identity table, several fraud-warning groups): the replay asserts they reach the stand-in Rails
# untouched and write nothing.
describe "Internal admin API user reads", type: :request do
  let(:admin) { create(:admin_user, name: "Admin User", email: "admin@example.com") }
  let(:headers) { { "Authorization" => "Bearer per-actor-token", "Host" => API_DOMAIN } }
  let(:user) { create(:user, email: "subject@example.com", name: "Subject User") }
  let(:seller) { create(:user, email: "seller@example.com", name: "Seller Name") }
  let(:product) { create(:product, user: seller, name: "Guide", price_cents: 1500) }

  before do
    create(:admin_api_token, actor_user: admin, token_hash: AdminApiToken.hash_token("per-actor-token"))
  end

  def create_purchase(**attributes)
    defaults = { seller:, link: product, email: "buyer@example.com", price_cents: 1500, purchase_state: "successful", charge_processor_id: "paypal", stripe_transaction_id: "PAYPAL-TXN-1", merchant_account: nil, created_at: 3.days.ago }
    build(:purchase, **defaults, **attributes).tap { _1.save!(validate: false) }
  end

  describe "GET purchases" do
    it "lists what the user bought and what was bought under their email, newest first", parity: true do
      bought = create_purchase(purchaser: user, email: "other-address@example.com", created_at: 3.days.ago)
      by_email = create_purchase(email: "subject@example.com", created_at: 2.days.ago)
      create_purchase(email: "stranger@example.com", created_at: 1.day.ago)

      get "/internal/admin/users/purchases", params: { user_id: user.external_id }, headers: headers

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body["purchases"].map { _1["id"] }).to eq([by_email.external_id_numeric.to_s, bought.external_id_numeric.to_s])
      expect(response.parsed_body["pagination"]).to eq("next" => nil, "limit" => 20)
    end

    it "lists only what the user bought when the account has no email", parity: true do
      user.update_columns(email: nil)
      create_purchase(purchaser: user, email: "buyer@example.com")
      create_purchase(email: "", created_at: 1.day.ago)

      get "/internal/admin/users/purchases", params: { user_id: user.external_id }, headers: headers

      expect(response.parsed_body["purchases"].size).to eq(1)
    end

    it "limits a page and hands out a cursor for the next one", parity: true do
      create_purchase(purchaser: user, created_at: 3.days.ago)
      create_purchase(purchaser: user, created_at: 2.days.ago)

      get "/internal/admin/users/purchases", params: { user_id: user.external_id, limit: 1 }, headers: headers

      expect(response.parsed_body["purchases"].size).to eq(1)
      expect(response.parsed_body["pagination"]["next"]).to be_present
    end

    it "filters by purchase state, accepting a list and comma separated values", parity: true do
      create_purchase(purchaser: user, purchase_state: "successful")
      failed = create_purchase(purchaser: user, purchase_state: "failed", created_at: 1.day.ago)
      create_purchase(purchaser: user, purchase_state: "not_charged", created_at: 2.days.ago)

      get "/internal/admin/users/purchases", params: { user_id: user.external_id, status: "failed, not_charged" }, headers: headers
      expect(response.parsed_body["purchases"].size).to eq(2)

      get "/internal/admin/users/purchases", params: { user_id: user.external_id, status: ["failed"] }, headers: headers
      expect(response.parsed_body["purchases"].map { _1["id"] }).to eq([failed.external_id_numeric.to_s])
    end

    it "filters by a time range written in ISO 8601", parity: true do
      create_purchase(purchaser: user)

      get "/internal/admin/users/purchases", params: { user_id: user.external_id, start_at: "2000-01-01T00:00:00Z", end_at: "2999-12-31T23:59:59.5+02:00" }, headers: headers
      expect(response.parsed_body["purchases"].size).to eq(1)

      get "/internal/admin/users/purchases", params: { user_id: user.external_id, start_at: "2999-01-01T00:00:00Z" }, headers: headers
      expect(response.parsed_body["purchases"]).to eq([])

      get "/internal/admin/users/purchases", params: { user_id: user.external_id, end_at: "2000-01-01T00:00:00-05:00" }, headers: headers
      expect(response.parsed_body["purchases"]).to eq([])
    end

    it "filters by chargeback, early fraud warning and affiliate", parity: true do
      charged_back = create_purchase(purchaser: user, chargeback_date: 1.day.ago)
      warned = create_purchase(purchaser: user, created_at: 4.days.ago)
      create(:early_fraud_warning, purchase: warned)
      create_purchase(purchaser: user, created_at: 6.days.ago)

      get "/internal/admin/users/purchases", params: { user_id: user.external_id, chargedback: "true" }, headers: headers
      expect(response.parsed_body["purchases"].map { _1["id"] }).to eq([charged_back.external_id_numeric.to_s])

      get "/internal/admin/users/purchases", params: { user_id: user.external_id, chargedback: "false", has_early_fraud_warning: "true" }, headers: headers
      expect(response.parsed_body["purchases"].map { _1["id"] }).to eq([warned.external_id_numeric.to_s])

      get "/internal/admin/users/purchases", params: { user_id: user.external_id, has_affiliate: "false", has_early_fraud_warning: "false", chargedback: "f" }, headers: headers
      expect(response.parsed_body["purchases"].size).to eq(1)
    end

    it "reads a purchase that came through an affiliate", parity: true do
      affiliated = create_purchase(purchaser: user, created_at: 5.days.ago)
      affiliated.update_columns(affiliate_id: create(:direct_affiliate, seller:).id)

      get "/internal/admin/users/purchases", params: { user_id: user.external_id, has_early_fraud_warning: "off", has_affiliate: "1" }, headers: headers

      expect(response.parsed_body["purchases"].map { _1["id"] }).to eq([affiliated.external_id_numeric.to_s])
    end

    it "filters by card fingerprint and IP address", parity: true do
      match = create_purchase(purchaser: user, stripe_fingerprint: "fingerprint-1", ip_address: "203.0.113.7")
      create_purchase(purchaser: user, stripe_fingerprint: "fingerprint-2", ip_address: "198.51.100.1", created_at: 1.day.ago)

      get "/internal/admin/users/purchases", params: { user_id: user.external_id, stripe_fingerprint: "fingerprint-1" }, headers: headers
      expect(response.parsed_body["purchases"].map { _1["id"] }).to eq([match.external_id_numeric.to_s])

      get "/internal/admin/users/purchases", params: { user_id: user.external_id, ip_address: "198.51.100.1" }, headers: headers
      expect(response.parsed_body["purchases"].size).to eq(1)
    end

    it "reads a soft-deleted account", parity: true do
      user.update_columns(deleted_at: 1.day.ago)

      get "/internal/admin/users/purchases", params: { email: "subject@example.com" }, headers: headers

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body["purchases"]).to eq([])
    end

    it "requires a way to find the user", parity: true do
      get "/internal/admin/users/purchases", headers: headers

      expect(response).to have_http_status(:bad_request)
    end

    it "answers 404 for an unknown user", parity: true do
      get "/internal/admin/users/purchases", params: { user_id: "unknown" }, headers: headers

      expect(response).to have_http_status(:not_found)
    end

    it "refuses an unknown purchase state", parity: true do
      get "/internal/admin/users/purchases", params: { user_id: user.external_id, status: "successful,refunded" }, headers: headers

      expect(response).to have_http_status(:bad_request)
      expect(response.parsed_body["message"]).to start_with("status must be one of: in_progress, successful")
    end

    it "refuses a status made of separators only", parity: true do
      get "/internal/admin/users/purchases", params: { user_id: user.external_id, status: " , " }, headers: headers

      expect(response).to have_http_status(:bad_request)
    end

    it "refuses a start that is not an ISO 8601 timestamp", parity: true do
      get "/internal/admin/users/purchases", params: { user_id: user.external_id, start_at: "yesterday" }, headers: headers

      expect(response.parsed_body["message"]).to eq("start_at must be a valid ISO 8601 timestamp")
    end

    it "refuses an end that is not an ISO 8601 timestamp", parity: true do
      get "/internal/admin/users/purchases", params: { user_id: user.external_id, end_at: "2020-13-45T00:00:00Z" }, headers: headers

      expect(response.parsed_body["message"]).to eq("end_at must be a valid ISO 8601 timestamp")
    end

    it "refuses a boolean filter that is neither true nor false", parity: true do
      get "/internal/admin/users/purchases", params: { user_id: user.external_id, chargedback: "" }, headers: headers

      expect(response).to have_http_status(:bad_request)
      expect(response.parsed_body["message"]).to eq("chargedback must be true or false")
    end

    it "refuses a cursor it did not sign", parity: true do
      get "/internal/admin/users/purchases", params: { user_id: user.external_id, cursor: "bogus" }, headers: headers

      expect(response).to have_http_status(:bad_request)
      expect(response.parsed_body["message"]).to eq("invalid cursor")
    end

    it "hands a purchase charged through Stripe to Rails", parity: true do
      create_purchase(purchaser: user, charge_processor_id: "stripe", stripe_transaction_id: "ch_1")
      allow(Radar::ChargeRiskLevelService).to receive(:fetch_bulk).and_return({})

      get "/internal/admin/users/purchases", params: { user_id: user.external_id }, headers: headers

      expect(response).to have_http_status(:ok)
    end

    it "reads a timestamp without a zone as UTC and rolls a day past the end of the month over", parity: true do
      create_purchase(purchaser: user)

      get "/internal/admin/users/purchases", params: { user_id: user.external_id, start_at: " 2000-02-30t00:00:00 ", end_at: "2999-01-01T24:00:00+0530" }, headers: headers

      expect(response.parsed_body["purchases"].size).to eq(1)
    end

    it "refuses a date without a time", parity: true do
      get "/internal/admin/users/purchases", params: { user_id: user.external_id, start_at: "2020-01-01" }, headers: headers

      expect(response.parsed_body["message"]).to eq("start_at must be a valid ISO 8601 timestamp")
    end

    it "refuses a leap second that is not the last of a minute and an offset of a day", parity: true do
      get "/internal/admin/users/purchases", params: { user_id: user.external_id, start_at: "2020-01-01T00:00:61Z" }, headers: headers
      expect(response).to have_http_status(:bad_request)

      get "/internal/admin/users/purchases", params: { user_id: user.external_id, end_at: "2020-01-01T00:00:00+24:00" }, headers: headers
      expect(response).to have_http_status(:bad_request)
    end

    it "reads a timestamp in a year before 1000", parity: true do
      get "/internal/admin/users/purchases", params: { user_id: user.external_id, start_at: "0999-01-01T00:00:00Z" }, headers: headers

      expect(response).to have_http_status(:ok)
    end
  end

  describe "GET related" do
    before do
      user.update_columns(account_created_ip: "203.0.113.7", current_sign_in_ip: "203.0.113.7", last_sign_in_ip: "198.51.100.9", payment_address: "paypal-shared@example.com")
    end

    it "finds the accounts sharing an IP address, a payout address or a card", parity: true do
      card = create(:indian_stripe_credit_card, stripe_fingerprint: "fingerprint-shared")
      user.update_columns(credit_card_id: card.id)
      by_ip = create(:user, email: "by-ip@example.com", name: "By IP", updated_at: 3.hours.ago)
      by_ip.update_columns(last_sign_in_ip: "203.0.113.7", current_sign_in_ip: "198.51.100.9", updated_at: 3.hours.ago)
      everything = create(:user, email: "everything@example.com", name: "Everything")
      everything.update_columns(account_created_ip: "198.51.100.9", payment_address: "paypal-shared@example.com", credit_card_id: create(:indian_stripe_credit_card, stripe_fingerprint: "fingerprint-shared").id, updated_at: 5.hours.ago)
      by_address = create(:user, email: "by-address@example.com", name: "By address", deleted_at: 1.day.ago)
      by_address.update_columns(payment_address: "paypal-shared@example.com", updated_at: 1.hour.ago)

      get "/internal/admin/users/related", params: { user_id: user.external_id }, headers: headers

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body["signals_evaluated"]).to eq(%w[ip payment_address card_fingerprint])
      expect(response.parsed_body["related_users"].map { _1["email"] }).to eq(["everything@example.com", "by-address@example.com", "by-ip@example.com"])
    end

    it "reads only the signals asked for, once each", parity: true do
      create(:user, email: "by-ip@example.com").update_columns(current_sign_in_ip: "203.0.113.7")
      create(:user, email: "by-address@example.com").update_columns(payment_address: "paypal-shared@example.com")

      get "/internal/admin/users/related", params: { user_id: user.external_id, signals: "payment_address, payment_address" }, headers: headers

      expect(response.parsed_body["signals_evaluated"]).to eq(["payment_address"])
      expect(response.parsed_body["truncated"]).to eq("payment_address" => false)
      expect(response.parsed_body["related_users"].size).to eq(1)
    end

    it "caps each signal at the limit and says so", parity: true do
      2.times { |index| create(:user, email: "sibling#{index}@example.com").update_columns(current_sign_in_ip: "203.0.113.7", updated_at: (index + 1).hours.ago) }

      get "/internal/admin/users/related", params: { user_id: user.external_id, signals: "ip", limit: "1" }, headers: headers

      expect(response.parsed_body["per_signal_limit"]).to eq(1)
      expect(response.parsed_body["truncated"]).to eq("ip" => true)
      expect(response.parsed_body["related_users"].size).to eq(1)
    end

    it "treats a limit that is not a number as the default", parity: true do
      get "/internal/admin/users/related", params: { user_id: user.external_id, signals: "ip", limit: "many" }, headers: headers

      expect(response.parsed_body["per_signal_limit"]).to eq(50)
    end

    it "reports the signals an account has nothing to compare for", parity: true do
      lonely = create(:user, email: "lonely@example.com")
      lonely.update_columns(account_created_ip: nil, current_sign_in_ip: "", last_sign_in_ip: nil, payment_address: "")

      get "/internal/admin/users/related", params: { user_id: lonely.external_id }, headers: headers

      expect(response.parsed_body).to include("signals_evaluated" => [], "related_users" => [], "truncated" => { "ip" => false, "payment_address" => false, "card_fingerprint" => false })
    end

    it "marks a related account that is suspended", parity: true do
      suspended = create(:user, email: "suspended@example.com")
      suspended.update_columns(current_sign_in_ip: "203.0.113.7", user_risk_state: "suspended_for_fraud")
      create(:comment, commentable: suspended, comment_type: "suspended", content: "Suspended", created_at: 2.days.ago)

      get "/internal/admin/users/related", params: { user_id: user.external_id, signals: "ip" }, headers: headers

      expect(response.parsed_body["related_users"].sole["risk_state"]).to include("status" => "Suspended", "suspended" => true)
    end

    it "refuses a signal it does not know", parity: true do
      get "/internal/admin/users/related", params: { user_id: user.external_id, signals: "ip,cookie" }, headers: headers

      expect(response).to have_http_status(:bad_request)
      expect(response.parsed_body["message"]).to eq("signals contains invalid value: cookie")
    end

    it "refuses a signals list made of separators only", parity: true do
      get "/internal/admin/users/related", params: { user_id: user.external_id, signals: ", ," }, headers: headers

      expect(response.parsed_body["message"]).to eq("signals contains invalid value: , ,")
    end

    it "answers 404 for an unknown user", parity: true do
      get "/internal/admin/users/related", params: { email: "nobody@example.com" }, headers: headers

      expect(response).to have_http_status(:not_found)
    end

    it "reads a limit written in hexadecimal", parity: true do
      get "/internal/admin/users/related", params: { user_id: user.external_id, limit: "0x10" }, headers: headers

      expect(response).to have_http_status(:ok)
    end
  end

  describe "GET social_connections" do
    it "lists the Twitter connections of a user with how many other accounts share each", parity: true do
      user.update_columns(twitter_user_id: "tw-1")
      create(:social_connect_verification, user:, platform: "twitter", uid: "tw-1", handle: "linked", last_verified_at: 1.day.ago)
      create(:social_connect_verification, user:, platform: "twitter", uid: "tw-old", handle: "old", last_verified_at: 3.days.ago, superseded_at: 2.days.ago)
      create(:social_connect_verification, user: create(:user), platform: "twitter", uid: "tw-1")
      create(:social_connect_verification, user: create(:user), platform: "twitter", uid: "tw-1")

      get "/internal/admin/users/social_connections", params: { user_id: user.external_id }, headers: headers

      expect(response).to have_http_status(:ok)
      connections = response.parsed_body["social_connections"]
      expect(connections.map { _1["uid"] }).to eq(%w[tw-1 tw-old])
      expect(connections.first).to include("currently_linked" => true, "shared_identity_user_count" => 2)
      expect(connections.last).to include("currently_linked" => false)
      expect(response.parsed_body["latest_shadow_evaluation"]).to be_nil
    end

    it "shows a connection that is no longer linked to the account", parity: true do
      create(:social_connect_verification, user:, platform: "twitter", uid: "tw-2")

      get "/internal/admin/users/social_connections", params: { user_id: user.external_id }, headers: headers

      expect(response.parsed_body["social_connections"].sole["currently_linked"]).to be(false)
    end

    it "includes the latest stored shadow evaluation", parity: true do
      create(:social_score_shadow_evaluation, user:, evaluated_on: 3.days.ago.to_date, score: 1, signals: nil)
      latest = create(:social_score_shadow_evaluation, user:, evaluated_on: 1.day.ago.to_date, score: 4, unpaid_balance_cents: 2_500, would_have_released: true, signals: nil)

      get "/internal/admin/users/social_connections", params: { user_id: user.external_id }, headers: headers

      expect(response.parsed_body["social_connections"]).to eq([])
      expect(response.parsed_body["latest_shadow_evaluation"]).to include("score" => 4, "unpaid_balance_cents" => 2_500, "would_have_released" => true, "evaluated_on" => latest.evaluated_on.iso8601)
    end

    it "reads a soft-deleted account", parity: true do
      user.update_columns(deleted_at: 1.day.ago)

      get "/internal/admin/users/social_connections", params: { user_id: user.external_id }, headers: headers

      expect(response).to have_http_status(:ok)
    end

    it "answers 404 for an unknown user", parity: true do
      get "/internal/admin/users/social_connections", params: { user_id: "unknown" }, headers: headers

      expect(response).to have_http_status(:not_found)
    end

    it "hands a user who was offered the connection to Rails", parity: true do
      Event.create!(user_id: user.id, event_name: "social_connect_offered", ip_address: "203.0.113.7")

      get "/internal/admin/users/social_connections", params: { user_id: user.external_id }, headers: headers

      expect(response).to have_http_status(:ok)
    end

    it "reports a YouTube, Instagram and TikTok connection as linked only while the identity row holds the same id", parity: true do
      create(:user_youtube_identity, user:, channel_id: "channel-1")
      create(:social_connect_verification, user:, platform: "youtube", uid: "channel-1")
      create(:user_instagram_identity, user:, instagram_user_id: "ig-new")
      create(:social_connect_verification, user:, platform: "instagram", uid: "ig-old")
      create(:social_connect_verification, user:, platform: "tiktok", uid: "tt-1")
      create(:social_connect_verification, user: create(:user), platform: "youtube", uid: "channel-1")

      get "/internal/admin/users/social_connections", params: { user_id: user.external_id }, headers: headers

      connections = response.parsed_body["social_connections"]
      expect(connections.map { [_1["platform"], _1["currently_linked"]] }).to eq([["instagram", false], ["tiktok", false], ["youtube", true]])
      expect(connections.last["shared_identity_user_count"]).to eq(1)
    end

    it "reports a connection linked when the TikTok identity holds its id and a superseded one not", parity: true do
      create(:user_tiktok_identity, user:, tiktok_open_id: "tt-1")
      create(:social_connect_verification, user:, platform: "tiktok", uid: "tt-1", last_verified_at: 1.day.ago)
      create(:social_connect_verification, user:, platform: "tiktok", uid: "tt-0", last_verified_at: 3.days.ago, superseded_at: 2.days.ago)

      get "/internal/admin/users/social_connections", params: { user_id: user.external_id }, headers: headers

      expect(response.parsed_body["social_connections"].map { _1["currently_linked"] }).to eq([true, false])
    end

    it "reads a shadow evaluation with fractional signals", parity: true do
      create(:social_score_shadow_evaluation, user:, signals: { "followers" => 1.5 })

      get "/internal/admin/users/social_connections", params: { user_id: user.external_id }, headers: headers

      expect(response).to have_http_status(:ok)
    end
  end

  describe "GET radar_stats" do
    def create_stripe_purchase(**attributes)
      create_purchase(charge_processor_id: "stripe", stripe_transaction_id: "ch_#{SecureRandom.hex(4)}", **attributes)
    end

    it "counts the seller's successful sales, fraud warnings and disputes of the last 90 days", parity: true do
      warned = create_stripe_purchase(created_at: 10.days.ago)
      create(:early_fraud_warning, purchase: warned, charge_risk_level: "elevated", created_at: 5.days.ago, processor_id: "issfr_1")
      create(:early_fraud_warning, purchase: create_stripe_purchase(created_at: 20.days.ago, email: "second@example.com"), charge_risk_level: "elevated", created_at: 4.days.ago, processor_id: "issfr_2")
      create_stripe_purchase(created_at: 30.days.ago, email: "third@example.com")
      create_stripe_purchase(created_at: 200.days.ago, email: "old@example.com")
      create_stripe_purchase(created_at: 5.days.ago, email: "failed@example.com", purchase_state: "failed")
      create_purchase(created_at: 5.days.ago, email: "paypal@example.com")
      create(:dispute, purchase: warned, state: :formalized, reason: Dispute::REASON_FRAUDULENT, charge_processor_dispute_id: "dp_1", initiated_at: 3.days.ago, formalized_at: 2.days.ago, created_at: 3.days.ago)
      create(:dispute, purchase: create_stripe_purchase(created_at: 25.days.ago, email: "fourth@example.com"), state: :won, reason: Dispute::REASON_FRAUDULENT, charge_processor_dispute_id: "dp_2", initiated_at: 3.days.ago, created_at: 3.days.ago)

      get "/internal/admin/users/radar_stats", params: { user_id: seller.external_id }, headers: headers

      expect(response).to have_http_status(:ok)
      stats = response.parsed_body["radar_stats"]
      expect(stats).to include("successful_purchases" => 4, "efw_count" => 2, "efw_with_elevated_risk" => 2, "efw_with_highest_risk" => 0, "dispute_count" => 1, "dispute_rate" => 25.0)
      expect(response.parsed_body["recent_efws"].size).to eq(2)
    end

    it "rounds the dispute rate to two decimals", parity: true do
      3.times { |index| create_stripe_purchase(created_at: (index + 1).days.ago, email: "buyer#{index}@example.com") }
      create(:dispute, purchase: Purchase.last, state: :formalized, reason: Dispute::REASON_FRAUDULENT, charge_processor_dispute_id: "dp_3", initiated_at: 1.day.ago, created_at: 1.day.ago)

      get "/internal/admin/users/radar_stats", params: { user_id: seller.external_id }, headers: headers

      expect(response.parsed_body["radar_stats"]).to include("successful_purchases" => 3, "dispute_count" => 1, "dispute_rate" => 33.33)
    end

    it "reports zeros for a seller with no sales", parity: true do
      get "/internal/admin/users/radar_stats", params: { user_id: user.external_id }, headers: headers

      expect(response.parsed_body["radar_stats"]).to eq("successful_purchases" => 0, "efw_count" => 0, "efw_by_fraud_type" => {}, "efw_with_elevated_risk" => 0, "efw_with_highest_risk" => 0, "dispute_count" => 0, "dispute_rate" => 0.0)
      expect(response.parsed_body["recent_efws"]).to eq([])
    end

    it "names the fraud type of the warnings", parity: true do
      create(:early_fraud_warning, purchase: create_purchase, fraud_type: "unauthorized_use_of_card", charge_risk_level: "highest", created_at: 2.days.ago)

      get "/internal/admin/users/radar_stats", params: { user_id: seller.external_id }, headers: headers

      expect(response.parsed_body["radar_stats"]).to include("efw_by_fraud_type" => { "unauthorized_use_of_card" => 1 }, "efw_with_highest_risk" => 1)
    end

    it "limits the list of recent warnings and hands out a cursor", parity: true do
      2.times { |index| create(:early_fraud_warning, purchase: create_stripe_purchase(email: "buyer#{index}@example.com"), created_at: (index + 1).days.ago, processor_id: "issfr_#{index}") }

      get "/internal/admin/users/radar_stats", params: { user_id: seller.external_id, limit: 1 }, headers: headers

      expect(response.parsed_body["recent_efws"].size).to eq(1)
      expect(response.parsed_body["pagination"]["next"]).to be_present
    end

    it "refuses a cursor it did not sign", parity: true do
      get "/internal/admin/users/radar_stats", params: { user_id: seller.external_id, cursor: "bogus" }, headers: headers

      expect(response).to have_http_status(:bad_request)
    end

    it "answers 404 for an unknown user", parity: true do
      get "/internal/admin/users/radar_stats", params: { user_id: "unknown" }, headers: headers

      expect(response).to have_http_status(:not_found)
    end

    it "hands warnings of several fraud types to Rails", parity: true do
      create(:early_fraud_warning, purchase: create_purchase, fraud_type: "made_with_stolen_card", created_at: 2.days.ago, processor_id: "issfr_a")
      create(:early_fraud_warning, purchase: create_stripe_purchase(email: "second@example.com"), fraud_type: "misc", created_at: 2.days.ago, processor_id: "issfr_b")

      get "/internal/admin/users/radar_stats", params: { user_id: seller.external_id }, headers: headers

      expect(response).to have_http_status(:ok)
    end
  end
end
