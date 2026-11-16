# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/million-dollar-milestone-check-worker.golden.json: MillionDollarMilestoneCheckWorker run by
# the real app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb), with Elasticsearch answered by a local socket
# (support/rails_cases.rb) that returns the sums each case sets under `es_bodies`. A seller at or over $1M is where Rails would read the compliance
# info and announce it (the Slack message, the `million_dollar_announcement_sent` flag, an InternalNotificationWorker push): that step is
# replaced by an error named GoldenReached, so the golden keeps the statements and Elasticsearch requests up to it. Run it like
# publish-scheduled-post.rb (env in its header).
require_relative "support/rails_cases"
include RailsCases
capture_elasticsearch!

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/million-dollar-milestone-check-worker.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_456)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[users purchases].freeze
DAY = 86_400
ANNOUNCED = 1 << 37 # User flag 38, million_dollar_announcement_sent

Rails.logger = ActiveSupport::Logger.new(nil)

class GoldenReached < StandardError; end
User.prepend(Module.new do
  def alive_user_compliance_info = raise(GoldenReached, "reached the announcement of user #{id}")
end)

def ago(seconds) = (NOW - seconds).utc.strftime("%Y-%m-%d %H:%M:%S.%6N")

def user_row(id, **overrides) = { id:, email: "seller#{id}@example.com", username: "seller#{id}", external_id: (1000 + id).to_s, flags: 0, confirmed_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)

def purchase_row(id, seller_id, **overrides) = { id:, seller_id:, purchase_state: "successful", price_cents: 100, created_at: ago(15 * DAY), updated_at: SEEDED_AT, flags: 0, quantity: 1 }.merge(overrides)

def sums(price, refunded = 0) = { "aggregations" => { "price_cents_total" => { "value" => price }, "amount_refunded_cents_total" => { "value" => refunded } }, "hits" => { "total" => { "value" => 0, "relation" => "eq" }, "hits" => [] } }

def run(name, users, purchases, bodies = [])
  capture(name, now: NOW, tables: TABLES, seed: { users:, purchases: }, sidekiq: true, job: "MillionDollarMilestoneCheckWorker", args: [], es_bodies: bodies) do
    MillionDollarMilestoneCheckWorker.new.perform
  end.tap { _1.delete("seed"); _1.delete("rows") }
end

cases = []
cases << run("no sellers", [], [])
cases << run("a seller with a sale in the window under the threshold", [user_row(1)], [purchase_row(1, 1)], [sums(99_999_999)])
cases << run("a seller at the threshold", [user_row(1)], [purchase_row(1, 1)], [sums(100_000_000)])
cases << run("a seller over the threshold net of refunds", [user_row(1)], [purchase_row(1, 1)], [sums(150_000_000, 50_000_000)])
cases << run("a seller over the threshold gross but under net", [user_row(1)], [purchase_row(1, 1)], [sums(120_000_000, 30_000_000)])
cases << run("a seller already announced", [user_row(1, flags: ANNOUNCED)], [purchase_row(1, 1)], [sums(200_000_000)])
cases << run("a sale older than the window", [user_row(1)], [purchase_row(1, 1, created_at: ago(30 * DAY))], [sums(200_000_000)])
cases << run("a sale newer than the window", [user_row(1)], [purchase_row(1, 1, created_at: ago(5 * DAY))], [sums(200_000_000)])
cases << run("a sale at the start of the window", [user_row(1)], [purchase_row(1, 1, created_at: ago(23 * DAY))], [sums(200_000_000)])
cases << run("a sale at the end of the window", [user_row(1)], [purchase_row(1, 1, created_at: ago(14 * DAY))], [sums(200_000_000)])
cases << run("a sale just outside the end of the window", [user_row(1)], [purchase_row(1, 1, created_at: ago(14 * DAY - 1))], [sums(200_000_000)])
cases << run("a failed sale", [user_row(1)], [purchase_row(1, 1, purchase_state: "failed")], [sums(200_000_000)])
cases << run("a gift receiver sale", [user_row(1)], [purchase_row(1, 1, purchase_state: "gift_receiver_purchase_successful")], [sums(10)])
cases << run("a charged back sale", [user_row(1)], [purchase_row(1, 1, chargeback_date: ago(DAY))], [sums(200_000_000)])
cases << run("a charged back sale that was reversed", [user_row(1)], [purchase_row(1, 1, chargeback_date: ago(DAY), flags: 1 << 9)], [sums(10)])
cases << run("two sellers under the threshold", [user_row(2), user_row(1)], [purchase_row(1, 1), purchase_row(2, 2)], [sums(1), sums(2)])
cases << run("two sellers, the first over the threshold", [user_row(1), user_row(2)], [purchase_row(1, 1), purchase_row(2, 2)], [sums(300_000_000), sums(1)])
cases << run("two sellers, the second over the threshold", [user_row(1), user_row(2)], [purchase_row(1, 1), purchase_row(2, 2)], [sums(5), sums(300_000_000)])
cases << run("a seller with several sales", [user_row(1)], [purchase_row(1, 1), purchase_row(2, 1), purchase_row(3, 1)], [sums(5)])
cases << run("sums with a fraction", [user_row(1)], [purchase_row(1, 1)], [sums(99_999_999.5)])
cases << run("sums of null", [user_row(1)], [purchase_row(1, 1)], [{ "aggregations" => { "price_cents_total" => { "value" => nil }, "amount_refunded_cents_total" => { "value" => 0 } } }])
cases << run("an answer without aggregations", [user_row(1)], [purchase_row(1, 1)], [{ "hits" => { "total" => { "value" => 0 }, "hits" => [] } }])
cases << run("sellers across a batch boundary", (1..1001).map { user_row(_1) }, (1..1001).map { purchase_row(_1, _1) }, (1..1001).map { sums(1) })

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
