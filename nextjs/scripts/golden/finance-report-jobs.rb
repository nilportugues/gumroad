# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/finance-report-jobs.golden.json: the finance report jobs that only mail a report in
# production (EmailOutstandingBalancesCsvWorker, SendStripeCurrencyBalancesReportJob, SendDeferredRefundsReportWorker,
# SendFinancesReportWorker, SendDailyFinanceLedgerReportJob, SendStripeBalanceSummariesReportJob), run by the real app as Sidekiq jobs
# (support/sidekiq_executor.rb), and the block of their sidekiq_retries_exhausted (FinanceReportFailureAlert).
#
# `redis_ops` are the calls the job makes on `$redis` (LongRunningJobTracking's eval and zrem, FinanceReportCompletionTracking's set);
# `redis` is the scratch Redis afterwards, where REDIS_HOST and SIDEKIQ_REDIS_HOST are one database. Outside production perform returns
# at once; in production it would build the report (Stripe, the database), which a marker exception stands in for. Run it like
# flush-delivered-email-infos-job.rb, with USE_DB_WORKER_REPLICAS=true.
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/finance-report-jobs.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)

Rails.logger = ActiveSupport::Logger.new(nil)
ActiveJob::Base.queue_adapter = :sidekiq
ActiveJob::Base.logger = Logger.new(nil)
ActionMailer::Base.deliver_later_queue_name = :default

class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

$uuid_seq = 0
SecureRandom.singleton_class.prepend(Module.new do
  def uuid = format("00000000-0000-4000-8000-%012x", ($uuid_seq += 1))
end)
Process.singleton_class.prepend(Module.new do
  def pid = 4242
end)

$redis_ops = []
$redis.singleton_class.prepend(Module.new do
  def eval(*args, **kwargs)
    $redis_ops << ["eval", args.first, kwargs[:keys], kwargs[:argv]]
    super
  end

  def zrem(key, member)
    $redis_ops << ["zrem", key, member]
    super
  end

  def set(key, value, **options)
    $redis_ops << ["set", key, value, options.transform_keys(&:to_s)]
    super
  end
end)

# What would run in production, up to the first call the port does not make: the report build or the mail.
[AccountingMailer.singleton_class, StripeCurrencyBalancesReport.singleton_class, StripeBalanceSummariesReport.singleton_class].each do |klass|
  klass.prepend(Module.new do
    def method_missing(name, *, **, &) = $production ? raise(HandBackMarker) : super
    def respond_to_missing?(name, include_private = false) = $production || super
    def stripe_currency_balances_report(*) = $production ? raise(HandBackMarker) : super
    def generate(*) = $production ? raise(HandBackMarker) : super
  end)
end
$production = false

def in_production
  env = Rails.instance_variable_get(:@_env)
  Rails.instance_variable_set(:@_env, ActiveSupport::EnvironmentInquirer.new("production"))
  $production = true
  yield
ensure
  $production = false
  Rails.instance_variable_set(:@_env, env)
end

def finish(result)
  result.delete("seed")
  result.delete("rows")
  result.merge("redis_ops" => $redis_ops.dup)
end

def run(klass, name, args, production: false)
  hands_back = false
  $uuid_seq = 0
  result = capture(name, now: NOW, tables: [], sidekiq: true, job: klass.name, args:, at: NOW.to_f) do
    $redis_ops.clear
    body = -> { klass.new.perform(*args) }
    begin
      production ? in_production(&body) : body.call
    rescue HandBackMarker
      hands_back = true
    end
  end
  finish(result).merge("hands_back" => hands_back)
end

def exhausted(klass, name, job, error: StandardError.new("boom"))
  $uuid_seq = 0
  result = capture(name, now: NOW, tables: [], sidekiq: true, job: klass.name, args: job["args"], hook: true, item: job, exception: { "class" => error.class.name, "message" => error.message }) do
    $redis_ops.clear
    klass.sidekiq_retries_exhausted_block.call(job, error)
  end
  finish(result)
end

