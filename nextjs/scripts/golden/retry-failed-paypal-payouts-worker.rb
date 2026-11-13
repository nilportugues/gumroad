# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/retry-failed-paypal-payouts-worker.golden.json: RetryFailedPaypalPayoutsWorker run by the
# real app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb), with the clock on each weekday the end date
# depends on and the :disable_transient_payout_failure_requeue Flipper feature set in `setup` (`redis_before`).
# Payouts.create_payments_for_balances_up_to_date_for_users creates the payments and pushes the PayPal batch, so it is replaced by a
# marker that ends the case with `hands_back`. Run it like alert-on-stuck-piracy-reports-job.rb (USE_DB_WORKER_REPLICAS=true, env as
# in publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/retry-failed-paypal-payouts-worker.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[users payments].freeze
FLAG = :disable_transient_payout_failure_requeue
END_DATE = "2026-10-30"

Rails.logger = ActiveSupport::Logger.new(nil)

class HandBackMarker < Exception; end

Payouts.singleton_class.prepend(Module.new do
  def create_payments_for_balances_up_to_date_for_users(*, **) = raise(HandBackMarker)
end)

def user_row(id, **overrides) = { id:, email: "user#{id}@example.com", username: "user#{id}", external_id: (1000 + id).to_s, user_risk_state: "compliant", flags: 0, confirmed_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)

def payment_row(id, user_id = 1, **overrides)
  { id:, user_id:, state: "failed", processor: "PAYPAL", payout_period_end_date: END_DATE, failure_reason: nil, flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

# Flipper reads the main Redis (REDIS_HOST), which `capture` neither flushes nor snapshots when it is not the Sidekiq one (it is not
# under test-redis-isolation), so the feature starts from a flushed main Redis and `redis_before` is that Redis afterwards.
def run(name, payments = [], now: NOW, flag: nil, users: [user_row(1), user_row(2)])
  flag_state = nil
  setup = lambda do
    $redis.flushdb
    case flag
    when :on then Feature.activate(FLAG)
    when :off then Feature.activate(FLAG).then { Feature.deactivate(FLAG) }
    when :time100 then Flipper.enable_percentage_of_time(FLAG, 100)
    when :time50 then Flipper.enable_percentage_of_time(FLAG, 50)
    when :actors100 then Feature.activate_percentage(FLAG, 100)
    end
    flag_state = snapshot_redis($redis)
  end
  hands_back = false
  result = capture(name, now:, tables: TABLES, seed: { users:, payments: }, setup:, sidekiq: true, job: "RetryFailedPaypalPayoutsWorker", args: []) do
    RetryFailedPaypalPayoutsWorker.new.perform
  rescue HandBackMarker
    hands_back = true
  end
  result.delete("seed")
  result.delete("rows")
  result.merge("hands_back" => hands_back, "redis_before" => flag_state)
end

cases = []
cases << run("no payments")
cases << run("a failed PayPal payout of the period")
cases << run("the requeue switched on", [payment_row(1)], flag: :on)
cases << run("the requeue switched on and off again", [payment_row(1)], flag: :off)
cases << run("the requeue at 100 percent of time", [payment_row(1)], flag: :time100)
cases << run("the requeue at 100 percent of actors", [payment_row(1)], flag: :actors100)
cases << run("the requeue at 50 percent of time", [payment_row(1)], flag: :time50)
cases << run("a payout that failed with a processor outage", [payment_row(1, failure_reason: "processor_unavailable")])
cases << run("a payout that failed for another reason", [payment_row(1, failure_reason: "cannot_pay")])
cases << run("a payout that failed with an empty reason", [payment_row(1, failure_reason: "")])
cases << run("a payout that is not failed", [payment_row(1, state: "completed")])
cases << run("a failed Stripe payout", [payment_row(1, processor: "STRIPE")])
cases << run("a failed payout of another period", [payment_row(1, payout_period_end_date: "2026-10-23")])
cases << run("a failed payout with no period", [payment_row(1, payout_period_end_date: nil)])
cases << run("two failed payouts of one seller", [payment_row(1), payment_row(2)])
cases << run("failed payouts of two sellers", [payment_row(1), payment_row(2, 2)])
cases << run("a failed payout of a seller that does not exist", [payment_row(1, 9)])
cases << run("a failed payout with no seller", [payment_row(1, nil)])
{ "Sunday" => "2026-11-01", "Monday" => "2026-11-02", "Tuesday" => "2026-11-03", "Friday" => "2026-11-06", "Saturday" => "2026-11-07" }.each do |day, date|
  at = Time.utc(*date.split("-").map(&:to_i), 12, 30, 45, 123_000)
  cases << run("a failed payout on a #{day}", [payment_row(1, payout_period_end_date: "2026-10-30"), payment_row(2, 2, payout_period_end_date: "2026-10-23")], now: at)
  cases << run("a failed payout of the week before on a #{day}", [payment_row(1, payout_period_end_date: "2026-10-23")], now: at)
end
cases << run("a failed payout of a period ending on the wrong week of a Wednesday", [payment_row(1, payout_period_end_date: "2026-11-06")])

File.write(OUT, "{\n\"now\": #{NOW.to_f.to_json},\n\"cases\": [\n#{cases.map(&:to_json).join(",\n")}\n]\n}\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
