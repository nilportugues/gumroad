# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/generate-financial-reports-jobs.golden.json: GenerateFinancialReportsForPreviousQuarterJob and
# GenerateFinancialReportsForPreviousMonthJob run by the real app as Sidekiq jobs (support/sidekiq_executor.rb), in production (where they
# enqueue the report jobs; elsewhere perform returns at once) and out of it, and the block of their sidekiq_retries_exhausted
# (FinanceReportFailureAlert). The report jobs are only enqueued, never run. `redis` is the scratch Redis afterwards, where REDIS_HOST and
# SIDEKIQ_REDIS_HOST are one database: the pushes, their unique-jobs locks and the completion key. Run it like finance-report-jobs.rb.
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/generate-financial-reports-jobs.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)

Rails.logger = ActiveSupport::Logger.new(nil)
ActiveJob::Base.queue_adapter = :sidekiq
ActiveJob::Base.logger = Logger.new(nil)
ActionMailer::Base.deliver_later_queue_name = :default
Time.zone = "UTC"

def in_production
  env = Rails.instance_variable_get(:@_env)
  Rails.instance_variable_set(:@_env, ActiveSupport::EnvironmentInquirer.new("production"))
  yield
ensure
  Rails.instance_variable_set(:@_env, env)
end

def run(klass, name, args, now: NOW, production: true)
  result = capture(name, now:, tables: [], sidekiq: true, job: klass.name, args:, production:, case_now: now.to_f) do
    body = -> { klass.new.perform(*args) }
    production ? in_production(&body) : body.call
  end
  result.delete("seed")
  result.delete("rows")
  result
end

def exhausted(klass, name, job, error: StandardError.new("boom"))
  result = capture(name, now: NOW, tables: [], sidekiq: true, job: klass.name, args: job["args"], hook: true, item: job, exception: { "class" => error.class.name, "message" => error.message }) do
    klass.sidekiq_retries_exhausted_block.call(job, error)
  end
  result.delete("seed")
  result.delete("rows")
  result
end

QUARTER = GenerateFinancialReportsForPreviousQuarterJob
MONTH = GenerateFinancialReportsForPreviousMonthJob

cases = []
{ QUARTER => [[2, 2026], [4, 2025], [1, 2014], [3, 3200], [2]], MONTH => [[3, 2026], [12, 2025], [1, 2014], [6, 3200], [5]] }.each do |klass, periods|
  periods.each { |args| cases << run(klass, "#{klass.name} in production with #{args.inspect}", args) }
  cases << run(klass, "#{klass.name} in production with no arguments", [])
  cases << run(klass, "#{klass.name} in production with no arguments in January", [], now: Time.utc(2027, 1, 15, 8, 0, 0, 500_000))
  cases << run(klass, "#{klass.name} in production with no arguments on the first of a quarter", [], now: Time.utc(2026, 4, 1, 0, 0, 0))
  cases << run(klass, "#{klass.name} in production with no arguments at the end of a year", [], now: Time.utc(2026, 12, 31, 23, 59, 59))
  cases << run(klass, "#{klass.name} in production with nil arguments", [nil, nil])
  cases << run(klass, "#{klass.name} in production with a nil period", [nil, 2026])
  cases << run(klass, "#{klass.name} in production with a nil year", [2, nil])
  cases << run(klass, "#{klass.name} in production with a false period", [false, 2026])
  cases << run(klass, "#{klass.name} in production with an invalid period", [0, 2026])
  cases << run(klass, "#{klass.name} in production with a period past the end", [klass == QUARTER ? 5 : 13, 2026])
  cases << run(klass, "#{klass.name} in production with a negative period", [-1, 2026])
  cases << run(klass, "#{klass.name} in production with a year before the first", [2, 2013])
  cases << run(klass, "#{klass.name} in production with a year after the last", [2, 3201])
  cases << run(klass, "#{klass.name} in production with an invalid period and year", [0, 0])
  cases << run(klass, "#{klass.name} in production with a string period", ["2", 2026])
  cases << run(klass, "#{klass.name} in production with a string year", [2, "2026"])
  cases << run(klass, "#{klass.name} in production with a boolean period", [true, 2026])
  cases << run(klass, "#{klass.name} in production with an array period", [[2], 2026])
  cases << run(klass, "#{klass.name} in production with a huge year", [2, 2**70])
  cases << run(klass, "#{klass.name} in production with a Float period", [2.0, 2026])
  cases << run(klass, "#{klass.name} in production with a Float year", [2, 2026.0])
  cases << run(klass, "#{klass.name} in production with three arguments", [2, 2026, 1])
  cases << run(klass, "#{klass.name} outside production", [], production: false)
  cases << run(klass, "#{klass.name} outside production with a period", [2, 2026], production: false)
  cases << run(klass, "#{klass.name} outside production with an invalid period", [0, 2026], production: false)

  base_job = { "class" => klass.name, "args" => [], "jid" => "abc", "queue" => "default" }
  cases << exhausted(klass, "#{klass.name} exhausted with no arguments and no timestamps", base_job)
  cases << exhausted(klass, "#{klass.name} exhausted with no arguments, created_at 2026-02-28", base_job.merge("created_at" => Time.utc(2026, 2, 28, 23, 59, 59).to_f + 0.5))
  cases << exhausted(klass, "#{klass.name} exhausted with no arguments, created_at on 2026-04-01", base_job.merge("created_at" => Time.utc(2026, 4, 1, 0, 0, 0).to_f))
  cases << exhausted(klass, "#{klass.name} exhausted with no arguments, created_at on 2026-01-01", base_job.merge("created_at" => Time.utc(2026, 1, 1, 0, 0, 0).to_f))
  cases << exhausted(klass, "#{klass.name} exhausted with no arguments, only enqueued_at", base_job.merge("enqueued_at" => Time.utc(2027, 3, 1, 0, 0, 1).to_f))
  cases << exhausted(klass, "#{klass.name} exhausted with arguments", base_job.merge("args" => [2, 2026]))
  cases << exhausted(klass, "#{klass.name} exhausted with an ArgumentError", base_job.merge("args" => [0, 2026]), error: ArgumentError.new("Invalid quarter"))
end

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
