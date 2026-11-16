# frozen_string_literal: true

# Produces push-bulk.golden.json: what Sidekiq::Client.push_bulk and Sidekiq::Job.perform_bulk
# leave in Redis, from the real sidekiq 7.3.4 and sidekiq-unique-jobs 8.0.10 with the client
# middleware chain config/initializers/sidekiq.rb sets up (unique-jobs, then SidekiqNodeBridge).
# Job classes copy the sidekiq_options of the app's jobs out of their source with Prism.
#
#   BUNDLE_GEMFILE=Gemfile REDIS_URL=redis://127.0.0.1:6379/13 \
#     bundle exec ruby nextjs/src/server/jobs/__fixtures__/generate-push-bulk-golden.rb
gem "json", "2.13.2"
gem "sidekiq", "7.3.4"
gem "sidekiq-unique-jobs", "8.0.10"
require "json"
require "set"
require "tmpdir"
require "prism"
require "sidekiq"
require "sidekiq_unique_jobs"

ROOT = File.expand_path("../../../../..", __dir__)
REDIS_URL = ENV.fetch("REDIS_URL", "redis://127.0.0.1:6379/13")
abort "Refusing to run against db 0" unless REDIS_URL.match?(%r{/\d+\z}) && !REDIS_URL.end_with?("/0")

module Rails
  def self.env = Struct.new(:test?).new(false)
end
NODE_OWNED = %w[NodeOwnedBulkJob].freeze
ENV["NODE_OWNED_JOBS_PATH"] = File.join(Dir.mktmpdir, "node-owned.json").tap { File.write(_1, JSON.generate(NODE_OWNED)) }
ENV["NODE_OWNED_MAILERS_PATH"] = File.join(Dir.mktmpdir, "node-owned-mailers.json").tap { File.write(_1, "[]") }
require File.join(ROOT, "lib/sidekiq_node_bridge")

Sidekiq.configure_client do |config|
  config.redis = { url: REDIS_URL }
  config.client_middleware do |chain|
    chain.add SidekiqUniqueJobs::Middleware::Client
    chain.add SidekiqNodeBridge
  end
end
Sidekiq.default_job_options = { "backtrace" => true, "retry" => 25 }

def sidekiq_options_source(path)
  program = Prism.parse(File.read(File.join(ROOT, path))).value
  stack = [program]
  until stack.empty?
    node = stack.shift
    return node.slice if node.is_a?(Prism::CallNode) && node.name == :sidekiq_options
    stack.concat(node.compact_child_nodes)
  end
  raise "no sidekiq_options in #{path}"
end

class SendToElasticsearchWorker
  include Sidekiq::Job
  LOCK_TTL = 600
  class MarkForTrailingRun < SidekiqUniqueJobs::OnConflict::Strategy
    def call
      Sidekiq.redis { |redis| redis.call("SET", SendToElasticsearchWorker.trailing_key(item["args"]), "1", "EX", LOCK_TTL) }
    end
  end
  SidekiqUniqueJobs.config.add_strategy(:mark_for_trailing_run, MarkForTrailingRun)
  def self.trailing_key(args) = "send_to_elasticsearch_worker:trailing:#{Digest::SHA1.hexdigest(args.to_json)}"
end
require "digest"
require "active_support"
require "active_support/core_ext/object/json"
require "active_support/core_ext/numeric/time"
SendToElasticsearchWorker.class_eval(sidekiq_options_source("app/sidekiq/send_to_elasticsearch_worker.rb").sub("LOCK_TTL.to_i", "LOCK_TTL"))

{
  "UpdateCachedSalesRelatedProductsInfosJob" => "app/sidekiq/update_cached_sales_related_products_infos_job.rb",
  "UpdateUserBalanceStatsCacheWorker" => "app/sidekiq/update_user_balance_stats_cache_worker.rb",
  "PushNotificationWorker" => "app/sidekiq/push_notification_worker.rb",
}.each do |name, path|
  klass = Class.new { include Sidekiq::Job }
  Object.const_set(name, klass)
  klass.class_eval(sidekiq_options_source(path))
end

class NodeOwnedBulkJob
  include Sidekiq::Job
  sidekiq_options retry: 2, queue: :low, lock: :until_executed
end

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
      if key == "uniquejobs:changelog"
        next [key, { "type" => type, "messages" => value.map { |(json, _)| JSON.parse(json)["message"] }, "expires" => conn.call("PTTL", key).positive? }]
      end
      [key, { "type" => type, "value" => value, "expires" => conn.call("PTTL", key).positive? }]
    end
  end
end

NOW_I = FIXED_NOW.to_i
REINDEX_ARGS = [[1, "update", ["is_recommendable"]], [2, "update", %w[sales_volume total_fee_cents past_year_fee_cents is_recommendable]]].freeze

