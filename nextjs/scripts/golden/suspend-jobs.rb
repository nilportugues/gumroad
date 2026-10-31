# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/suspend-jobs.golden.json: the jobs that suspend
# sellers in bulk, run by the real app against a scratch database. Run it like user-writes.rb.
require_relative "support/rails_cases"
include RailsCases
capture_elasticsearch!

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/suspend-jobs.golden.json")
NOW = Time.utc(2025, 11, 1, 12, 30, 45, 123_000)
SEEDED_AT = "2025-01-01 00:00:00"
TABLES = %w[users comments versions seller_profiles links events platform_blocks custom_domains feature_announcement_newsletter_cutovers
            bank_accounts merchant_accounts active_storage_attachments affiliate_requests oauth_applications oauth_access_tokens
            oauth_device_authorizations balances scheduled_payouts].freeze

def user_row(id, **overrides)
  {
    id:, email: "seller#{id}@example.com", username: "seller#{id}", name: "Seller #{id}", external_id: (1000 + id).to_s,
    recommendation_type: "own_products", user_risk_state: "not_reviewed", flags: 0, json_data: nil, confirmed_at: SEEDED_AT,
    created_at: SEEDED_AT, updated_at: SEEDED_AT
  }.merge(overrides)
end

def bank_account(id, user_id, fingerprint, **overrides)
  { id:, user_id:, type: "AchAccount", stripe_fingerprint: fingerprint, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def balance(id, user_id, amount_cents, state: "unpaid")
  { id:, user_id:, date: "2025-10-01", amount_cents:, state:, currency: "usd", holding_currency: "usd", holding_amount_cents: amount_cents, created_at: SEEDED_AT, updated_at: SEEDED_AT }
end

VERIFIED = { verified: true }.freeze

def run(name, job, args, seed: {})
  capture(name, now: NOW, tables: TABLES, seed:, job:, args:) { job.constantize.new.perform(*args) }
end

cases = []

cascade = "SuspendAccountsWithPaymentAddressWorker"
cases << run("a missing user raises", cascade, [404])
cases << run("no payment address and no bank accounts", cascade, [5], seed: { users: [user_row(5, user_risk_state: "suspended_for_fraud")] })
# 7 is already suspended and 8 is verified, so its suspension halts and the job moves on.
cases << run("suspends every other seller with the payment address", cascade, [5], seed: {
  users: [
    user_row(5, user_risk_state: "suspended_for_fraud", payment_address: "shared@example.com"),
    user_row(6, payment_address: "shared@example.com"),
    user_row(7, user_risk_state: "suspended_for_tos_violation", payment_address: "shared@example.com"),
    user_row(8, payment_address: "shared@example.com", **VERIFIED),
    user_row(9, user_risk_state: "flagged_for_fraud", payment_address: "shared@example.com"),
    user_row(10, payment_address: "other@example.com"),
  ],
})
# 5's deleted account still counts; 7 only matches through a deleted account.
cases << run("suspends sellers sharing a bank account fingerprint", cascade, [5], seed: {
  users: [user_row(5, user_risk_state: "suspended_for_tos_violation"), user_row(6), user_row(7), user_row(8, user_risk_state: "suspended_for_fraud"), user_row(9)],
  bank_accounts: [
    bank_account(1, 5, "fp1"), bank_account(2, 5, "fp2", deleted_at: SEEDED_AT), bank_account(3, 5, ""),
    bank_account(4, 6, "fp9"), bank_account(5, 6, "fp2"), bank_account(6, 7, "fp1", deleted_at: SEEDED_AT),
    bank_account(7, 8, "fp1"), bank_account(8, 9, "fp1"), bank_account(9, 9, "fp2"),
  ],
})

mass = "SuspendUsersWorker"
cases << run("a missing author raises", mass, [404, ["5"], "spam", nil], seed: { users: [user_row(5)] })
# Ids match by id or external_id; 7 is already suspended and stays so; 8 is verified.
cases << run("suspends by id and external id with the reason and notes", mass, [3, ["5", "1006", "7", "8"], "spam", "see ticket"], seed: {
  users: [user_row(3, name: nil), user_row(5), user_row(6, user_risk_state: "flagged_for_fraud"), user_row(7, user_risk_state: "suspended_for_fraud"), user_row(8, **VERIFIED)],
})
cases << run("schedules a refund for each newly suspended seller with a balance", mass, [3, [5, 6, 7], "spam", "", { "action" => "refund", "delay_days" => "" }], seed: {
  users: [user_row(3), user_row(5), user_row(6), user_row(7, user_risk_state: "suspended_for_fraud")],
  balances: [balance(1, 5, 1500), balance(2, 5, 250), balance(3, 5, 900, state: "paid"), balance(4, 6, 0), balance(5, 7, 100)],
})
cases << run("a hold with a delay, and no payout without an action", mass, [3, [5], "spam", nil, { "action" => "hold", "delay_days" => 7 }], seed: {
  users: [user_row(3), user_row(5)],
  balances: [balance(1, 5, 1500)],
})
cases << run("a blank action schedules nothing", mass, [3, [5], "spam", nil, { "action" => "" }], seed: {
  users: [user_row(3), user_row(5)],
  balances: [balance(1, 5, 1500)],
})
cases << run("an in-progress scheduled payout fails the job after the suspension", mass, [3, [5, 6], "spam", nil, { "action" => "hold" }], seed: {
  users: [user_row(3), user_row(5), user_row(6)],
  balances: [balance(1, 5, 1500), balance(2, 6, 1500)],
  scheduled_payouts: [{ id: 1, user_id: 5, action: "refund", delay_days: 21, scheduled_at: SEEDED_AT, status: "flagged", payout_amount_cents: 100, created_at: SEEDED_AT, updated_at: SEEDED_AT }],
})

now_f = travel_to(NOW, with_usec: true) { Time.now.to_f }
File.write(OUT, JSON.pretty_generate({ "now" => now_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
