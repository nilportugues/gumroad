# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/payout-note-retries-exhausted-jobs.golden.json: the sidekiq_retries_exhausted blocks of
# HandleNewBankAccountWorker and DeleteGuardianStripePersonJob, and the part of HandleNewBankAccountWorker#perform Node runs, run by
# the real app against a scratch database as Sidekiq jobs (support/sidekiq_executor.rb). Both blocks write a seller-invisible payout
# note (`User#add_payout_note`) and report through ErrorNotifier (`notified`). perform reaches StripeMerchantAccountManager once the
# bank account is found, which a marker exception stands in for (`reaches_stripe`). Run it like pdf-unstampable-notifier-job.rb (env
# as in publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/payout-note-retries-exhausted-jobs.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[users bank_accounts comments versions].freeze

Rails.logger = ActiveSupport::Logger.new(nil)

class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

StripeMerchantAccountManager.singleton_class.prepend(Module.new do
  def handle_new_bank_account(*, **) = raise(HandBackMarker)
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

def bank_row(id, user: 1, **overrides)
  { id:, user_id: user, type: "AchAccount", created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def finish(result)
  result.delete("seed")
  result.delete("rows")
  result
end

def perform(name, args, banks: [])
  reaches_stripe = false
  result = capture(name, now: NOW, tables: TABLES, seed: { users: [user_row(1)], bank_accounts: banks }, sidekiq: true, job: "HandleNewBankAccountWorker", args:) do
    HandleNewBankAccountWorker.new.perform(*args)
  rescue HandBackMarker
    reaches_stripe = true
  end
  finish(result).merge("reaches_stripe" => reaches_stripe)
end

def exhausted(klass, name, args, users: [user_row(1)], banks: [bank_row(7)], error: StandardError.new("boom"))
  $notified = []
  result = capture(name, now: NOW, tables: TABLES, seed: { users:, bank_accounts: banks }, sidekiq: true, job: klass.name, args:, hook: true) do
    klass.sidekiq_retries_exhausted_block.call({ "args" => args }, error)
  end
  finish(result).merge("notified" => $notified.dup, "job" => klass.name, "exception_message" => error.message)
end

cases = []
cases << perform("a bank account that does not exist", [9])
cases << perform("a bank account id of nil", [nil])
cases << perform("a bank account id as a digit string", ["7"], banks: [bank_row(7)])
cases << perform("a bank account id as a float", [7.0], banks: [bank_row(7)])
cases << perform("a bank account id as a word", ["seven"], banks: [bank_row(7)])
cases << perform("a bank account", [7], banks: [bank_row(7)])
cases << perform("a bank account among others", [8], banks: [bank_row(7), bank_row(8), bank_row(9)])
cases << perform("a bank account with the holder name flag", [7, true], banks: [bank_row(7)])
cases << perform("a bank account with a false holder name flag", [7, false], banks: [bank_row(7)])
cases << perform("a deleted bank account", [7], banks: [bank_row(7, deleted_at: SEEDED_AT)])
cases << perform("no arguments", [], banks: [bank_row(7)])
cases << perform("three arguments", [7, true, 1], banks: [bank_row(7)])

bank = HandleNewBankAccountWorker
cases << exhausted(bank, "bank account exhausted", [7])
cases << exhausted(bank, "bank account exhausted with the holder name flag", [7, true])
cases << exhausted(bank, "bank account exhausted with a false holder name flag", [7, false])
cases << exhausted(bank, "bank account exhausted with a nil holder name flag", [7, nil])
cases << exhausted(bank, "bank account exhausted with a string holder name flag", [7, "no"])
cases << exhausted(bank, "bank account exhausted with a digit string id", ["7"])
cases << exhausted(bank, "bank account exhausted for a bank account that does not exist", [9])
cases << exhausted(bank, "bank account exhausted with an id of nil", [nil])
cases << exhausted(bank, "bank account exhausted for a bank account without a user", [7], banks: [bank_row(7, user: nil)])
cases << exhausted(bank, "bank account exhausted for a user that does not exist", [7], banks: [bank_row(7, user: 5)])
cases << exhausted(bank, "bank account exhausted for a deleted bank account", [7], banks: [bank_row(7, deleted_at: SEEDED_AT)])
cases << exhausted(bank, "bank account exhausted for a deleted user", [7], users: [user_row(1, deleted_at: SEEDED_AT)])
cases << exhausted(bank, "bank account exhausted among other accounts", [8], users: [user_row(1), user_row(2)], banks: [bank_row(7), bank_row(8, user: 2)])

guardian = DeleteGuardianStripePersonJob
cases << exhausted(guardian, "guardian exhausted", ["person_1", "acct_1", 1])
cases << exhausted(guardian, "guardian exhausted for a user that does not exist", ["person_1", "acct_1", 9])
cases << exhausted(guardian, "guardian exhausted with a user id of nil", ["person_1", "acct_1", nil])
cases << exhausted(guardian, "guardian exhausted with a digit string user id", ["person_1", "acct_1", "1"])
cases << exhausted(guardian, "guardian exhausted with a float user id", ["person_1", "acct_1", 1.0])
cases << exhausted(guardian, "guardian exhausted with a word user id", ["person_1", "acct_1", "one"])
cases << exhausted(guardian, "guardian exhausted with nil ids", [nil, nil, 1])
cases << exhausted(guardian, "guardian exhausted with a quote and a newline", ["per\"son\n1", "acct_'1", 1])
cases << exhausted(guardian, "guardian exhausted with two arguments", ["person_1", "acct_1"])
cases << exhausted(guardian, "guardian exhausted with no arguments", [])
cases << exhausted(guardian, "guardian exhausted for a deleted user", ["person_1", "acct_1", 1], users: [user_row(1, deleted_at: SEEDED_AT)])
cases << exhausted(guardian, "guardian exhausted with a Stripe error", ["person_1", "acct_1", 1], error: RuntimeError.new("Stripe is down"))

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
