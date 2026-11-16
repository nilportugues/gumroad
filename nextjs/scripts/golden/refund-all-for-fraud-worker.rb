# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/refund-all-for-fraud-worker.golden.json: RefundAllForFraudWorker run by the real app
# against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). The purchase factory charges Stripe, so purchases are
# plain INSERTs of the columns the scope reads. Run it like refund-dispute-jobs.rb (USE_DB_WORKER_REPLICAS=true).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/refund-all-for-fraud-worker.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
CHARGEBACK_REVERSED = 512
TABLES = %w[users comments versions purchases].freeze

Rails.logger = ActiveSupport::Logger.new(nil)

def user_row(id, **overrides)
  {
    id:, email: "seller#{id}@example.com", username: "seller#{id}", external_id: (1000 + id).to_s, recommendation_type: "own_products",
    user_risk_state: "compliant", flags: 0, json_data: nil, confirmed_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT
  }.merge(overrides)
end

def purchase_row(id, **overrides)
  { id:, link_id: 1, seller_id: 1, purchase_state: "successful", price_cents: 100, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def run(name, args, seed: {})
  result = capture(name, now: NOW, tables: TABLES, seed:, sidekiq: true, job: "RefundAllForFraudWorker", args:) do
    RefundAllForFraudWorker.new.perform(*args)
  end
  # The replay answers from the recorded statements; the tables' final state is not compared.
  result.delete("rows")
  result
end

SELLER = user_row(1, user_risk_state: "suspended_for_fraud", name: "Seller Person")
ADMIN = user_row(2, name: "Admin Person")

def suspended(name, args: [1, 2], users: [SELLER, ADMIN], purchases: [])
  run(name, args, seed: { users:, purchases: })
end

cases = []
cases << run("no such user", [1, 2])
cases << run("a seller who is not suspended", [1, 2], seed: { users: [user_row(1)] })
cases << run("a seller suspended for a terms violation", [1, 2], seed: { users: [user_row(1, user_risk_state: "suspended_for_tos_violation"), ADMIN], purchases: [purchase_row(10)] })
cases << suspended("no sales still leaves a comment")
cases << suspended("one sale reads as a singular purchase", purchases: [purchase_row(10)])
cases << suspended("every successful sale that is not fully refunded or lost to a chargeback is queued",
                   purchases: [purchase_row(10), purchase_row(11, stripe_refunded: true), purchase_row(12, stripe_refunded: false),
                               purchase_row(13, purchase_state: "failed"), purchase_row(14, seller_id: 5),
                               purchase_row(15, chargeback_date: "2026-10-01 00:00:00"),
                               purchase_row(16, chargeback_date: "2026-10-01 00:00:00", flags: CHARGEBACK_REVERSED),
                               purchase_row(17, chargeback_date: "2026-10-01 00:00:00", flags: 1),
                               purchase_row(18, stripe_partially_refunded: true), purchase_row(19, flags: CHARGEBACK_REVERSED)])
cases << suspended("block_buyers true", args: [1, 2, true], purchases: [purchase_row(10), purchase_row(11)])
cases << suspended("block_buyers false given explicitly", args: [1, 2, false], purchases: [purchase_row(10)])
cases << suspended("block_buyers null", args: [1, 2, nil], purchases: [purchase_row(10)])
cases << suspended("block_buyers a string is truthy", args: [1, 2, "no"], purchases: [purchase_row(10)])
cases << suspended("an admin without a name is credited by username", users: [SELLER, user_row(2)], purchases: [purchase_row(10)])
cases << suspended("a missing admin fails after the refunds were queued", args: [1, 9], users: [SELLER], purchases: [purchase_row(10)])
cases << suspended("the ids arrive as strings", args: ["1", "2"], purchases: [purchase_row(10)])
cases << suspended("a seller who is also the admin", args: [1, 1], purchases: [purchase_row(10)])

now_f = travel_to(NOW, with_usec: true) { Time.now.to_f }
File.write(OUT, JSON.pretty_generate({ "now" => now_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
