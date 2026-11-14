# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/lift-platform-stripe-pause.golden.json: the real
# LiftPlatformStripePauseJob (perform, sidekiq_retry_in and sidekiq_retries_exhausted) against a
# scratch database, with Stripe answered by the local capture server. Each case runs as a Sidekiq job
# (support/sidekiq_executor.rb). Run it like user-writes.rb, adding USE_DB_WORKER_REPLICAS=true.
require_relative "support/rails_cases"
require_relative "../../src/server/stripe/__fixtures__/capture_server"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/lift-platform-stripe-pause.golden.json")
NOW = Time.utc(2025, 11, 1, 12, 30, 45, 123_000)
SEEDED_AT = "2025-01-01 00:00:00"
TABLES = %w[users comments versions seller_profiles links events merchant_accounts payments feature_announcement_newsletter_cutovers
            active_storage_attachments affiliate_requests].freeze
PAUSED_INTERNALLY = 1 << 19
PAUSED_BY_USER = 1 << 40
MISSING_CAPABILITY = "Your destination account needs to have at least one of the following capabilities enabled: transfers"

SERVER = CaptureServer.new
Stripe.api_base = "http://127.0.0.1:#{SERVER.port}"
Stripe.api_key = "sk_test_golden"
Stripe.max_network_retries = 0

def user_row(id, **overrides)
  {
    id:, email: "seller#{id}@example.com", username: "seller#{id}", external_id: (1000 + id).to_s, recommendation_type: "own_products",
    user_risk_state: "compliant", flags: 0, json_data: nil, confirmed_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT
  }.merge(overrides)
end

def held_user(id = 5, flags: PAUSED_INTERNALLY) = user_row(id, flags:, json_data: '{"payouts_paused_by":"system"}')

def account_row(id, stripe_id, **overrides)
  {
    id:, user_id: 5, charge_processor_id: "stripe", charge_processor_merchant_id: stripe_id, json_data: nil,
    charge_processor_alive_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT
  }.merge(overrides)
end

def failed_payment(id, created_at, account: "acct_1", **overrides)
  {
    id:, user_id: 5, state: "failed", processor: "STRIPE", bank_account_id: 1, stripe_connect_account_id: account, failure_reason: "cannot_pay",
    json_data: { error_message: MISSING_CAPABILITY }.to_json, amount_cents: 1000, created_at:, updated_at: created_at
  }.merge(overrides)
end

def comment_row(id, type, author, content, created_at)
  { id:, commentable_id: 5, commentable_type: "User", comment_type: type, author_name: author, content:, created_at:, updated_at: created_at }
end

HOLD_COMMENT = comment_row(1, "on", "pause_payouts_after_repeated_failures", "Payouts paused after 3 failed payouts", "2025-10-05 00:00:00")
FAILURES = [failed_payment(1, "2025-10-01 00:00:00"), failed_payment(2, "2025-10-02 00:00:00"), failed_payment(3, "2025-10-03 00:00:00")].freeze

def account_json(id, charges:, payouts: false, disabled_reason: nil, past_due: [], transfers: "active")
  {
    id:, object: "account",
    risk_controls: { charges: { pause_requested: charges }, payouts: { pause_requested: payouts } },
    requirements: { disabled_reason:, past_due: },
    future_requirements: { past_due: [] },
    capabilities: { transfers: },
  }
end

def ok(body) = [200, { "Content-Type" => "application/json", "Request-Id" => "req_ok" }, body.to_json]
def not_found(id) = [404, { "Content-Type" => "application/json", "Request-Id" => "req_404" },
                     { error: { type: "invalid_request_error", code: "resource_missing", message: "No such account: '#{id}'", param: "account" } }.to_json]

def run(name, args: [5], seed: {}, stripe: [], &block)
  SERVER.requests.clear
  SERVER.responses = stripe.dup
  block ||= -> { LiftPlatformStripePauseJob.new.perform(*args) }
  result = capture(name, now: NOW, tables: TABLES, seed:, sidekiq: true, args:, &block)
  result.merge("stripe" => { "responses" => stripe, "requests" => SERVER.requests.map { _1.slice("method", "path", "query", "body") } })
end

cases = []

