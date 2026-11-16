# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/payout-batch-fan-out.golden.json: the two payout batch jobs up to the point where they
# touch the database or the in-flight token, run by the real app as Sidekiq jobs (support/sidekiq_executor.rb).
# PerformPayoutsUpToDelayDaysAgoWorker with several bank account types only pushes one job per type; PerformPayoutsForUserSliceWorker
# with no seller ids returns. Everything past those points (the in-flight token, the query cap, the eligibility walk) is not run here.
# Run it like flush-delivered-email-infos-job.rb: USE_DB_WORKER_REPLICAS=true and one Redis database for REDIS_HOST and SIDEKIQ_REDIS_HOST.
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/payout-batch-fan-out.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)

Rails.logger = ActiveSupport::Logger.new(nil)

def run(name, job, args)
  result = capture(name, now: NOW, tables: [], sidekiq: true, job:, args:, at: NOW.to_f) do
    job.constantize.new.perform(*args)
  end
  result.delete("seed")
  result.delete("rows")
  result
end

orchestrator = "PerformPayoutsUpToDelayDaysAgoWorker"
slice = "PerformPayoutsForUserSliceWorker"
cases = []
cases << run("two bank account types", orchestrator, ["STRIPE", %w[AustralianBankAccount UkBankAccount]])
cases << run("three bank account types", orchestrator, ["STRIPE", %w[AchAccount CanadianBankAccount EuropeanBankAccount]])
cases << run("several bank account types for PayPal", orchestrator, ["PAYPAL", %w[AchAccount UkBankAccount]])
cases << run("the same bank account type twice", orchestrator, ["STRIPE", %w[UkBankAccount UkBankAccount]])
cases << run("bank account types that are not names", orchestrator, ["STRIPE", [1, nil, { "a" => 1 }]])

cases << run("no seller ids", slice, ["STRIPE", "2026-10-30", nil])
cases << run("an empty list of seller ids", slice, ["STRIPE", "2026-10-30", []])
cases << run("an empty string of seller ids", slice, ["STRIPE", "2026-10-30", ""])
cases << run("a blank string of seller ids", slice, ["STRIPE", "2026-10-30", "  "])
cases << run("an empty hash of seller ids", slice, ["STRIPE", "2026-10-30", {}])
cases << run("seller ids that are false", slice, ["STRIPE", "2026-10-30", false])
cases << run("no seller ids with a bank account type", slice, ["STRIPE", "2026-10-30", [], "UkBankAccount"])
cases << run("no seller ids and a date that does not parse", slice, ["STRIPE", "not a date", []])
cases << run("no seller ids and no date", slice, ["STRIPE", nil, []])

File.write(OUT, JSON.pretty_generate({ "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
