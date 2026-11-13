# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/finalize-buyer-presentment-charge-job.golden.json: FinalizeBuyerPresentmentChargeJob run by
# the real app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). A charge that defers settlement means reading
# its purchases and syncing them with Stripe; those cases are recorded up to `Charge#purchases`, which a marker exception stands in for.
# Run it like publish-scheduled-post.rb:
#
#   bundle exec rails runner nextjs/scripts/golden/finalize-buyer-presentment-charge-job.rb   (env as in publish-scheduled-post.rb)
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/finalize-buyer-presentment-charge-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[charges charge_presentments merchant_accounts].freeze

Rails.logger = ActiveSupport::Logger.new(nil)

class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

Charge.prepend(Module.new do
  def purchases = raise(HandBackMarker)
end)

def charge_row(id, **overrides) = { id:, order_id: id, seller_id: 7, merchant_account_id: nil, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)

def account_row(id, user_id) = { id:, user_id:, charge_processor_id: "stripe", charge_processor_merchant_id: "acct_#{id}", created_at: SEEDED_AT, updated_at: SEEDED_AT }

def presentment_row(id, charge_id) = { id:, charge_id:, processor: "stripe", presentment_currency: "eur", presentment_total_cents: 1000, presentment_gumroad_amount_cents: 100, created_at: SEEDED_AT, updated_at: SEEDED_AT }

def run(name, args, seed)
  hands_back = false
  result = capture(name, now: NOW, tables: TABLES, seed:, sidekiq: true, job: "FinalizeBuyerPresentmentChargeJob", args:) do
    FinalizeBuyerPresentmentChargeJob.new.perform(*args)
  rescue HandBackMarker
    hands_back = true
  end
  result.delete("rows")
  result.delete("seed")
  result.merge("hands_back" => hands_back)
end

cases = []
cases << run("a charge that does not exist", [9], {})
cases << run("a charge held by a Gumroad account without a presentment", [1], { charges: [charge_row(1, merchant_account_id: 3)], merchant_accounts: [account_row(3, nil)] })
cases << run("the same with an attempt", [1, 2], { charges: [charge_row(1, merchant_account_id: 3)], merchant_accounts: [account_row(3, nil)] })
cases << run("a charge with a presentment on a Gumroad account", [1], { charges: [charge_row(1, merchant_account_id: 3)], merchant_accounts: [account_row(3, nil)], charge_presentments: [presentment_row(1, 1)] })
cases << run("a charge of a seller's account", [1], { charges: [charge_row(1, merchant_account_id: 3)], merchant_accounts: [account_row(3, 7)] })
cases << run("a charge with no merchant account", [1], { charges: [charge_row(1)] })
cases << run("a charge whose merchant account row is gone", [1], { charges: [charge_row(1, merchant_account_id: 4)] })
cases << run("a presentment of another charge", [1], { charges: [charge_row(1, merchant_account_id: 3)], merchant_accounts: [account_row(3, nil)], charge_presentments: [presentment_row(1, 2)] })
cases << run("a charge id as a digit string", ["1"], { charges: [charge_row(1, merchant_account_id: 3)], merchant_accounts: [account_row(3, nil)] })
cases << run("a charge id of nil", [nil], {})
cases << run("a charge id as a float", [1.0], {})
cases << run("a charge id as a word", ["one"], {})

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
