# frozen_string_literal: true

# Produces standalone-jobs.golden.json by running the real app/sidekiq job files (loaded as-is, not
# copied) with the real sidekiq and sidekiq-unique-jobs gems against a scratch Redis DB:
#
#   export GEM_HOME=/tmp/ws05-gems GEM_PATH=/tmp/ws05-gems   # see ../../server/jobs/__fixtures__
#   REDIS_URL=redis://127.0.0.1:6379/13 ruby generate-standalone-jobs-golden.rb
gem "json", "2.13.2"
gem "sidekiq", "7.3.4"
gem "sidekiq-unique-jobs", "8.0.10"
require "json"
require "open-uri"
require "tmpdir"
require "active_support"
require "active_support/core_ext/numeric/time"
require "active_support/core_ext/object/try"
require "sidekiq"
require "sidekiq_unique_jobs"

REDIS_URL = ENV.fetch("REDIS_URL", "redis://127.0.0.1:6379/13")
abort "Refusing to run against db 0" unless REDIS_URL.match?(%r{/\d+\z}) && !REDIS_URL.end_with?("/0")

Sidekiq.configure_client do |config|
  config.redis = { url: REDIS_URL }
  config.client_middleware { |chain| chain.add SidekiqUniqueJobs::Middleware::Client }
end
Sidekiq.default_job_options = { "backtrace" => true, "retry" => 25 }

APP = File.expand_path("../../../../../app/sidekiq", __dir__)
AWS_DEFAULT_REGION = "us-east-1"

# Records what UpdateCurrenciesWorker hands to Redis::Namespace#set. redis-rb's #set sends
# `value.to_s`, so that is what reaches Redis.
class RecordingNamespace
  attr_reader :writes
  def initialize = @writes = []
  def set(key, value) = @writes << ["currencies:#{key}", value.to_s]
end

module CurrencyHelper
  def currency_namespace = ($currency_namespace ||= RecordingNamespace.new)
end

%w[
  log_sendgrid_event_worker
  sync_stripe_business_profile_url_job
  sync_stripe_business_profile_url_worker
  send_marketing_x_reconnect_email_job
  enqueue_marketing_x_reconnect_email_job
  internal_notification_worker
  handle_sns_aws_config_event_worker
  update_currencies_worker
].each { |file| load File.join(APP, "#{file}.rb") }

FIXED_NOW = Time.at(1_761_955_200, 123_456, :usec)
class Time
  class << self
    def now(...) = FIXED_NOW
  end
end

$jid_seq = 0
module SecureRandom
  def self.hex(n = nil)
    return super unless n == 12
    $jid_seq += 1
    format("%024x", $jid_seq)
  end
end

def redis(&) = Sidekiq.redis(&)
def flush! = redis { |conn| conn.call("FLUSHDB") }

def snapshot
  redis do |conn|
    conn.call("KEYS", "*").sort.to_h do |key|
      type = conn.call("TYPE", key)
      value =
        case type
        when "string" then conn.call("GET", key)
        when "list" then conn.call("LRANGE", key, 0, -1)
        when "set" then conn.call("SMEMBERS", key).sort
        when "hash" then conn.call("HGETALL", key)
        when "zset" then conn.call("ZRANGE", key, 0, -1, "WITHSCORES").flatten.each_slice(2).map { |m, score| [m, score.to_f] }
        end
      next [key, { "type" => type, "count" => value.size, "expires" => conn.call("PTTL", key).positive? }] if key == "uniquejobs:changelog"
      [key, { "type" => type, "value" => value, "expires" => conn.call("PTTL", key).positive? }]
    end
  end
end

# Runs `perform` from a clean Redis and records the result: the Redis state, or the error.
def run(klass, args, before: nil)
  flush!
  $jid_seq = 0
  before&.call
  error = nil
  begin
    klass.new.perform(*args)
  rescue StandardError => e
    error = { "class" => e.class.name, "message" => e.message }
  end
  { "args" => args, "error" => error, "redis" => snapshot }
end

def sns(message) = { "Type" => "Notification", "MessageId" => "m-1", "TopicArn" => "arn:aws:sns:us-east-1:1:config", "Message" => message.is_a?(String) ? message : JSON.generate(message) }

item = {
  "awsRegion" => "eu-west-1",
  "configurationItemCaptureTime" => "2026-10-31T10:00:00.000Z",
  "resourceType" => "AWS::EC2::SecurityGroup",
  "resourceId" => "sg-123",
  "tags" => { "Name" => "web ✓" },
  "relatedEvents" => ["e-1"],
}
change = { "configurationItem" => item, "configurationItemDiff" => { "changeType" => "UPDATE" }, "messageType" => "ConfigurationItemChangeNotification" }

