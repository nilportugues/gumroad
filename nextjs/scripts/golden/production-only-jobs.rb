# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/production-only-jobs.golden.json: SendStripeBalanceCheckNotificationJob and
# VerifyFinanceReportsDeliveryJob run by the real app as Sidekiq jobs (support/sidekiq_executor.rb). Both start with
# `return unless Rails.env.production?`. In production the first call that reads or writes anything stands in for the work the port
# does not do (`Feature.active?`, the Redis read probe): a marker exception, recorded as `hands_back`. Run it like finance-report-jobs.rb.
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/production-only-jobs.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)

Rails.logger = ActiveSupport::Logger.new(nil)
ActiveJob::Base.queue_adapter = :sidekiq
ActiveJob::Base.logger = Logger.new(nil)

class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

$production = false
Feature.singleton_class.prepend(Module.new do
  def active?(*) = $production ? raise(HandBackMarker) : super
end)
$redis.singleton_class.prepend(Module.new do
  def set(*, **) = $production ? raise(HandBackMarker) : super
  def get(*) = $production ? raise(HandBackMarker) : super
end)

def in_production
  env = Rails.instance_variable_get(:@_env)
  Rails.instance_variable_set(:@_env, ActiveSupport::EnvironmentInquirer.new("production"))
  $production = true
  yield
ensure
  $production = false
  Rails.instance_variable_set(:@_env, env)
end

def run(klass, name, args, production: false)
  hands_back = false
  result = capture(name, now: NOW, tables: [], sidekiq: true, job: klass.name, args:, at: NOW.to_f) do
    body = -> { klass.new.perform(*args) }
    begin
      production ? in_production(&body) : body.call
    rescue HandBackMarker
      hands_back = true
    end
  end
  result.delete("seed")
  result.delete("rows")
  result.merge("hands_back" => hands_back)
end

cases = []
[SendStripeBalanceCheckNotificationJob, VerifyFinanceReportsDeliveryJob].each do |klass|
  cases << run(klass, "#{klass.name} outside production", [])
  cases << run(klass, "#{klass.name} with an argument", [1])
  cases << run(klass, "#{klass.name} with two arguments", [nil, "a"])
  cases << run(klass, "#{klass.name} in production", [], production: true)
  cases << run(klass, "#{klass.name} in production with an argument", [1], production: true)
end

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
