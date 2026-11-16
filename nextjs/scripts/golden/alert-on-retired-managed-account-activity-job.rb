# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/alert-on-retired-managed-account-activity-job.golden.json:
# AlertOnRetiredManagedAccountActivityJob run by the real app against a scratch database as a Sidekiq job
# (support/sidekiq_executor.rb). The alert is an InternalNotificationWorker push, visible in the scratch Redis.
# Run it like expiring-credit-card-message-worker.rb.
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/alert-on-retired-managed-account-activity-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
RETIRED_AT = "2026-11-01T10:00:00Z"
TABLES = %w[merchant_accounts balance_transactions charges balances].freeze

Rails.logger = ActiveSupport::Logger.new(nil)

def account_row(id = 1, **overrides) = { id:, user_id: 7, charge_processor_id: "stripe", charge_processor_merchant_id: "acct_#{id}", charge_processor_alive_at: nil, charge_processor_deleted_at: SEEDED_AT, deleted_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)

def bt_row(id, at, account: 1) = { id:, merchant_account_id: account, created_at: at, updated_at: at }

def charge_row(id, at, account: 1) = { id:, order_id: id, seller_id: 7, merchant_account_id: account, created_at: at, updated_at: at }

def balance_row(id, at, account: 1, user: 7, state: "unpaid", cents: 1250, currency: "usd") = { id:, user_id: user, merchant_account_id: account, state:, amount_cents: cents, currency:, date: "2026-11-02", created_at: at, updated_at: at }

def run(name, args, seed)
  result = capture(name, now: NOW, tables: TABLES, seed:, sidekiq: true, job: "AlertOnRetiredManagedAccountActivityJob", args:) do
    AlertOnRetiredManagedAccountActivityJob.new.perform(*args)
  end
  result.delete("seed")
  result
end

LATE = "2026-11-02 08:15:30"
cases = []
cases << run("an unknown merchant account", [99, RETIRED_AT], {})
cases << run("an account that is still active", [1, RETIRED_AT], { merchant_accounts: [account_row(deleted_at: nil, charge_processor_alive_at: SEEDED_AT, charge_processor_deleted_at: nil)], balance_transactions: [bt_row(1, LATE)] })
cases << run("an account that came back after a soft delete is still deleted", [1, RETIRED_AT], { merchant_accounts: [account_row(charge_processor_alive_at: SEEDED_AT, charge_processor_deleted_at: nil)], balance_transactions: [bt_row(1, LATE)] })
cases << run("an account dead on the processor", [1, RETIRED_AT], { merchant_accounts: [account_row(deleted_at: nil, charge_processor_alive_at: SEEDED_AT, charge_processor_deleted_at: SEEDED_AT)], balance_transactions: [bt_row(1, LATE)] })
cases << run("an account that never lived on the processor", [1, RETIRED_AT], { merchant_accounts: [account_row(deleted_at: nil, charge_processor_deleted_at: nil)], balance_transactions: [bt_row(1, LATE)] })
cases << run("nothing landed", [1, RETIRED_AT], { merchant_accounts: [account_row], balance_transactions: [bt_row(1, "2026-11-01 09:59:59")], charges: [charge_row(1, "2026-10-01 00:00:00")], balances: [balance_row(1, "2026-10-30 00:00:00")] })
cases << run("one balance transaction landed", [1, RETIRED_AT], { merchant_accounts: [account_row], balance_transactions: [bt_row(5, LATE)] })
cases << run("one charge landed", [1, RETIRED_AT], { merchant_accounts: [account_row], charges: [charge_row(5, LATE)] })
cases << run("one balance landed", [1, RETIRED_AT], { merchant_accounts: [account_row], balances: [balance_row(5, LATE)] })
cases << run("a balance in another currency and state", [1, RETIRED_AT], { merchant_accounts: [account_row], balances: [balance_row(5, LATE, state: "paid", cents: -300, currency: "eur")] })
cases << run("every leg landed", [1, RETIRED_AT], { merchant_accounts: [account_row], balance_transactions: [bt_row(2, LATE), bt_row(1, "2026-11-03 00:00:00")], charges: [charge_row(3, "2026-11-02 10:00:00")], balances: [balance_row(4, "2026-11-02 11:00:00")] })
cases << run("rows of other accounts and owners are left out", [1, RETIRED_AT], { merchant_accounts: [account_row, account_row(2)], balance_transactions: [bt_row(1, LATE, account: 2)], charges: [charge_row(1, LATE, account: 2)], balances: [balance_row(1, LATE, account: 2), balance_row(2, LATE, user: 8)] })
cases << run("an account without an owner skips the balance leg", [1, RETIRED_AT], { merchant_accounts: [account_row(user_id: nil)], balance_transactions: [bt_row(1, LATE)], balances: [balance_row(1, LATE, user: nil)] })
cases << run("a row at the very second of the retirement is reported", [1, RETIRED_AT], { merchant_accounts: [account_row], balance_transactions: [bt_row(1, "2026-11-01 10:00:00"), bt_row(2, "2026-11-01 09:59:59")] })
cases << run("a leg past the report cap is truncated", [1, RETIRED_AT], { merchant_accounts: [account_row], balance_transactions: (1..26).map { bt_row(_1, "2026-11-02 08:00:#{format("%02d", _1)}") } })
cases << run("exactly the report cap is not truncated", [1, RETIRED_AT], { merchant_accounts: [account_row], charges: (1..25).map { charge_row(_1, "2026-11-02 08:00:#{format("%02d", _1)}") } })
cases << run("every leg past the cap", [1, RETIRED_AT], { merchant_accounts: [account_row], balance_transactions: (1..26).map { bt_row(_1, "2026-11-02 08:00:#{format("%02d", _1)}") }, charges: (1..26).map { charge_row(_1, "2026-11-02 09:00:#{format("%02d", _1)}") }, balances: (1..26).map { balance_row(_1, "2026-11-02 10:00:#{format("%02d", _1)}") } })
cases << run("rows in the order of their creation", [1, RETIRED_AT], { merchant_accounts: [account_row], balance_transactions: [bt_row(1, "2026-11-03 00:00:00"), bt_row(2, "2026-11-02 00:00:00"), bt_row(3, "2026-11-02 00:00:00")] })
cases << run("the id given as a string", ["1", RETIRED_AT], { merchant_accounts: [account_row], balance_transactions: [bt_row(1, LATE)] })
cases << run("a retirement time with a fraction", [1, "2026-11-01T10:00:00.123456Z"], { merchant_accounts: [account_row], balance_transactions: [bt_row(1, LATE)], charges: [charge_row(1, "2026-11-01 10:00:00")] })
cases << run("a retirement time with an offset", [1, "2026-11-01T12:00:00+02:00"], { merchant_accounts: [account_row], balance_transactions: [bt_row(1, "2026-11-01 10:00:00"), bt_row(2, "2026-11-01 09:59:59")] })
cases << run("a retirement time with a short offset", [1, "2026-11-01T05:00:00-05"], { merchant_accounts: [account_row], balance_transactions: [bt_row(1, "2026-11-01 10:00:00")] })
cases << run("a retirement time without a zone", [1, "2026-11-01T10:00:00"], { merchant_accounts: [account_row], balance_transactions: [bt_row(1, LATE)] })
cases << run("a retirement date only is not accepted", [1, "2026-11-01"], { merchant_accounts: [account_row], balance_transactions: [bt_row(1, "2026-11-01 00:00:00"), bt_row(2, "2026-10-31 23:59:59")] })
cases << run("a retirement time with surrounding spaces and lowercase marks", [1, " 2026-11-01t10:00:00z "], { merchant_accounts: [account_row], balance_transactions: [bt_row(1, LATE)] })
cases << run("a retirement time that is not ISO 8601", [1, "yesterday"], { merchant_accounts: [account_row], balance_transactions: [bt_row(1, LATE)] })
cases << run("a retirement time that Ruby parses but is out of range", [1, "2026-13-01T10:00:00Z"], { merchant_accounts: [account_row], balance_transactions: [bt_row(1, LATE)] })
cases << run("an unknown account is checked before the time", [99, "yesterday"], {})
cases << run("an inactive account is checked before landed rows", [1, "yesterday"], { merchant_accounts: [account_row(deleted_at: nil, charge_processor_alive_at: SEEDED_AT, charge_processor_deleted_at: nil)] })