sns_cases = [
  ["ignored snapshot start", sns("messageType" => "ConfigurationSnapshotDeliveryStarted")],
  ["ignored history delivery", sns("messageType" => "ConfigurationHistoryDeliveryCompleted")],
  ["change notification", sns(change)],
  ["no region falls back to the default", sns(change.merge("configurationItem" => item.except("awsRegion")))],
  ["null region falls back to the default", sns(change.merge("configurationItem" => item.merge("awsRegion" => nil)))],
  ["false region falls back to the default", sns(change.merge("configurationItem" => item.merge("awsRegion" => false)))],
  ["no tags", sns(change.merge("configurationItem" => item.except("tags")))],
  ["tags without Name", sns(change.merge("configurationItem" => item.merge("tags" => { "env" => "prod" })))],
  ["tags as a string containing Name", sns(change.merge("configurationItem" => item.merge("tags" => "has Name inside")))],
  ["tags as a string without it", sns(change.merge("configurationItem" => item.merge("tags" => "nothing")))],
  ["tags as a float", sns(change.merge("configurationItem" => item.merge("tags" => 1.5)))],
  ["tags as an integer", sns(change.merge("configurationItem" => item.merge("tags" => 3)))],
  ["tags as an array", sns(change.merge("configurationItem" => item.merge("tags" => ["Name"])))],
  ["numeric fields are interpolated", sns(change.merge("configurationItem" => item.merge("resourceId" => 42, "configurationItemCaptureTime" => 1.5e-05, "tags" => { "Name" => true })))],
  ["empty related events still count", sns(change.merge("configurationItem" => item.merge("relatedEvents" => [])))],
  ["no related events", sns(change.merge("configurationItem" => item.except("relatedEvents")))],
  ["no diff", sns(change.except("configurationItemDiff"))],
  ["message is a JSON string", sns("\"just text\"")],
  ["message is a JSON array", sns("[1]")],
  ["message is JSON null", sns("null")],
  ["message is not JSON", sns("not json")],
  ["subscription confirmation", { "Type" => "SubscriptionConfirmation", "Token" => "t", "SubscribeURL" => "https://example.com/?a=1&b=<2>", "n" => 1.0, "nested" => { "a" => [], "b" => {}, "c" => [1, { "d" => nil }] } }],
]

rate_bodies = {
  "rates" => '{"base":"USD","rates":{"USD":1,"EUR":0.921,"BTC":0.000016123,"JPY":151.2,"VND":25340.0,"SMALL":1e-5,"TINY":0.0001,"BIG":1e16,"BIGGER":12345678901234567890,"FIXED":1000000000000000.5,"NEG":-0.5,"ZERO":0.0,"NIL":null,"STR":"1.5","T":true}}',
  "no rates" => '{"base":"USD"}',
  "empty rates" => '{"rates":{}}',
  "not json" => "<html>",
}

currency_cases = Dir.mktmpdir do |dir|
  rate_bodies.map do |name, body|
    path = File.join(dir, "rates.json")
    File.write(path, body)
    Object.send(:remove_const, :CURRENCY_SOURCE) if defined?(CURRENCY_SOURCE)
    Object.const_set(:CURRENCY_SOURCE, path)
    $currency_namespace = nil
    error = nil
    begin
      UpdateCurrenciesWorker.new.perform
    rescue StandardError => e
      error = { "class" => e.class.name }
    end
    { "name" => name, "body" => body, "writes" => $currency_namespace&.writes || [], "error" => error }
  end
end

float_to_s = [0.0, -0.0, 1.0, -1.5, 0.1, 0.921, 1e-4, 1e-5, 1.6123e-05, 0.000123, 123456789.123, 1e15, 1e16, 1.5e16,
              9007199254740993.0, 1e14, 999999999999999.0, 123456789012345.6, 1.5e15, 1000000000000000.5, 1e100, 1e-300, 5e-324, 1.7976931348623157e308, 2.5e-10, 100.0, 1234567.0]

golden = {
  "generated_with" => { "ruby" => RUBY_VERSION, "sidekiq" => Sidekiq::VERSION, "sidekiq_unique_jobs" => SidekiqUniqueJobs::VERSION },
  "now" => FIXED_NOW.to_f,
  "log_sendgrid_event_worker" => [run(LogSendgridEventWorker, [{ "event" => "open" }, 1])],
  "sync_stripe_business_profile_url_worker" => [
    run(SyncStripeBusinessProfileUrlWorker, [5]),
    run(SyncStripeBusinessProfileUrlWorker, [5, "old_name"]),
    run(SyncStripeBusinessProfileUrlWorker, [12_345_678_901_234_567]),
  ],
  "enqueue_marketing_x_reconnect_email_job" => [
    run(EnqueueMarketingXReconnectEmailJob, [7]).merge("name" => "lock free"),
    run(EnqueueMarketingXReconnectEmailJob, [7], before: -> { SendMarketingXReconnectEmailJob.perform_async(7) }).merge("name" => "delivery already locked"),
  ],
  "handle_sns_aws_config_event_worker" => sns_cases.map { |name, params| run(HandleSnsAwsConfigEventWorker, [params]).merge("name" => name) },
  "update_currencies_worker" => currency_cases,
  # [exact value, Float#to_s]
  "float_to_s" => float_to_s.map { |f| [format("%.17g", f), f.to_s] },
}
flush!
File.write(File.join(__dir__, "standalone-jobs.golden.json"), JSON.pretty_generate(golden) + "\n")
puts "wrote #{File.join(__dir__, "standalone-jobs.golden.json")}"
