# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/record-order-charge-outcome-job.golden.json: RecordOrderChargeOutcomeJob run by the
# real app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). Purchases are plain INSERTs (the purchase
# factory charges Stripe); `rows` keeps the order's flags afterwards. Run it like expiring-credit-card-message-worker.rb
# (env as in publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/record-order-charge-outcome-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[orders order_purchases purchases].freeze
PARTIALLY_SUCCESSFUL = Order.flag_mapping["flags"][:partially_successful]
DEPRECATED_RECEIPT = Order.flag_mapping["flags"][:DEPRECATED_seller_receipt_enabled]

Rails.logger = ActiveSupport::Logger.new(nil)

def purchase_row(id, state) = { id:, link_id: 1, seller_id: 1, email: "buyer#{id}@example.com", purchase_state: state, price_cents: 500, flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }

# An order (id 1) holding one purchase per state given; order 2 holds a purchase of its own.
def seed_for(states, flags: 0)
  purchases = states.each_with_index.map { |state, i| purchase_row(i + 1, state) } + [purchase_row(100, "successful"), purchase_row(101, "failed")]
  links = states.each_index.map { |i| { id: 1 + i, order_id: 1, purchase_id: i + 1, created_at: SEEDED_AT, updated_at: SEEDED_AT } }
  links += [{ id: 100, order_id: 2, purchase_id: 100, created_at: SEEDED_AT, updated_at: SEEDED_AT }, { id: 101, order_id: 2, purchase_id: 101, created_at: SEEDED_AT, updated_at: SEEDED_AT }]
  { orders: [{ id: 1, flags:, created_at: SEEDED_AT, updated_at: SEEDED_AT }, { id: 2, flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }], order_purchases: links, purchases: }
end

def run(name, args, states = [], flags: 0, seed: nil)
  result = capture(name, now: NOW, tables: TABLES, seed: seed || seed_for(states, flags:), sidekiq: true, job: "RecordOrderChargeOutcomeJob", args:) do
    RecordOrderChargeOutcomeJob.new.perform(*args)
  end
  result.delete("seed")
  result
end

cases = []
cases << run("an order that does not exist", [99])
cases << run("an order id of nil", [nil])
cases << run("an order with no purchases", [1], [])
cases << run("one succeeded and one failed purchase", [1], %w[successful failed])
cases << run("the same order given as a digit string", ["1"], %w[successful failed])
cases << run("only succeeded purchases", [1], %w[successful successful])
cases << run("only failed purchases", [1], %w[failed failed])
cases << run("already marked partially successful", [1], %w[successful failed], flags: PARTIALLY_SUCCESSFUL)
cases << run("another flag already set", [1], %w[successful failed], flags: DEPRECATED_RECEIPT)
cases << run("both flags already set", [1], %w[successful failed], flags: DEPRECATED_RECEIPT | PARTIALLY_SUCCESSFUL)
cases << run("a purchase still in progress next to a succeeded one", [1], %w[successful in_progress])
cases << run("a purchase still in progress next to a failed one", [1], %w[failed in_progress])
cases << run("a test purchase next to a failed one", [1], %w[test_successful failed])
cases << run("a test preorder purchase next to a failed one", [1], %w[test_preorder_successful failed])
cases << run("an order whose siblings sit in another order", [2], [])
Purchase::CHECKOUT_SUCCESS_STATES.each { |state| cases << run("succeeded side state #{state}", [1], [state, "failed"]) }
Purchase::CHECKOUT_FAILURE_STATES.each { |state| cases << run("failed side state #{state}", [1], ["successful", state]) }

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
