# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/refund-payout-guard-jobs.golden.json: the guards of RefundPurchaseWorker,
# FightDisputeJob, PayoutUsersWorker and UpdateUserBalanceStatsCacheWorker, run by the real app against a scratch database,
# each case as a Sidekiq job (support/sidekiq_executor.rb). Past its guards each of these jobs refunds, forwards evidence to
# the processor, creates payments or aggregates a payout period, which Node hands back to Rails; those cases are recorded up
# to the call a marker exception stands in for. Run it like publish-scheduled-post.rb:
#
#   bundle exec rails runner nextjs/scripts/golden/refund-payout-guard-jobs.rb   (env as in publish-scheduled-post.rb)
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/refund-payout-guard-jobs.golden.json")
# A Wednesday, so the weekend extension of an evidence window can be told apart.
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[users purchases disputes dispute_evidences].freeze

Stripe.api_base = "http://127.0.0.1:9"
Stripe.max_network_retries = 0
Rails.logger = ActiveSupport::Logger.new(nil)

# Stands in for the first write / processor call of a job Node hands back.
class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

Purchase.prepend(Module.new do
  def refund_and_save!(*, **) = raise(HandBackMarker)
  def refund_for_fraud_and_block_buyer!(*) = raise(HandBackMarker)
end)
Dispute.prepend(Module.new do
  def disputable = raise(HandBackMarker)
end)
PayoutUsersService.prepend(Module.new do
  def create_payments = user_ids.empty? ? super : raise(HandBackMarker)
end)
UserBalanceStatsService.prepend(Module.new do
  def write_cache = raise(HandBackMarker)
end)

def user_row(id, **overrides)
  { id:, email: "seller#{id}@example.com", username: "seller#{id}", external_id: (1000 + id).to_s, recommendation_type: "own_products",
    user_risk_state: "compliant", flags: 0, json_data: nil, confirmed_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def purchase_row(id, **overrides)
  { id:, link_id: 1, seller_id: 1, purchase_state: "successful", price_cents: 100, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def dispute_row(id, **overrides)
  { id:, purchase_id: 1, state: "formalized", seller_id: 1, event_created_at: "2026-10-20 00:00:00", created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def evidence_row(id, dispute_id, **overrides)
  { id:, dispute_id:, created_at: SEEDED_AT, updated_at: SEEDED_AT, resolution: "unknown" }.merge(overrides)
end

# `hands_back`: the real job went on to something Node does not do, which the marker stood in for.
def run(name, job, args, seed: {})
  hands_back = false
  result = capture(name, now: NOW, tables: TABLES, seed:, sidekiq: true, job:, args:) do
    job.constantize.new.perform(*args)
  rescue HandBackMarker
    hands_back = true
  end
  result.delete("rows")
  result.delete("seed")
  result.merge("hands_back" => hands_back)
end

cases = []

refund = ->(name, args, **seed) { cases << run(name, "RefundPurchaseWorker", args, seed:) }
refund.call("refund: the purchase does not exist", [99, 1])
refund.call("refund: a purchase", [1, 1], users: [user_row(1)], purchases: [purchase_row(1)])
refund.call("refund: a purchase for fraud", [1, 1, Refund::FRAUD], users: [user_row(1)], purchases: [purchase_row(1)])
refund.call("refund: a purchase with a reason", [1, 1, "Requested by the buyer"], users: [user_row(1)], purchases: [purchase_row(1)])
refund.call("refund: the id as digits", ["1", 1], users: [user_row(1)], purchases: [purchase_row(1)])

fight = ->(name, args, **seed) { cases << run(name, "FightDisputeJob", args, seed:) }
fight.call("fight: the dispute does not exist", [99])
fight.call("fight: a dispute without evidence", [1], disputes: [dispute_row(1)])
fight.call("fight: evidence already resolved", [1], disputes: [dispute_row(1)], dispute_evidences: [evidence_row(1, 1, seller_contacted_at: "2026-10-28 09:00:00", resolved_at: "2026-10-30 00:00:00")])
fight.call("fight: the window is still open", [1], disputes: [dispute_row(1)], dispute_evidences: [evidence_row(1, 1, seller_contacted_at: "2026-11-03 09:00:00")])
fight.call("fight: a Saturday window is extended over the weekend and still open", [1], disputes: [dispute_row(1)], dispute_evidences: [evidence_row(1, 1, seller_contacted_at: "2026-10-31 14:00:00")])
fight.call("fight: a Friday window closed after its weekend extension", [1], disputes: [dispute_row(1)], dispute_evidences: [evidence_row(1, 1, seller_contacted_at: "2026-10-30 12:00:00")])
fight.call("fight: the window closed", [1], disputes: [dispute_row(1)], dispute_evidences: [evidence_row(1, 1, seller_contacted_at: "2026-10-28 09:00:00")])
fight.call("fight: the seller was never contacted", [1], disputes: [dispute_row(1)], dispute_evidences: [evidence_row(1, 1)])

payout = ->(name, args) { cases << run(name, "PayoutUsersWorker", args) }
payout.call("payout users: no users", ["2026-11-01", "stripe", []])
payout.call("payout users: nil users", ["2026-11-01", "stripe", nil])
payout.call("payout users: a user", ["2026-11-01", "stripe", [1]])
payout.call("payout users: a lone id", ["2026-11-01", "paypal", 1, "standard", true])

stats = ->(name, args, **seed) { cases << run(name, "UpdateUserBalanceStatsCacheWorker", args, seed:) }
stats.call("balance stats: the user does not exist", [99])
stats.call("balance stats: a user", [1], users: [user_row(1)])
stats.call("balance stats: a deleted user", [1], users: [user_row(1, deleted_at: SEEDED_AT)])

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
