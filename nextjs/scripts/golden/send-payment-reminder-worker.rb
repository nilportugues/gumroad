# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/send-payment-reminder-worker.golden.json: SendPaymentReminderWorker run by the real app
# against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). The mails are deliver_later pushes, visible in the scratch
# Redis. Run it like expiring-credit-card-message-worker.rb.
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/send-payment-reminder-worker.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[users balances bank_accounts merchant_accounts].freeze
ANNOUNCEMENT_FLAG = User.flag_mapping["flags"][:announcement_notification_enabled]

Rails.logger = ActiveSupport::Logger.new(nil)
ActiveJob::Base.queue_adapter = :sidekiq
ActiveJob::Base.logger = Logger.new(nil)
$uuid_seq = 0
SecureRandom.singleton_class.prepend(Module.new do
  def uuid = format("00000000-0000-4000-8000-%012x", ($uuid_seq += 1))
end)

def user_row(id, **overrides) = { id:, email: "user#{id}@example.com", username: "user#{id}", external_id: (1000 + id).to_s, user_risk_state: "compliant", flags: ANNOUNCEMENT_FLAG, confirmed_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)

def balance_row(id, user:, cents: 1500, state: "unpaid") = { id:, user_id: user, amount_cents: cents, state:, date: "2026-10-01", created_at: SEEDED_AT, updated_at: SEEDED_AT }

def bank_row(id, user:, **overrides) = { id:, user_id: user, type: "AchAccount", created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)

def merchant_row(id, user:, processor: "stripe", **overrides) = { id:, user_id: user, charge_processor_id: processor, charge_processor_merchant_id: "acct_#{id}", charge_processor_alive_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)

def connect_json = { meta: { stripe_connect: "true" } }.to_json

def run(name, seed)
  $uuid_seq = 0
  result = capture(name, now: NOW, tables: TABLES, seed:, sidekiq: true, job: "SendPaymentReminderWorker", args: [], at: NOW.to_f) do
    SendPaymentReminderWorker.new.perform
  end
  result.delete("seed")
  result
end

OWED = { users: [user_row(1)], balances: [balance_row(1, user: 1)] }.freeze
cases = []
cases << run("no users", {})
cases << run("a seller holding more than 10 dollars with nothing set up", OWED)
cases << run("a balance of exactly 1000 cents is left alone", { users: [user_row(1)], balances: [balance_row(1, user: 1, cents: 1000)] })
cases << run("a balance of 1001 cents is mailed", { users: [user_row(1)], balances: [balance_row(1, user: 1, cents: 1001)] })
cases << run("balances add up across rows", { users: [user_row(1)], balances: [balance_row(1, user: 1, cents: 600), balance_row(2, user: 1, cents: 600)] })
cases << run("paid balances do not count", { users: [user_row(1)], balances: [balance_row(1, user: 1, cents: 1500, state: "paid"), balance_row(2, user: 1, cents: 500)] })
cases << run("a negative balance offsets another", { users: [user_row(1)], balances: [balance_row(1, user: 1, cents: 1500), balance_row(2, user: 1, cents: -600)] })
cases << run("a seller who turned announcements off", { users: [user_row(1, flags: 0)], balances: [balance_row(1, user: 1)] })
cases << run("a seller with a payment address", { users: [user_row(1, payment_address: "paypal@example.com")], balances: [balance_row(1, user: 1)] })
cases << run("a seller with a bank account", { users: [user_row(1)], balances: [balance_row(1, user: 1)], bank_accounts: [bank_row(1, user: 1)] })
cases << run("a seller whose bank account was deleted", { users: [user_row(1)], balances: [balance_row(1, user: 1)], bank_accounts: [bank_row(1, user: 1, deleted_at: SEEDED_AT)] })
cases << run("a seller with a Stripe Connect account", { users: [user_row(1)], balances: [balance_row(1, user: 1)], merchant_accounts: [merchant_row(1, user: 1, json_data: connect_json)] })
cases << run("a seller with a Gumroad-managed Stripe account", { users: [user_row(1)], balances: [balance_row(1, user: 1)], merchant_accounts: [merchant_row(1, user: 1, json_data: { meta: {} }.to_json)] })
cases << run("a seller with a PayPal account", { users: [user_row(1)], balances: [balance_row(1, user: 1)], merchant_accounts: [merchant_row(1, user: 1, processor: "paypal")] })
cases << run("a seller whose PayPal account is not alive", { users: [user_row(1)], balances: [balance_row(1, user: 1)], merchant_accounts: [merchant_row(1, user: 1, processor: "paypal", charge_processor_alive_at: nil)] })
cases << run("a seller whose PayPal account was deleted", { users: [user_row(1)], balances: [balance_row(1, user: 1)], merchant_accounts: [merchant_row(1, user: 1, processor: "paypal", deleted_at: SEEDED_AT)] })
cases << run("a seller whose Connect account is dead on the processor", { users: [user_row(1)], balances: [balance_row(1, user: 1)], merchant_accounts: [merchant_row(1, user: 1, json_data: connect_json, charge_processor_deleted_at: SEEDED_AT)] })
cases << run("a merchant account with empty json_data", { users: [user_row(1)], balances: [balance_row(1, user: 1)], merchant_accounts: [merchant_row(1, user: 1, json_data: "")] })
cases << run("a merchant account whose json_data is not a hash", { users: [user_row(1)], balances: [balance_row(1, user: 1)], merchant_accounts: [merchant_row(1, user: 1, json_data: "[1]")] })
cases << run("a seller without any email", { users: [user_row(1, email: nil)], balances: [balance_row(1, user: 1)] })
cases << run("a seller whose pending email stands in", { users: [user_row(1, email: nil, unconfirmed_email: "new@example.com")], balances: [balance_row(1, user: 1)] })
cases << run("a seller with blank emails", { users: [user_row(1, email: "", unconfirmed_email: "")], balances: [balance_row(1, user: 1)] })
cases << run("every risk state", { users: %w[compliant not_reviewed flagged_for_tos_violation on_probation suspended_for_fraud suspended_for_tos_violation].each_with_index.map { |state, i| user_row(i + 1, user_risk_state: state) }, balances: (1..6).map { balance_row(_1, user: _1) } })
cases << run("several sellers, one with setup", { users: [user_row(1), user_row(2), user_row(3)], balances: [balance_row(1, user: 1), balance_row(2, user: 2), balance_row(3, user: 3)], bank_accounts: [bank_row(1, user: 2)] })
cases << run("more sellers than one batch", { users: (1..1001).map { user_row(_1) }, balances: (1..1001).map { balance_row(_1, user: _1) } })

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
