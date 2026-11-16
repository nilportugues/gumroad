# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/refresh-merchant-account-payment-method-availability-worker.golden.json:
# RefreshMerchantAccountPaymentMethodAvailabilityWorker run by the real app against a scratch database as a Sidekiq job
# (support/sidekiq_executor.rb). StripeConnectPaymentMethodAvailabilityService#refresh! (a Stripe capabilities read and the snapshot write) is
# replaced by a recorder, so nothing leaves the machine; the golden keeps the merchant account ids it was asked to refresh under
# `processed`. Run it like publish-scheduled-post.rb (env in its header).
require_relative "support/rails_cases"
include RailsCases
capture_http!

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/refresh-merchant-account-payment-method-availability-worker.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[merchant_accounts].freeze

Rails.logger = ActiveSupport::Logger.new(nil)

$processed = []
StripeConnectPaymentMethodAvailabilityService.prepend(Module.new do
  define_method(:refresh!) { $processed << @merchant_account.id; nil }
end)

CONNECT = '{"meta":{"stripe_connect":"true"}}'

def account_row(id, **overrides)
  { id:, user_id: 5, charge_processor_id: "stripe", charge_processor_merchant_id: "acct_#{id}", charge_processor_alive_at: SEEDED_AT, json_data: CONNECT,
    country: "US", currency: "usd", created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def run(name, args, rows)
  $processed = []
  result = capture(name, now: NOW, tables: TABLES, seed: { merchant_accounts: rows }, sidekiq: true, job: "RefreshMerchantAccountPaymentMethodAvailabilityWorker", args:) do
    RefreshMerchantAccountPaymentMethodAvailabilityWorker.new.perform(*args)
  end
  result.delete("seed")
  result.delete("rows")
  result.merge("processed" => $processed.dup)
end

cases = []
cases << run("an account that does not exist", [99], [])
cases << run("an account id of nil", [nil], [account_row(1)])
cases << run("a connect account", [1], [account_row(1)])
cases << run("an account id given as a digit string", ["1"], [account_row(1)])
cases << run("an account id given as a float", [1.0], [account_row(1)])
cases << run("an account id given as a word", ["abc"], [account_row(1)])
cases << run("a deleted account", [1], [account_row(1, deleted_at: SEEDED_AT)])
cases << run("an account whose processor never came alive", [1], [account_row(1, charge_processor_alive_at: nil)])
cases << run("an account whose processor was deleted", [1], [account_row(1, charge_processor_deleted_at: SEEDED_AT)])
cases << run("an account whose processor is deleted and never alive", [1], [account_row(1, charge_processor_alive_at: nil, charge_processor_deleted_at: SEEDED_AT)])
cases << run("an account of another processor", [1], [account_row(1, charge_processor_id: "paypal")])
cases << run("a stripe account of no seller", [1], [account_row(1, user_id: nil)])
cases << run("a stripe account managed by gumroad (no json data)", [1], [account_row(1, json_data: nil)])
cases << run("a stripe account with blank json data", [1], [account_row(1, json_data: "")])
cases << run("a stripe account with an empty hash", [1], [account_row(1, json_data: "{}")])
cases << run("a stripe account whose connect flag is false", [1], [account_row(1, json_data: '{"meta":{"stripe_connect":"false"}}')])
cases << run("a stripe account whose connect flag is a boolean", [1], [account_row(1, json_data: '{"meta":{"stripe_connect":true}}')])
cases << run("a stripe account with meta of null", [1], [account_row(1, json_data: '{"meta":null}')])
cases << run("a stripe account with other meta", [1], [account_row(1, json_data: '{"meta":{"x":"y"}}')])
cases << run("a stripe account with json data that is an array", [1], [account_row(1, json_data: "[]")])
cases << run("a stripe account with meta that is a string", [1], [account_row(1, json_data: '{"meta":"x"}')])
cases << run("another account is a connect account", [2], [account_row(1), account_row(2, json_data: nil)])

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
