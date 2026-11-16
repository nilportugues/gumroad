# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/requeue-transiently-failed-payouts-job.golden.json: RequeueTransientlyFailedPayoutsJob run by
# the real app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). The :disable_transient_payout_failure_requeue
# feature is set in `setup` (`redis_before`). A run where a payment failed for a transient reason on the payout period goes on to group
# the failures, report the exhausted ones and requeue payouts, which Node does not; it hands the run back there. The clock is frozen per
# case because the period is picked by the weekday. Run it like alert-on-stuck-piracy-reports-job.rb (env as in publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/requeue-transiently-failed-payouts-job.golden.json")
WEDNESDAY = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[payments].freeze
FLAG = :disable_transient_payout_failure_requeue

Rails.logger = ActiveSupport::Logger.new(nil)

# The period end date a Wednesday run picks: the Friday payout minus seven days.
PERIOD_END = "2026-10-30"

def payment(id, **overrides)
  { id:, user_id: 1, state: "failed", processor: "STRIPE", failure_reason: "processor_rate_limited", payout_period_end_date: PERIOD_END,
    currency: "usd", amount_cents: 1000, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def run(name, payments = [], now: WEDNESDAY, flag: :off)
  setup = lambda do
    case flag
    when :on then Feature.activate(FLAG)
    when :disabled then Feature.activate(FLAG).then { Feature.deactivate(FLAG) }
    when :time50 then Flipper.enable_percentage_of_time(FLAG, 50)
    when :time100 then Flipper.enable_percentage_of_time(FLAG, 100)
    when :actors100 then Feature.activate_percentage(FLAG, 100)
    end
  end
  result = capture(name, now:, tables: TABLES, seed: { payments: }, setup:, sidekiq: true, job: "RequeueTransientlyFailedPayoutsJob", args: []) do
    RequeueTransientlyFailedPayoutsJob.new.perform
  end
  result.delete("seed")
  result.delete("rows")
  result["now"] = now.to_f
  result
end

cases = []
cases << run("nothing failed")
(1..7).each do |offset| # a Monday to the Sunday after it
  day = Time.utc(2026, 11, 1 + offset, 12, 30, 45, 123_000)
  cases << run("nothing failed on #{day.strftime('%A')}", now: day)
end
cases << run("nothing failed on Friday evening", now: Time.utc(2026, 11, 6, 23, 59, 59, 500_000))
cases << run("nothing failed on Saturday just after midnight", now: Time.utc(2026, 11, 7, 0, 0, 1, 500_000))
cases << run("nothing failed with the requeue disabled", flag: :on)
cases << run("nothing failed with the flag turned off again", flag: :disabled)
cases << run("nothing failed with the requeue disabled for half the time", flag: :time50)
cases << run("nothing failed with the requeue disabled all of the time", flag: :time100)
cases << run("nothing failed with the requeue disabled for all actors", flag: :actors100)
cases << run("a transient failure with the requeue disabled", [payment(1)], flag: :on)
cases << run("a transient failure on the payout period", [payment(1)])
cases << run("a processor unavailable failure on the payout period", [payment(1, failure_reason: "processor_unavailable")])
cases << run("a transient failure on another period", [payment(1, payout_period_end_date: "2026-10-23")])
cases << run("a transient failure on the period of a Saturday run", [payment(1, payout_period_end_date: "2026-10-30")], now: Time.utc(2026, 11, 7, 12, 0, 0, 500_000))
cases << run("a transient failure on the period of a Tuesday run", [payment(1, payout_period_end_date: "2026-10-30")], now: Time.utc(2026, 11, 3, 12, 0, 0, 500_000))
cases << run("a transient failure on the period of a Monday run", [payment(1, payout_period_end_date: "2026-10-23")], now: Time.utc(2026, 11, 2, 12, 0, 0, 500_000))
cases << run("a failure for another reason", [payment(1, failure_reason: "cannot_pay")])
cases << run("a failure with no reason", [payment(1, failure_reason: nil)])
cases << run("a transient failure that is not failed", [payment(1, state: "completed")])
cases << run("a transient failure on PayPal", [payment(1, processor: "PAYPAL")])
cases << run("a transient failure with no period", [payment(1, payout_period_end_date: nil)])
cases << run("two transient failures of one seller", [payment(1), payment(2)])
cases << run("transient failures of two sellers", [payment(1), payment(2, user_id: 2)])

File.write(OUT, JSON.pretty_generate({ "now" => WEDNESDAY.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