cases << run("a seller who is no longer compliant", seed: { users: [user_row(5, user_risk_state: "flagged_for_fraud")] })
cases << run("a closed seller", seed: { users: [user_row(5, deleted_at: SEEDED_AT)] })
cases << run("no Stripe accounts", seed: { users: [user_row(5)] })
cases << run("a Connect account is not ours to lift", seed: {
  users: [user_row(5)], merchant_accounts: [account_row(1, "acct_1", json_data: '{"meta":{"stripe_connect":"true"}}')],
})
cases << run("an account with no platform pause", seed: { users: [user_row(5)], merchant_accounts: [account_row(1, "acct_1")] },
             stripe: [ok(account_json("acct_1", charges: false))])
cases << run("lifts the pause and releases the failed-payout hold", seed: {
  users: [held_user], merchant_accounts: [account_row(1, "acct_1")], comments: [HOLD_COMMENT], payments: FAILURES,
}, stripe: [ok(account_json("acct_1", charges: true, disabled_reason: "platform_paused")), ok(account_json("acct_1", charges: false, disabled_reason: "platform_paused"))])
cases << run("keeps a hold the seller also paused", seed: {
  users: [held_user(flags: PAUSED_INTERNALLY | PAUSED_BY_USER)], merchant_accounts: [account_row(1, "acct_1")], comments: [HOLD_COMMENT], payments: FAILURES,
}, stripe: [ok(account_json("acct_1", charges: true, disabled_reason: "platform_paused")), ok(account_json("acct_1", charges: false))])
cases << run("transfers not back on yet raises for a later retry", seed: {
  users: [held_user], merchant_accounts: [account_row(1, "acct_1")], comments: [HOLD_COMMENT], payments: FAILURES,
}, stripe: [ok(account_json("acct_1", charges: true, disabled_reason: "platform_paused")), ok(account_json("acct_1", charges: false, transfers: "inactive"))])
cases << run("an unaccounted-money hold is left for a person", seed: {
  users: [held_user], merchant_accounts: [account_row(1, "acct_1")], payments: FAILURES,
  comments: [comment_row(1, "on", "pause_payouts_after_repeated_failures", "Payouts paused: 12.00 could not be accounted for", "2025-10-05 00:00:00")],
}, stripe: [ok(account_json("acct_1", charges: true, disabled_reason: "platform_paused")), ok(account_json("acct_1", charges: false))])
cases << run("a failure after the lift keeps the hold", seed: {
  users: [held_user], merchant_accounts: [account_row(1, "acct_1")], comments: [HOLD_COMMENT],
  payments: FAILURES[0, 2] + [failed_payment(3, "2025-12-01 00:00:00")],
}, stripe: [ok(account_json("acct_1", charges: true, disabled_reason: "platform_paused")), ok(account_json("acct_1", charges: false))])
DESTINATION_FAILURES = (1..3).map do |n|
  failed_payment(n, "2025-10-0#{n} 00:00:00", bank_account_id: nil, json_data: { error_message: MISSING_CAPABILITY, stripe_payout_destination_id: "ba_1" }.to_json)
end
cases << run("failures to a Stripe payout destination", seed: {
  users: [held_user], merchant_accounts: [account_row(1, "acct_1")], comments: [HOLD_COMMENT],
  payments: DESTINATION_FAILURES + [failed_payment(4, "2025-09-01 00:00:00", bank_account_id: nil, state: "completed", json_data: { stripe_payout_destination_id: "ba_1" }.to_json)],
}, stripe: [ok(account_json("acct_1", charges: true, disabled_reason: "platform_paused")), ok(account_json("acct_1", charges: false))])
cases << run("PayPal failures were not the pause", seed: {
  users: [held_user], merchant_accounts: [account_row(1, "acct_1")], comments: [HOLD_COMMENT],
  payments: (1..3).map { |n| failed_payment(n, "2025-10-0#{n} 00:00:00", processor: "PAYPAL", bank_account_id: nil, stripe_connect_account_id: nil, payment_address: "p@example.com") },
}, stripe: [ok(account_json("acct_1", charges: true, disabled_reason: "platform_paused")), ok(account_json("acct_1", charges: false))])
cases << run("payouts paused at Stripe too are left alone", seed: { users: [user_row(5)], merchant_accounts: [account_row(1, "acct_1")] },
             stripe: [ok(account_json("acct_1", charges: true, payouts: true, disabled_reason: "platform_paused"))])
