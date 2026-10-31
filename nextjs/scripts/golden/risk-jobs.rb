# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/risk-jobs.golden.json: the jobs that read and move a
# seller's risk state, run by the real app against a scratch database. Run it like user-writes.rb.
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/risk-jobs.golden.json")
NOW = Time.utc(2025, 8, 31, 12, 30, 45, 123_000)
SEEDED_AT = "2025-01-01 00:00:00"
TABLES = %w[users comments versions seller_profiles links events social_connect_verifications platform_blocks
            feature_announcement_newsletter_cutovers bank_accounts active_storage_attachments affiliate_requests].freeze

def user_row(id, **overrides)
  {
    id:, email: "seller#{id}@example.com", username: "seller#{id}", external_id: (1000 + id).to_s, recommendation_type: "own_products",
    user_risk_state: "compliant", flags: 0, json_data: nil, confirmed_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT
  }.merge(overrides)
end

def bank_account(id, user_id, fingerprint, **overrides)
  { id:, user_id:, type: "AchAccount", stripe_fingerprint: fingerprint, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def block(id, type, value, **overrides)
  { id:, object_type: type, object_value: value, blocked_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def run(name, job, args, seed: {})
  capture(name, now: NOW, tables: TABLES, seed:, job:, args:) { job.constantize.new.perform(*args) }
end

cases = []

check = "CheckPaymentAddressWorker"
cases << run("a missing user", check, [404])
cases << run("a seller who cannot be flagged", check, [5], seed: { users: [user_row(5, user_risk_state: "suspended_for_fraud", payment_address: "a@example.com")] })
cases << run("no payment address and no bank accounts", check, [5], seed: { users: [user_row(5)] })
cases << run("a payment address shared with a suspended seller", check, [5], seed: {
  users: [user_row(5, payment_address: "shared@example.com"), user_row(6, user_risk_state: "suspended_for_tos_violation", payment_address: "shared@example.com")],
})
cases << run("a payment address that is blocked", check, [5], seed: {
  users: [user_row(5, user_risk_state: "not_reviewed", payment_address: "blocked@example.com")],
  platform_blocks: [block(1, "email", "blocked@example.com")],
})
cases << run("a payment address whose block expired", check, [5], seed: {
  users: [user_row(5, payment_address: "blocked@example.com")],
  platform_blocks: [block(1, "email", "blocked@example.com", expires_at: "2025-02-01 00:00:00")],
})
cases << run("a bank account shared with a suspended seller", check, [5], seed: {
  users: [user_row(5), user_row(6, user_risk_state: "suspended_for_fraud")],
  bank_accounts: [bank_account(1, 5, "fp1"), bank_account(2, 5, ""), bank_account(3, 5, "fp2", deleted_at: SEEDED_AT), bank_account(4, 6, "fp1")],
})
cases << run("bank accounts whose fingerprints are blocked", check, [5], seed: {
  users: [user_row(5)],
  bank_accounts: [bank_account(1, 5, "fp1"), bank_account(2, 5, "fp2")],
  platform_blocks: [block(1, "charge_processor_fingerprint", "fp2")],
})
cases << run("bank accounts with nothing against them", check, [5], seed: {
  users: [user_row(5, payment_address: "clean@example.com"), user_row(6, payment_address: "clean@example.com")],
  bank_accounts: [bank_account(1, 5, "fp1"), bank_account(2, 6, "fp1")],
})

ip = "BlockSuspendedAccountIpWorker"
cases << run("a missing user raises", ip, [404])
cases << run("no sign-in IP", ip, [5], seed: { users: [user_row(5, user_risk_state: "suspended_for_fraud")] })
cases << run("a compliant seller shares the IP", ip, [5], seed: {
  users: [user_row(5, user_risk_state: "suspended_for_fraud", last_sign_in_ip: "10.0.0.1"), user_row(6, account_created_ip: "10.0.0.1")],
})
cases << run("blocks the IP for six calendar months", ip, [5], seed: {
  users: [user_row(5, user_risk_state: "suspended_for_fraud", last_sign_in_ip: "10.0.0.1"), user_row(6, user_risk_state: "not_reviewed", current_sign_in_ip: "10.0.0.1")],
})
cases << run("renews an existing IP block", ip, [5], seed: {
  users: [user_row(5, user_risk_state: "suspended_for_fraud", last_sign_in_ip: "10.0.0.1")],
  platform_blocks: [block(3, "ip_address", "10.0.0.1", blocked_at: nil, blocked_by: 9)],
})

now_f = travel_to(NOW, with_usec: true) { Time.now.to_f }
File.write(OUT, JSON.pretty_generate({ "now" => now_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
