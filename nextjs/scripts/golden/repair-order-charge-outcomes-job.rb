# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/repair-order-charge-outcomes-job.golden.json: RepairOrderChargeOutcomesJob run by the
# real app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). Purchases are plain INSERTs; `marks` is what the
# three order_charge_outcome_repair keys of the main Redis ($redis) held before and after. The cases stay far below the 2,000-id and
# 40-page budgets, which Node hands back. Run it like record-order-charge-outcome-job.rb (USE_DB_WORKER_REPLICAS=true).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/repair-order-charge-outcomes-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
OLD = "2026-01-01 00:00:00"
RECENT = "2026-11-03 00:00:00"
TABLES = %w[orders order_purchases purchases].freeze
PARTIALLY_SUCCESSFUL = Order.flag_mapping["flags"][:partially_successful]
KEYS = { "cursor" => RedisKey.order_charge_outcome_repair_cursor, "lap_ceiling" => RedisKey.order_charge_outcome_repair_lap_ceiling, "recent_mark" => RedisKey.order_charge_outcome_repair_recent_mark }.freeze

Rails.logger = ActiveSupport::Logger.new(nil)

# `orders`: { id => [created_at, flags, [purchase states]] }. Purchase ids count up from 1 in order of appearance.
def seed_for(orders)
  rows = { orders: [], order_purchases: [], purchases: [] }
  purchase_id = 0
  orders.each do |id, (created_at, flags, states)|
    rows[:orders] << { id:, flags:, created_at:, updated_at: created_at }
    states.each do |state|
      purchase_id += 1
      rows[:purchases] << { id: purchase_id, link_id: 1, seller_id: 1, email: "buyer#{purchase_id}@example.com", purchase_state: state, price_cents: 500, flags: 0, created_at:, updated_at: created_at }
      rows[:order_purchases] << { id: purchase_id, order_id: id, purchase_id:, created_at:, updated_at: created_at }
    end
  end
  rows
end

def marks = KEYS.transform_values { $redis.get(_1) }

def run(name, orders, marks: {})
  before = nil
  setup = lambda do
    KEYS.each_value { $redis.del(_1) }
    marks.each { |key, value| $redis.set(KEYS.fetch(key), value) }
    before = marks()
  end
  result = capture(name, now: NOW, tables: TABLES, seed: seed_for(orders), setup:, sidekiq: true, job: "RepairOrderChargeOutcomesJob", args: []) do
    RepairOrderChargeOutcomesJob.new.perform
  end
  result.delete("seed")
  result.delete("redis_before")
  result["marks_before"] = before
  result["marks"] = marks()
  result
end

S = "successful"
F = "failed"
cases = []
cases << run("no orders", {})
cases << run("a recent order with a succeeded and a failed line item", { 1 => [RECENT, 0, [S, F]] })
cases << run("an old order with a succeeded and a failed line item", { 1 => [OLD, 0, [S, F]] })
cases << run("a recent and an old order", { 1 => [OLD, 0, [S, F]], 2 => [RECENT, 0, [S, F]] })
cases << run("a recent order that is already flagged", { 1 => [RECENT, PARTIALLY_SUCCESSFUL, [S, F]] })
cases << run("an old order that is already flagged", { 1 => [OLD, PARTIALLY_SUCCESSFUL, [S, F]] })
cases << run("an order whose line items all failed", { 1 => [RECENT, 0, [F, F]] })
cases << run("an order with a failed and an in progress line item", { 1 => [RECENT, 0, [F, "in_progress"]] })
cases << run("each failure state", { 1 => [RECENT, 0, [S, "preorder_authorization_failed"]], 2 => [RECENT, 0, [S, "gift_receiver_purchase_failed"]] })
cases << run("several orders in both windows", { 1 => [OLD, 0, [S, F]], 2 => [RECENT, 0, [F, S]], 3 => [OLD, 0, [S, F, F]], 4 => [RECENT, 0, [S, S]], 5 => [RECENT, 0, [S, F]] })
cases << run("a recent mark past the first purchases", { 1 => [RECENT, 0, [S, F]], 2 => [RECENT, 0, [S, F]], 3 => [RECENT, 0, [S, F]] }, marks: { "recent_mark" => "2" })
cases << run("a recent mark at the end wraps", { 1 => [RECENT, 0, [S, F]] }, marks: { "recent_mark" => "2" })
cases << run("a recent mark past the end finds nothing to wrap to", { 1 => [RECENT, 0, [S, S]] }, marks: { "recent_mark" => "2" })
cases << run("a recent mark that is not a number", { 1 => [RECENT, 0, [S, F]] }, marks: { "recent_mark" => "abc" })
cases << run("a cursor and ceiling mid lap", { 1 => [OLD, 0, [S, F]], 2 => [OLD, 0, [S, F]], 3 => [OLD, 0, [S, F]] }, marks: { "cursor" => "1", "lap_ceiling" => "3" })
cases << run("a cursor and ceiling that excludes the newest order", { 1 => [OLD, 0, [S, F]], 2 => [OLD, 0, [S, F]], 3 => [OLD, 0, [S, F]] }, marks: { "cursor" => "0", "lap_ceiling" => "2" })
cases << run("a cursor without a ceiling", { 1 => [OLD, 0, [S, F]], 2 => [OLD, 0, [S, F]] }, marks: { "cursor" => "1" })
cases << run("a cursor past every failed order wraps", { 1 => [OLD, 0, [S, F]], 2 => [OLD, 0, [S, F]] }, marks: { "cursor" => "2", "lap_ceiling" => "2" })
cases << run("a cursor past every failed order with nothing to repair", { 1 => [OLD, PARTIALLY_SUCCESSFUL, [S, F]] }, marks: { "cursor" => "1", "lap_ceiling" => "1" })
cases << run("a cursor that is not a number", { 1 => [OLD, 0, [S, F]] }, marks: { "cursor" => "abc", "lap_ceiling" => "xyz" })
cases << run("all marks set", { 1 => [OLD, 0, [S, F]], 2 => [RECENT, 0, [S, F]], 3 => [RECENT, 0, [S, F]], 4 => [OLD, 0, [S, F]] }, marks: { "cursor" => "1", "lap_ceiling" => "4", "recent_mark" => "2" })

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
