# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/collect-unclaimed-balances-of-inactive-stripe-accounts-job.golden.json:
# CollectUnclaimedBalancesOfInactiveStripeAccountsJob run by the real app against a scratch database as a Sidekiq job
# (support/sidekiq_executor.rb). The scan of old US Stripe merchant accounts is the only work before the first account's reads, which
# lead to Stripe retrievals, a transfer and balance updates. Every account the scan returns reaches `merchant_account.user`, recorded up to
# there with a marker exception, and Node hands those back. Run it like pdf-unstampable-notifier-job.rb (env as in publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/collect-unclaimed-balances-of-inactive-stripe-accounts-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2020-01-01 00:00:00"
TABLES = %w[merchant_accounts].freeze

Rails.logger = ActiveSupport::Logger.new(nil)

class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

MerchantAccount.prepend(Module.new do
  def user = raise(HandBackMarker)
end)

def account_row(id, **overrides)
  { id:, user_id: id, charge_processor_id: "stripe", charge_processor_merchant_id: "acct_#{id}", country: "US", json_data: "{}",
    created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def run(name, accounts, args = [])
  hands_back = false
  result = capture(name, now: NOW, tables: TABLES, seed: { merchant_accounts: accounts }, sidekiq: true, job: "CollectUnclaimedBalancesOfInactiveStripeAccountsJob", args:) do
    CollectUnclaimedBalancesOfInactiveStripeAccountsJob.new.perform(*args)
  rescue HandBackMarker
    hands_back = true
  end
  result.delete("rows")
  result.delete("seed")
  result.merge("hands_back" => hands_back)
end

cases = []
cases << run("no merchant accounts", [])
cases << run("an old US Stripe account", [account_row(1)])
cases << run("an account created just before the cutoff", [account_row(1, created_at: "2023-11-04 12:30:45")])
cases << run("an account created at the cutoff", [account_row(1, created_at: "2023-11-04 12:30:45.123")])
cases << run("an account created just after the cutoff", [account_row(1, created_at: "2023-11-04 12:30:46")])
cases << run("an account created yesterday", [account_row(1, created_at: "2026-11-03 00:00:00")])
cases << run("an account outside the US", [account_row(1, country: "GB")])
cases << run("an account with no country", [account_row(1, country: nil)])
cases << run("an account with no Stripe id", [account_row(1, charge_processor_merchant_id: nil)])
cases << run("a Stripe Connect account", [account_row(1, json_data: '{"meta":{"stripe_connect":"true"}}')])
cases << run("an account that already collected", [account_row(1, json_data: '{"unclaimed_balance_collection_transfer_id":"tr_1"}')])
cases << run("an account with other json data", [account_row(1, json_data: '{"meta":{"other":"x"}}')])
cases << run("an account with no json data", [account_row(1, json_data: nil)])
cases << run("an account that is not Stripe", [account_row(1, charge_processor_id: "paypal")])
cases << run("an account that is deleted", [account_row(1, deleted_at: "2025-01-01 00:00:00")])
cases << run("an account with no creation time", [account_row(1, created_at: nil)])
cases << run("an eligible account among others", [account_row(1, country: "GB"), account_row(2), account_row(3), account_row(4, created_at: "2026-01-01 00:00:00")])
cases << run("accounts that are all ineligible", [account_row(1, country: "GB"), account_row(2, created_at: "2026-01-01 00:00:00")])
cases << run("an argument", [], [1])

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