cases << run("a pause with past-due requirements is left alone", seed: { users: [user_row(5)], merchant_accounts: [account_row(1, "acct_1")] },
             stripe: [ok(account_json("acct_1", charges: true, disabled_reason: "platform_paused", past_due: ["external_account"]))])
cases << run("a missing Stripe account is noted and skipped", seed: {
  users: [user_row(5)], merchant_accounts: [account_row(1, "acct_gone"), account_row(2, "acct_2")],
}, stripe: [not_found("acct_gone"), ok(account_json("acct_2", charges: false))])
cases << run("confirms a lift an earlier attempt never recorded", seed: {
  users: [user_row(5)], merchant_accounts: [account_row(1, "acct_1")],
  comments: [comment_row(7, "note", "platform-stripe-pause-lift", "Lifting the platform Stripe pause on acct_1 after the account was marked compliant. Before: x.", "2025-10-30 00:00:00")],
}, stripe: [ok(account_json("acct_1", charges: false, disabled_reason: "platform_paused"))])
cases << run("an account lifted on an earlier run is not lifted again", seed: {
  users: [user_row(5)], merchant_accounts: [account_row(1, "acct_1")],
  comments: [comment_row(7, "note", "platform-stripe-pause-lift", "Lifted the platform Stripe pause on acct_1 after the account was marked compliant.", "2025-10-30 00:00:00")],
}, stripe: [ok(account_json("acct_1", charges: false))])
cases << run("a seller flagged while Stripe answered is not lifted", seed: {
  users: [user_row(5)], merchant_accounts: [account_row(1, "acct_1")],
  comments: [comment_row(7, "note", "platform-stripe-pause-lift", "Lifting the platform Stripe pause on acct_1 after the account was marked compliant. Before: x.", "2025-10-30 00:00:00")],
}, stripe: [ok(account_json("acct_1", charges: true, disabled_reason: "platform_paused"))]) do
  # The retrieve flips the row, as a concurrent review would.
  Stripe::Account.singleton_class.prepend(Module.new do
    def retrieve(*)
      super.tap { User.where(id: 5).update_all(user_risk_state: "flagged_for_fraud") }
    end
  end)
  LiftPlatformStripePauseJob.new.perform(5)
end

exhausted = LiftPlatformStripePauseJob.sidekiq_retries_exhausted_block
transfers_error = LiftPlatformStripePauseJob::TransfersNotActiveYet.new("Stripe has not turned transfers back on for the account.")
cases << run("retries exhausted: abandons a pending lift and keeps the hold", seed: {
  users: [held_user], merchant_accounts: [account_row(1, "acct_1"), account_row(2, "acct_2")],
  comments: [HOLD_COMMENT, comment_row(7, "note", "platform-stripe-pause-lift", "Lifting the platform Stripe pause on acct_1 after the account was marked compliant. Before: x.", "2025-10-30 00:00:00")],
}) { exhausted.call({ "args" => [5] }, transfers_error) }
cases << run("retries exhausted on another error only abandons", seed: {
  users: [held_user], merchant_accounts: [account_row(1, "acct_1")],
  comments: [HOLD_COMMENT, comment_row(7, "note", "platform-stripe-pause-lift", "Lifting the platform Stripe pause on acct_1 after the account was marked compliant. Before: x.", "2025-10-30 00:00:00")],
}) { exhausted.call({ "args" => [5] }, RuntimeError.new("boom")) }
cases << run("retries exhausted for a missing seller", args: [404]) { exhausted.call({ "args" => [404] }, transfers_error) }

retry_in = LiftPlatformStripePauseJob.sidekiq_retry_in_block
retry_delays = [[0, true], [1, true], [2, true], [3, true], [0, false]].map do |count, transfers|
  [count, transfers, retry_in.call(count, transfers ? transfers_error : RuntimeError.new("boom"))]
end

now_f = travel_to(NOW, with_usec: true) { Time.now.to_f }
File.write(OUT, JSON.pretty_generate({ "now" => now_f, "retry_in" => retry_delays, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
