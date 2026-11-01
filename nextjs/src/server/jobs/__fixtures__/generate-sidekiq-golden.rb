# frozen_string_literal: true

# Produces sidekiq-wire.golden.json from the real sidekiq and sidekiq-unique-jobs gems, at the
# versions pinned in Gemfile.lock. Not loaded by Rails; run by hand against a scratch Redis DB:
#
#   export GEM_HOME=/tmp/ws05-gems GEM_PATH=/tmp/ws05-gems
#   gem install json:2.13.2 connection_pool:2.5.5 redis-client:0.22.2 concurrent-ruby:1.3.6
#   gem install --conservative sidekiq:7.3.4 sidekiq-unique-jobs:8.0.10
#   REDIS_URL=redis://127.0.0.1:6379/15 ruby generate-sidekiq-golden.rb
#
# The stub classes copy the sidekiq_options of the real jobs they are named after, so the
# TypeScript test can drive the same cases through the generated registry.
gem "json", "2.13.2"
gem "sidekiq", "7.3.4"
gem "sidekiq-unique-jobs", "8.0.10"
require "json"
require "pathname"
require "sidekiq"
require "sidekiq_unique_jobs"

REDIS_URL = ENV.fetch("REDIS_URL", "redis://127.0.0.1:6379/15")
abort "Refusing to run against db 0" unless REDIS_URL.match?(%r{/\d+\z}) && !REDIS_URL.end_with?("/0")

Sidekiq.configure_client do |config|
  config.redis = { url: REDIS_URL }
  config.client_middleware { |chain| chain.add SidekiqUniqueJobs::Middleware::Client }
end
Sidekiq.default_job_options = { "backtrace" => true, "retry" => 25 }

# Mirrors of real job options (app/sidekiq/*.rb at the time of writing).
class LogResendEventJob
  include Sidekiq::Job
  sidekiq_options retry: 0, queue: :low
end

class InvalidateProductCacheWorker
  include Sidekiq::Job
  sidekiq_options retry: 5, queue: :low, lock: :until_executed
end

class StampPdfForPurchaseJob
  include Sidekiq::Job
  sidekiq_options queue: :long, retry: 5, lock: :until_executed, unique_across_queues: true

  def self.lock_args(args)
    [args.first]
  end
end

class RefreshMerchantAccountProductsRecommendationEligibilityJob
  include Sidekiq::Job
  sidekiq_options retry: 3,
                  queue: :low,
                  lock: :until_executing,
                  lock_ttl: 6 * 3600,
                  on_conflict: { client: :log }
end

class SendChargeReceiptJob
  include Sidekiq::Job
  sidekiq_options queue: :critical,
                  retry: 5,
                  lock: :while_executing,
                  lock_timeout: 2,
                  unique_across_queues: true,
                  on_conflict: { server: :raise }

  def self.lock_args(args)
    [args.first]
  end
end

class SendBundlesMarketingEmailJob
  include Sidekiq::Job
end

class GenerateSslCertificate
  include Sidekiq::Job
  sidekiq_options retry: 5, queue: :low

  RENEWAL_LOCK_OPTIONS = { "lock" => "until_executing", "on_conflict" => "log", "lock_ttl" => 3 * 3600 }.freeze

  def self.lock_args(args)
    [args.first]
  end
end

class RetryFalseJob
  include Sidekiq::Job
  sidekiq_options retry: false, queue: :low
end

class UntilExecutedWithTtlJob
  include Sidekiq::Job
  sidekiq_options retry: 5, queue: :default, lock: :until_executed, lock_ttl: 900
end

FIXED_NOW = Time.at(1_761_955_200, 123_456, :usec)
class Time
  class << self
    alias_method :real_now, :now
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
      pttl = conn.call("PTTL", key)
      [key, { "type" => type, "value" => value, "expires" => pttl.positive? }]
    end
  end
end

# The changelog is a debugging aid whose entries embed timings; compare its count only.
def comparable(state)
  state.to_h do |key, entry|
    next [key, entry] unless key == "uniquejobs:changelog"
    [key, { "type" => entry["type"], "messages" => entry["value"].map { |(json, _)| JSON.parse(json)["message"] }, "expires" => entry["expires"] }]
  end
end

def flush! = redis { |conn| conn.call("FLUSHDB") }