# Each case: "push" is the hash given to Sidekiq::Client.push_bulk (its "class" a class name here),
# or "perform_bulk" calls Klass(.set(set)).perform_bulk(args, batch_size:). "before" runs first.
CASES = [
  { "name" => "Integer at that is not in the future still schedules", "push" => { "class" => "SendToElasticsearchWorker", "args" => REINDEX_ARGS, "queue" => "low", "at" => NOW_I } },
  { "name" => "Integer at in the future", "push" => { "class" => "SendToElasticsearchWorker", "args" => REINDEX_ARGS, "queue" => "low", "at" => NOW_I + 60 } },
  { "name" => "duplicate args in one bulk mark a trailing run", "push" => { "class" => "SendToElasticsearchWorker", "args" => [REINDEX_ARGS[0], REINDEX_ARGS[0], REINDEX_ARGS[1]], "queue" => "low", "at" => NOW_I + 60 } },
  { "name" => "an existing lock drops that item only", "before" => [["SendToElasticsearchWorker", REINDEX_ARGS[1]]], "push" => { "class" => "SendToElasticsearchWorker", "args" => REINDEX_ARGS, "queue" => "low", "at" => NOW_I } },
  { "name" => "an Array of Float ats", "push" => { "class" => "UpdateUserBalanceStatsCacheWorker", "args" => [[7], [8], [9]], "at" => [FIXED_NOW.to_f, FIXED_NOW.to_f + 1.2, FIXED_NOW.to_f + 2.4] } },
  { "name" => "an Array of Integer ats with a queue", "push" => { "class" => "UpdateCachedSalesRelatedProductsInfosJob", "args" => [[3], [4]], "queue" => "low", "at" => [NOW_I + 259_200, NOW_I + 300_000] } },
  { "name" => "no at goes to the queue", "push" => { "class" => "UpdateCachedSalesRelatedProductsInfosJob", "args" => [[3], [4], [5]] } },
  { "name" => "no at with a unique lock", "push" => { "class" => "UpdateUserBalanceStatsCacheWorker", "args" => [[7], [7], [8]] } },
  { "name" => "batches of two", "push" => { "class" => "UpdateUserBalanceStatsCacheWorker", "args" => [[1], [2], [3]], "batch_size" => 2, "at" => NOW_I + 5 } },
  { "name" => "perform_bulk with set queue", "perform_bulk" => { "class" => "PushNotificationWorker", "set" => { "queue" => "low" }, "args" => [["a", 1], ["b", 2]] } },
  { "name" => "perform_bulk with batch_size", "perform_bulk" => { "class" => "UpdateUserBalanceStatsCacheWorker", "args" => [[1], [2], [3]], "batch_size" => 2 } },
  { "name" => "a given jid is replaced", "push" => { "class" => "UpdateCachedSalesRelatedProductsInfosJob", "args" => [[3]], "jid" => "abc" } },
  { "name" => "no args", "push" => { "class" => "UpdateCachedSalesRelatedProductsInfosJob", "args" => [], "at" => NOW_I } },
  { "name" => "at 0 is truthy", "push" => { "class" => "UpdateCachedSalesRelatedProductsInfosJob", "args" => [[3]], "at" => 0 } },
  { "name" => "Node-owned class goes to the bridge", "push" => { "class" => "NodeOwnedBulkJob", "args" => [[1], [1], [2]], "at" => NOW_I + 30 } },
  { "name" => "empty at Array", "push" => { "class" => "UpdateCachedSalesRelatedProductsInfosJob", "args" => [[3]], "at" => [] } },
  { "name" => "at Array of the wrong size", "push" => { "class" => "UpdateCachedSalesRelatedProductsInfosJob", "args" => [[3], [4]], "at" => [NOW_I] } },
  { "name" => "at that is not Numeric", "push" => { "class" => "UpdateCachedSalesRelatedProductsInfosJob", "args" => [[3]], "at" => "soon" } },
  { "name" => "jid with several jobs", "push" => { "class" => "UpdateCachedSalesRelatedProductsInfosJob", "args" => [[3], [4]], "jid" => "abc" } },
  { "name" => "a bad later slice raises after the first is pushed", "push" => { "class" => "UpdateCachedSalesRelatedProductsInfosJob", "args" => [[3], [4], 5], "batch_size" => 2 } },
].freeze

results = CASES.map do |c|
  flush!
  $jid_seq = 0
  (c["before"] || []).each { |klass, args| Object.const_get(klass).perform_async(*args) }
  error = nil
  jids = nil
  begin
    if (push = c["push"])
      jids = Sidekiq::Client.push_bulk(push.merge("class" => Object.const_get(push["class"])))
    else
      bulk = c["perform_bulk"]
      klass = Object.const_get(bulk["class"])
      target = bulk["set"] ? klass.set(bulk["set"].transform_keys(&:to_sym)) : klass
      jids = bulk["batch_size"] ? target.perform_bulk(bulk["args"], batch_size: bulk["batch_size"]) : target.perform_bulk(bulk["args"])
    end
  rescue ArgumentError => e
    error = { "class" => e.class.name, "message" => e.message }
  end
  c.merge("jids" => jids, "error" => error, "redis" => snapshot)
end

flush!
File.write(
  File.join(__dir__, "push-bulk.golden.json"),
  JSON.pretty_generate(
    "generated_with" => { "ruby" => RUBY_VERSION, "sidekiq" => Sidekiq::VERSION, "sidekiq_unique_jobs" => SidekiqUniqueJobs::VERSION },
    "now" => FIXED_NOW.to_f,
    "node_owned" => NODE_OWNED,
    "cases" => results,
  ) + "\n",
)
puts "wrote #{results.size} push_bulk cases"