PERIODS = [[], [3, 2026], [12, 2025], [1, 2014]].freeze
Time.zone = "UTC"
CLASSES = {
  EmailOutstandingBalancesCsvWorker => { arities: [[]] },
  SendStripeCurrencyBalancesReportJob => { arities: [[]] },
  SendDeferredRefundsReportWorker => { arities: PERIODS },
  SendFinancesReportWorker => { arities: PERIODS + [[1, [2, 3]], [true, "a"], ["é", nil], [nil, nil], [[], [[4], 5]], [2 ** 40, -3]] },
  SendStripeBalanceSummariesReportJob => { arities: PERIODS },
  SendDailyFinanceLedgerReportJob => { arities: [[], ["2026-10-31"], ["not a date"], [nil]] },
}.freeze

cases = []
CLASSES.each do |klass, config|
  config[:arities].each do |args|
    cases << run(klass, "#{klass.name} with #{args.inspect}", args)
  end
  cases << run(klass, "#{klass.name} with four arguments", [1, 2, 3, 4])
  cases << run(klass, "#{klass.name} with an argument of nil among others", [nil, 5])
  cases << run(klass, "#{klass.name} in production", [], production: true)
  cases << run(klass, "#{klass.name} in production with arguments", [5, 2026], production: true)

  base_job = { "class" => klass.name, "args" => [], "jid" => "abc", "queue" => "default" }
  cases << exhausted(klass, "#{klass.name} exhausted with no arguments and no timestamps", base_job)
  cases << exhausted(klass, "#{klass.name} exhausted with no arguments, created_at 2026-02-28", base_job.merge("created_at" => Time.utc(2026, 2, 28, 23, 59, 59).to_f + 0.5))
  cases << exhausted(klass, "#{klass.name} exhausted with no arguments, created_at on 2026-03-31", base_job.merge("created_at" => Time.utc(2026, 3, 31, 0, 0, 0).to_f))
  cases << exhausted(klass, "#{klass.name} exhausted with no arguments, created_at on 2026-01-01", base_job.merge("created_at" => Time.utc(2026, 1, 1, 0, 0, 0).to_f))
  cases << exhausted(klass, "#{klass.name} exhausted with no arguments, only enqueued_at", base_job.merge("enqueued_at" => Time.utc(2027, 3, 1, 0, 0, 1).to_f))
  cases << exhausted(klass, "#{klass.name} exhausted with created_at and enqueued_at", base_job.merge("created_at" => Time.utc(2026, 5, 1).to_f, "enqueued_at" => Time.utc(2027, 3, 1).to_f))
  cases << exhausted(klass, "#{klass.name} exhausted with a created_at of 0", base_job.merge("created_at" => 0))
  cases << exhausted(klass, "#{klass.name} exhausted with arguments", base_job.merge("args" => [5, 2026]))
  cases << exhausted(klass, "#{klass.name} exhausted with arguments, created_at ignored", base_job.merge("args" => [5, 2026], "created_at" => Time.utc(2026, 2, 28).to_f))
  cases << exhausted(klass, "#{klass.name} exhausted with a string argument", base_job.merge("args" => ["2026-10-31"]))
  cases << exhausted(klass, "#{klass.name} exhausted with an argument of nil", base_job.merge("args" => [nil]))
  cases << exhausted(klass, "#{klass.name} exhausted with mixed arguments", base_job.merge("args" => [1, "two", nil, true, [3, "four"]]))
  cases << exhausted(klass, "#{klass.name} exhausted with nil arguments", base_job.merge("args" => nil))
  cases << exhausted(klass, "#{klass.name} exhausted without a class", base_job.except("class"))
  cases << exhausted(klass, "#{klass.name} exhausted with a class of nil", base_job.merge("class" => nil))
  cases << exhausted(klass, "#{klass.name} exhausted with another class name", base_job.merge("class" => "Other"))
  cases << exhausted(klass, "#{klass.name} exhausted with an ArgumentError", base_job, error: ArgumentError.new("Invalid month"))
  cases << exhausted(klass, "#{klass.name} exhausted with an empty message", base_job, error: RuntimeError.new(""))
  cases << exhausted(klass, "#{klass.name} exhausted with a namespaced error", base_job, error: Redis::CannotConnectError.new("down \"quoted\" é"))
end

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