digest_cases = [
  ["InvalidateProductCacheWorker", "low", [1]],
  ["InvalidateProductCacheWorker", "low", [12345678901234567]],
  ["InvalidateProductCacheWorker", "low", ["a/b", "ünïcødé", " ", "<tag>&", "quote\"", nil, true, false]],
  ["InvalidateProductCacheWorker", "low", [{ "b" => 1, "a" => [1, 2.5, { "z" => nil }] }]],
  ["InvalidateProductCacheWorker", "low", [1.0, 0.1, 2.5, "\u0001\t"]],
  ["InvalidateProductCacheWorker", "low", []],
  ["InvalidateProductCacheWorker", "default", [1]],
  ["StampPdfForPurchaseJob", "long", [42, true]],
  ["StampPdfForPurchaseJob", "critical", [42]],
  ["SendChargeReceiptJob", "critical", [7, 2]],
]

digests = digest_cases.map do |klass, queue, args|
  item = { "class" => klass, "queue" => queue, "args" => args }
  SidekiqUniqueJobs::Job.prepare(item)
  { "class" => klass, "queue" => queue, "args" => args, "lock_args" => item["lock_args"], "lock_digest" => item["lock_digest"] }
end

push_cases = [
  { "name" => "plain job, no lock", "class" => "LogResendEventJob", "args" => [{ "type" => "email.delivered" }] },
  { "name" => "class with no sidekiq_options", "class" => "SendBundlesMarketingEmailJob", "args" => [] },
  { "name" => "retry: false", "class" => "RetryFalseJob", "args" => [1] },
  { "name" => "until_executed", "class" => "InvalidateProductCacheWorker", "args" => [99] },
  { "name" => "until_executed, duplicate is dropped", "class" => "InvalidateProductCacheWorker", "args" => [99], "repeat" => true },
  { "name" => "until_executed with lock_ttl", "class" => "UntilExecutedWithTtlJob", "args" => [5] },
  { "name" => "until_executed with lock_ttl, scheduled", "class" => "UntilExecutedWithTtlJob", "args" => [5], "in" => 600 },
  { "name" => "lock_args + unique_across_queues", "class" => "StampPdfForPurchaseJob", "args" => [42, true] },
  { "name" => "until_executing with on_conflict hash", "class" => "RefreshMerchantAccountProductsRecommendationEligibilityJob", "args" => [3] },
  { "name" => "while_executing takes no client lock", "class" => "SendChargeReceiptJob", "args" => [7, 1] },
  { "name" => "scheduled, no lock", "class" => "LogResendEventJob", "args" => [1], "in" => 30.5 },
  { "name" => "queue override via set", "class" => "LogResendEventJob", "args" => [1], "queue" => "default" },
  { "name" => "per-call lock via set", "class" => "GenerateSslCertificate", "args" => [5, "renewal"], "set" => GenerateSslCertificate::RENEWAL_LOCK_OPTIONS },
  { "name" => "per-call lock via set, scheduled", "class" => "GenerateSslCertificate", "args" => [5], "set" => GenerateSslCertificate::RENEWAL_LOCK_OPTIONS, "in" => 30 },
]

pushes = push_cases.map do |c|
  flush!
  $jid_seq = 0
  klass = Object.const_get(c["class"])
  set_options = c["queue"] ? { queue: c["queue"] } : c["set"]
  setter = set_options ? klass.set(set_options) : klass
  jids = (c["repeat"] ? 2 : 1).times.map do
    c["in"] ? setter.perform_in(c["in"], *c["args"]) : setter.perform_async(*c["args"])
  end
  c.merge("jids" => jids, "redis" => comparable(snapshot))
end

# The Lua the gem loads, rendered once so Node runs byte-identical scripts.
lua_root = Pathname.new(Gem.loaded_specs["sidekiq-unique-jobs"].full_gem_path).join("lib/sidekiq_unique_jobs/lua")
scripts = %w[queue lock unlock].to_h do |name|
  [name, SidekiqUniqueJobs::Script::Template.new(lua_root).render(lua_root.join("#{name}.lua"))]
end
File.write(
  File.join(__dir__, "../sidekiq/unique-jobs-lua.generated.ts"),
  "// Generated by __fixtures__/generate-sidekiq-golden.rb from sidekiq-unique-jobs #{SidekiqUniqueJobs::VERSION} (MIT).\n" \
  "// Do not edit: Ruby and Node must run byte-identical scripts against the same keys.\n" +
  scripts.map { |name, source| "export const #{name.upcase}_LUA = #{JSON.generate(source)};\n" }.join,
)

flush!
File.write(
  File.join(__dir__, "sidekiq-wire.golden.json"),
  JSON.pretty_generate(
    "generated_with" => { "ruby" => RUBY_VERSION, "sidekiq" => Sidekiq::VERSION, "sidekiq_unique_jobs" => SidekiqUniqueJobs::VERSION },
    "now" => FIXED_NOW.to_f,
    "digests" => digests,
    "pushes" => pushes,
  ) + "\n",
)
puts "wrote #{digests.size} digests and #{pushes.size} pushes"
