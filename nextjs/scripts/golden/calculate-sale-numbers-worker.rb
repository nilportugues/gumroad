# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/calculate-sale-numbers-worker.golden.json: CalculateSaleNumbersWorker run by the real
# app as a Sidekiq job (support/sidekiq_executor.rb), Elasticsearch captured (EsCapture) and answered with the case's `es_bodies`.
# Run it like update-taxonomy-stats-job.rb (env as in publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases
capture_elasticsearch!

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/calculate-sale-numbers-worker.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)

Rails.logger = ActiveSupport::Logger.new(nil)

def answer(total, creators) = { "hits" => { "hits" => [] }, "aggregations" => { "total_made" => { "value" => total }, "number_of_creators" => { "value" => creators } } }

def run(name, body)
  result = capture(name, now: NOW, tables: [], sidekiq: true, job: "CalculateSaleNumbersWorker", args: [], es_bodies: [body]) do
    CalculateSaleNumbersWorker.new.perform
  end
  result.delete("rows")
  result.delete("seed")
  result
end

cases = []
cases << run("a float sum and an integer cardinality", answer(123_456.0, 42))
cases << run("an integer sum", answer(12_345_600, 7))
cases << run("a sum under one dollar", answer(99.0, 1))
cases << run("a sum that rounds down to the dollar", answer(150.7, 3))
cases << run("exactly one dollar", answer(100.0, 3))
cases << run("a negative sum floors", answer(-150.0, 3))
cases << run("a small negative sum floors to minus one", answer(-1.0, 3))
cases << run("nothing sold", answer(0.0, 0))
cases << run("a sum just under the safe integer limit", answer(9_007_199_254_740_991, 40_000))
cases << run("a null sum counts as zero", answer(nil, 5))
cases << run("a float cardinality is stored as Ruby prints it", answer(1000.0, 5.0))
cases << run("a fractional cardinality", answer(1000.0, 5.5))
cases << run("a null cardinality is stored empty", answer(1000.0, nil))
cases << run("a string cardinality", answer(1000.0, "7"))
cases << run("a cardinality that Ruby prints with an exponent", answer(1000.0, 1.5e20))
cases << run("a tiny fractional cardinality", answer(1000.0, 0.00001))
cases << run("a sum past 2**53", answer(100_000_000_000_000_000_000, 5))
cases << run("a string sum", answer("12345", 5))
cases << run("an answer without aggregations", { "hits" => { "hits" => [] } })
cases << run("an answer without the sum", { "aggregations" => { "number_of_creators" => { "value" => 5 } } })
cases << run("a sum aggregation without a value", { "aggregations" => { "total_made" => {}, "number_of_creators" => { "value" => 5 } } })
cases << run("an answer without the cardinality", { "aggregations" => { "total_made" => { "value" => 100.0 } } })
cases << run("a cardinality aggregation without a value", { "aggregations" => { "total_made" => { "value" => 100.0 }, "number_of_creators" => {} } })

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
