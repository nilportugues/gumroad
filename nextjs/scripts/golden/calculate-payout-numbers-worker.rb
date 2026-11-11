# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/calculate-payout-numbers-worker.golden.json: CalculatePayoutNumbersWorker run by the
# real app as a Sidekiq job (support/sidekiq_executor.rb), Elasticsearch captured (EsCapture) and answered with the case's
# `es_bodies`. Each case sets its own clock, since the searched week is last week in Los Angeles. Run it like
# update-taxonomy-stats-job.rb (env as in publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases
capture_elasticsearch!

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/calculate-payout-numbers-worker.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)

Rails.logger = ActiveSupport::Logger.new(nil)

def answer(total) = { "hits" => { "hits" => [] }, "aggregations" => { "total_made" => { "value" => total } } }

def run(name, body, now: NOW)
  result = capture(name, now:, tables: [], sidekiq: true, job: "CalculatePayoutNumbersWorker", args: [], es_bodies: [body]) do
    CalculatePayoutNumbersWorker.new.perform
  end
  result.delete("rows")
  result.delete("seed")
  result.merge("now" => now.to_f)
end

cases = []
cases << run("a float sum", answer(123_456_789.0))
cases << run("an integer sum", answer(12_345_600))
cases << run("a sum under one dollar", answer(99.0))
cases << run("a fractional dollar amount truncates", answer(199_999.0))
cases << run("a fractional cent sum", answer(150.7))
cases << run("nothing sold", answer(0.0))
cases << run("a negative sum truncates toward zero", answer(-150.0))
cases << run("a fractional negative sum under one dollar truncates to zero", answer(-99.5))
cases << run("a sum just under the safe integer limit", answer(9_007_199_254_740_991))
cases << run("an integer sum past 2**53", answer(100_000_000_000_000_000_000_000_000))
cases << run("a null sum", answer(nil))
cases << run("a string sum", answer("12345"))
cases << run("an answer without aggregations", { "hits" => { "hits" => [] } })
cases << run("an answer without the sum", { "aggregations" => {} })
cases << run("a sum aggregation without a value", { "aggregations" => { "total_made" => {} } })
cases << run("a Monday morning in Los Angeles", answer(5000.0), now: Time.utc(2026, 11, 9, 8, 0, 0))
cases << run("a Sunday night in Los Angeles, already Monday in UTC", answer(5000.0), now: Time.utc(2026, 11, 9, 7, 59, 59))
cases << run("the week after daylight saving time ends", answer(5000.0), now: Time.utc(2026, 11, 4, 12, 0, 0))
cases << run("the week daylight saving time starts", answer(5000.0), now: Time.utc(2027, 3, 17, 12, 0, 0))
cases << run("a new year", answer(5000.0), now: Time.utc(2027, 1, 3, 12, 0, 0))
cases << run("a leap day", answer(5000.0), now: Time.utc(2028, 3, 2, 12, 0, 0))
cases << run("a Sunday in Los Angeles", answer(5000.0), now: Time.utc(2026, 11, 15, 20, 0, 0))

File.write(OUT, JSON.pretty_generate({ "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