ACCOUNT_WITH_ROW = { merchant_accounts: [account_row], balance_transactions: [bt_row(1, LATE), bt_row(2, "2026-03-02 00:00:00")] }.freeze
[
  ["a day past the end of the month rolls over", "2026-02-30T00:00:00Z"],
  ["hour 24 rolls to the next day", "2026-03-01T24:00:00Z"],
  ["second 60 rolls to the next minute", "2026-03-01T23:59:60Z"],
  ["an offset without a colon", "2026-03-02T05:30:00+0530"],
  ["an offset with minutes and a colon", "2026-03-02T05:30:00+05:30"],
  ["a trailing newline", "2026-11-01T10:00:00Z\n"],
  ["a fraction without a zone", "2026-11-01T10:00:00.5"],
  ["a fraction of more than six digits", "2026-11-01T10:00:00.1234569Z"],
  ["month 0", "2026-00-10T00:00:00Z"],
  ["month 13", "2026-13-10T00:00:00Z"],
  ["day 0", "2026-01-00T00:00:00Z"],
  ["day 32", "2026-01-32T00:00:00Z"],
  ["minute 60", "2026-01-01T00:60:00Z"],
  ["second 61", "2026-01-01T00:00:61Z"],
  ["an offset of 24 hours", "2026-01-01T10:00:00+24"],
  ["an offset of 99:99", "2026-01-01T10:00:00+99:99"],
  ["a space in place of the T", "2026-01-01 10:00:00Z"],
  ["a comma as the decimal mark", "2026-01-01T10:00:00,5Z"],
  ["a one digit offset minute", "2026-01-01T10:00:00+05:3"],
  ["an empty string", ""]
].each do |label, value|
  cases << run("a retirement time: #{label}", [1, value], ACCOUNT_WITH_ROW)
end

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
