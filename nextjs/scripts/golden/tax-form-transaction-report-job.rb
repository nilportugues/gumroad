# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/tax-form-transaction-report-job.golden.json: TaxFormTransactionReportJob run by the real
# app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb), and the block of its sidekiq_retries_exhausted.
# Building the report pages through Stripe, which a marker exception stands in for (`reaches_report`); a tax form with no Stripe
# account id of its own falls back to the seller's own Stripe account (`node_hands_back`: Node hands those back after the tax form
# read). `notified` are the ErrorNotifier.notify calls. Run it like pdf-unstampable-notifier-job.rb (env as in
# publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/tax-form-transaction-report-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[users user_tax_forms merchant_accounts].freeze

Rails.logger = ActiveSupport::Logger.new(nil)

class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

Exports::TaxSummary::TransactionReport.singleton_class.prepend(Module.new do
  def new(*, **) = raise(HandBackMarker)
end)

$notified = []
ErrorNotifier.singleton_class.prepend(Module.new do
  def notify(*args, **kwargs)
    $notified << { "args" => args.map { _1.is_a?(Exception) ? { "class" => _1.class.name, "message" => _1.message } : _1 }, "kwargs" => kwargs }
  end
end)

def user_row(id, **overrides)
  { id:, email: "seller#{id}@example.com", username: "seller#{id}", external_id: (1000 + id).to_s, user_risk_state: "compliant", flags: 0, confirmed_at: nil, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def form_row(id, user: 1, year: 2025, type: "us_1099_k", account: "acct_1", json: :default)
  json = account.nil? ? nil : { stripe_account_id: account }.to_json if json == :default
  { id:, user_id: user, tax_year: year, tax_form_type: type, json_data: json, created_at: SEEDED_AT, updated_at: SEEDED_AT }
end

def merchant_row(id, user: 1, account: "acct_1", processor: "stripe", **overrides)
  { id:, user_id: user, charge_processor_id: processor, charge_processor_merchant_id: account, charge_processor_alive_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def run(name, args, users: [user_row(1)], forms: [], merchants: [])
  reaches_report = false
  result = capture(name, now: NOW, tables: TABLES, seed: { users:, user_tax_forms: forms, merchant_accounts: merchants }, sidekiq: true, job: "TaxFormTransactionReportJob", args:) do
    TaxFormTransactionReportJob.new.perform(*args)
  rescue HandBackMarker
    reaches_report = true
  end
  result.delete("rows")
  result.delete("seed")
  result.merge("reaches_report" => reaches_report)
end

def exhausted(name, args, error: StandardError.new("boom"))
  $notified = []
  result = capture(name, now: NOW, tables: [], sidekiq: true, job: "TaxFormTransactionReportJob", args:, hook: true) do
    TaxFormTransactionReportJob.sidekiq_retries_exhausted_block.call({ "args" => args }, error)
  end
  result.delete("seed")
  result.delete("rows")
  result.merge("notified" => $notified.dup)
end

cases = []
cases << run("a user that does not exist", [9, 2025])
cases << run("a user id of nil", [nil, 2025])
cases << run("a user id as a digit string", ["1", 2025], forms: [form_row(1)], merchants: [merchant_row(1)])
cases << run("a user id as a float", [1.0, 2025])
cases << run("a user id as a word", ["one", 2025])
cases << run("a user without a tax form", [1, 2025])
cases << run("a tax form of another year", [1, 2025], forms: [form_row(1, year: 2024)])
cases << run("a tax form of another type", [1, 2025], forms: [form_row(1, type: "us_1099_misc")])
cases << run("a tax form of another user", [1, 2025], users: [user_row(1), user_row(2)], forms: [form_row(1, user: 2)])
cases << run("a year as a digit string", [1, "2025"], forms: [form_row(1)], merchants: [merchant_row(1)])
cases << run("a year of nil", [1, nil], forms: [form_row(1)], merchants: [merchant_row(1)])
cases << run("a year as a float", [1, 2025.0], forms: [form_row(1)], merchants: [merchant_row(1)])
cases << run("a year as a word", [1, "abc"], forms: [form_row(1)], merchants: [merchant_row(1)])
cases << run("a tax form with a connected account", [1, 2025], forms: [form_row(1)], merchants: [merchant_row(1)])
cases << run("a tax form with a connected account among others", [1, 2025], users: [user_row(1), user_row(2)], forms: [form_row(1), form_row(2, user: 2, year: 2024), form_row(3, user: 2)], merchants: [merchant_row(1, account: "acct_x"), merchant_row(2), merchant_row(3, user: 2)])
cases << run("a tax form whose account is not a merchant account", [1, 2025], forms: [form_row(1)])
cases << run("a tax form whose account belongs to another user", [1, 2025], users: [user_row(1), user_row(2)], forms: [form_row(1)], merchants: [merchant_row(1, user: 2)])
cases << run("a tax form whose account is deleted", [1, 2025], forms: [form_row(1)], merchants: [merchant_row(1, deleted_at: SEEDED_AT)])
cases << run("a tax form whose account is deleted at the processor", [1, 2025], forms: [form_row(1)], merchants: [merchant_row(1, charge_processor_deleted_at: SEEDED_AT)])
cases << run("a tax form whose account is not alive at the processor", [1, 2025], forms: [form_row(1)], merchants: [merchant_row(1, charge_processor_alive_at: nil)])
cases << run("a tax form whose account is another processor's", [1, 2025], forms: [form_row(1)], merchants: [merchant_row(1, processor: "paypal")])
cases << run("a tax form with a blank account id", [1, 2025], forms: [form_row(1, account: "")], merchants: [merchant_row(1)]).merge("node_hands_back" => true)
cases << run("a tax form with a whitespace account id", [1, 2025], forms: [form_row(1, account: "  ")], merchants: [merchant_row(1)]).merge("node_hands_back" => true)
cases << run("a tax form with an empty json_data", [1, 2025], forms: [form_row(1, json: "{}")], merchants: [merchant_row(1)]).merge("node_hands_back" => true)
cases << run("a tax form without json_data", [1, 2025], forms: [form_row(1, account: nil)], merchants: [merchant_row(1)]).merge("node_hands_back" => true)
cases << run("a tax form without json_data or a merchant account", [1, 2025], forms: [form_row(1, account: nil)]).merge("node_hands_back" => true)
cases << run("a tax form with a json_data account id of nil", [1, 2025], forms: [form_row(1, json: '{"stripe_account_id":null}')], merchants: [merchant_row(1)]).merge("node_hands_back" => true)
cases << run("a tax form with a json_data account id that is a number", [1, 2025], forms: [form_row(1, json: '{"stripe_account_id":5}')], merchants: [merchant_row(1, account: "5")]).merge("node_hands_back" => true)
cases << run("two arguments past the second", [1, 2025, 3], forms: [form_row(1)], merchants: [merchant_row(1)])
cases << run("one argument", [1], forms: [form_row(1)], merchants: [merchant_row(1)])

cases << exhausted("retries exhausted", [1, 2025])
cases << exhausted("retries exhausted with no arguments", [])
cases << exhausted("retries exhausted with one argument", [7])
cases << exhausted("retries exhausted with nil arguments", [nil, nil])
cases << exhausted("retries exhausted with string arguments", ["1", "2025", "extra"])
cases << exhausted("retries exhausted with an ArgumentError", [1, 2025], error: ArgumentError.new("bad year"))

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
