# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/export-payout-data.golden.json: ExportPayoutData run by the real app against a scratch
# database as a Sidekiq job (support/sidekiq_executor.rb). The payments read opens the job and a job that finds none returns before any
# mail. A job that finds a payment goes on to build the CSV (Exports::Payouts::Csv, a walk over balances, PayPal and Stripe Connect
# sales), zip it and deliver the mail with the file attached; those cases are recorded up to Csv.new, which a marker exception stands in
# for, and Node hands them back. Run it like fight-dispute-job.rb (env as in its header, with DATABASE_NAME=gumroad_test_wj10).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/export-payout-data.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[users payments].freeze

Rails.logger = ActiveSupport::Logger.new(nil)

class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

Exports::Payouts::Csv.prepend(Module.new do
  def initialize(*, **) = raise(HandBackMarker)
end)

def user_row(id, **overrides)
  { id:, email: "seller#{id}@example.com", username: "seller#{id}", external_id: (1000 + id).to_s, recommendation_type: "own_products",
    user_risk_state: "compliant", flags: 0, confirmed_at: nil, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def payment_row(id, user_id, **overrides)
  { id:, user_id:, state: "completed", flags: 0, amount_cents: 1000, currency: "usd", processor: "STRIPE", created_at: "2025-06-01 10:00:00",
    updated_at: "2025-06-01 10:00:00" }.merge(overrides)
end

def run(name, args, payments = [])
  hands_back = false
  result = capture(name, now: NOW, tables: TABLES, seed: { users: [user_row(1), user_row(2)], payments: }, sidekiq: true, job: "ExportPayoutData", args:) do
    ExportPayoutData.new.perform(*args)
  rescue HandBackMarker
    hands_back = true
  end
  result.delete("rows")
  result.delete("seed")
  result.merge("hands_back" => hands_back)
end

P = [payment_row(1, 1), payment_row(2, 1), payment_row(3, 2)].freeze

cases = []
cases << run("no payments at all", [[5], 1])
cases << run("an id that matches no payment", [[9], 1], P)
cases << run("several ids that match no payment", [[8, 9], 1], P)
cases << run("a single id as an integer that matches no payment", [9, 1], P)
cases << run("an empty list of ids", [[], 1], P)
cases << run("nil in place of the ids", [nil, 1], P)
cases << run("duplicate ids that match no payment", [[9, 9], 1], P)
cases << run("a payment of the seller", [[1], 1], P)
cases << run("a single id as an integer that matches a payment", [1, 1], P)
cases << run("two payments of the same seller", [[1, 2], 1], P)
cases << run("payments of two sellers", [[1, 3], 1], P)
cases << run("a payment and an id that matches none", [[1, 9], 2], P)
cases << run("ids as digit strings that match no payment", [%w[9], 1], P)
cases << run("ids as digit strings that match a payment", [%w[1], 1], P)
cases << run("a word in the ids", [["abc"], 1], P)
cases << run("a recipient that does not exist", [[9], 99], P)
cases << run("no arguments", [], P)
cases << run("one argument", [[9]], P)
cases << run("three arguments", [[9], 1, 2], P)

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
