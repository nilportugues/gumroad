# frozen_string_literal: true

# Produces reputation.golden.json: app/sidekiq/warm_seller_reputation_summary_job.rb over the real
# User::ReputationSummary, Feature/Flipper 1.3 on flipper-redis, and a MemCacheStore whose Dalli
# protocol object is an in-process server (as nextjs/scripts/golden/rails-cache.rb does). SQL goes
# through ActiveRecord 8.1's Mysql2Adapter with only the driver faked (fake_mysql.rb).
#
#   G=<scratchpad>; GEM_HOME=$G/gemhome GEM_PATH=$G/gemhome:$G/ws05-gems:$G/bd331:$G/dalli-gems:$G/gems \
#     REDIS_URL=redis://127.0.0.1:6379/8 ruby generate-reputation-golden.rb
gem "bigdecimal", "3.3.1"
gem "connection_pool", "2.5.5"
gem "json", "2.13.2"
gem "activerecord", "8.1.3.1"
gem "sidekiq", "7.3.4"
gem "redis-client", "0.22.2"
gem "redis", "5.2.0"
gem "flipper", "1.3.0"
gem "flipper-redis", "1.3.0"
gem "dalli", "3.2.8"
ENV["TZ"] = "UTC"
require "json"
require "logger"
require "pathname"
require "active_record"
require "active_support/all"
require "active_support/cache/mem_cache_store"
require "flag_shih_tzu"
require "sidekiq"
require "redis"
require "flipper"
require "flipper/adapters/redis"
require_relative "fake_mysql"

ROOT = File.expand_path("../../../../..", __dir__)
REDIS_URL = ENV.fetch("REDIS_URL", "redis://127.0.0.1:6379/12")
abort "Refusing to run against db 0" unless REDIS_URL.match?(%r{/\d+\z}) && !REDIS_URL.end_with?("/0")

FIXED_NOW = Time.at(1_761_955_200, 123_000, :usec).utc
class Time
  class << self
    def now(...) = FIXED_NOW
  end
end

module Rails
  def self.root = Pathname(ROOT)
  def self.logger = (@logger ||= Logger.new(nil))
  def self.env = ActiveSupport::StringInquirer.new("test")
  def self.cache = $cache
end
ActiveRecord.default_timezone = :utc
Time.zone_default = Time.find_zone!("UTC")
Time.zone = "UTC"
ActiveSupport::Digest.hash_digest_class = OpenSSL::Digest::SHA256
ActiveSupport::Cache.format_version = 7.1
ActiveSupport::Cache::Store.raise_on_invalid_cache_expiration_time = true

schema = FakeMysql::SchemaCapture.load(File.join(ROOT, "db/schema.rb"))
FakeMysql.schema = schema.tables
FakeMysql.indexes = schema.indexes
ActiveRecord::Base.logger = nil
ActiveRecord::Base.establish_connection(adapter: "mysql2", database: "gumroad_test", encoding: "utf8mb4", collation: "utf8mb4_unicode_ci")
ActiveRecord::ConnectionAdapters::Mysql2Adapter.class_eval { private def default_type(*) = :literal }

$redis = Redis.new(url: REDIS_URL)
Flipper.configure { |config| config.adapter { Flipper::Adapters::Redis.new($redis) } }
module ErrorNotifier
  def self.notify(*) = nil
end

# --- Rails.cache: MemCacheStore over an in-process memcached --------------------------------------
$memcached = {}
$ops = []
def hex(string) = string.b.unpack1("H*")
module FakeMemcached
  def request(opkey, *args)
    now = Time.now.to_i
    $memcached.delete_if { |_, e| e[:expires_at] && e[:expires_at] <= now }
    case opkey
    when :get
      $ops << ["get", args[0]]
      entry = $memcached[args[0]]
      entry && @value_marshaller.retrieve(entry[:value], entry[:flags])
    when :set, :add
      key, value, ttl = args
      options = opkey == :set ? args[4] : args[3]
      stored_value, flags = @value_marshaller.store(key, value, options)
      exptime = Dalli::Protocol::TtlSanitizer.sanitize(ttl)
      $ops << [opkey.to_s, key, flags, exptime, hex(stored_value)]
      return false if opkey == :add && $memcached.key?(key)
      $memcached[key] = { value: stored_value, flags:, exptime:, expires_at: exptime.zero? ? nil : now + exptime }
      1
    else raise "unexpected #{opkey}"
    end
  end
end
Dalli::Protocol::Binary.prepend(FakeMemcached)
Dalli::Protocol::Binary.define_method(:alive?) { true }
$cache = ActiveSupport::Cache::MemCacheStore.new("127.0.0.1:11211", namespace: "rev123")

# --- Models -------------------------------------------------------------------------------------
def load_app(path) = load(File.join(ROOT, path))
load_app("lib/utilities/feature.rb")

class ApplicationRecord < ActiveRecord::Base
  self.abstract_class = true
end
class Link < ApplicationRecord
  include FlagShihTzu
  link_source = File.read(File.join(ROOT, "app/models/link.rb"))
  class_eval(link_source[/^  has_flags .*?check_for_column: false\n/m])
  link_source.lines.grep(/\A  scope :(alive|not_draft), /).each { class_eval(_1) }
end
class ProductReviewStat < ApplicationRecord; end
class User < ApplicationRecord
  include Flipper::Identifier
  has_many :products, class_name: "Link"
end
load_app("app/modules/user/reputation_summary.rb")
User.include(User::ReputationSummary)
load_app("app/sidekiq/warm_seller_reputation_summary_job.rb")

# --- Cases --------------------------------------------------------------------------------------
def snapshot
  $redis.keys("*").sort.to_h do |key|
    value = $redis.type(key) == "hash" ? $redis.hgetall(key) : $redis.get(key)
    [key, { "value" => value, "ttl" => $redis.ttl(key) }]
  end
end

def memcached_contents = $memcached.sort.to_h { |key, e| [key, { "value" => hex(e[:value]), "flags" => e[:flags], "exptime" => e[:exptime] }] }

def rows(fields, *rows) = FakeMysql::Rows.new(fields, rows)

def script(*rules)
  rules = rules.map { |pattern, answer| [pattern, answer.is_a?(Array) ? answer.dup : answer] }
  lambda do |sql|
    rule = rules.find { |pattern, _| pattern.is_a?(Regexp) ? pattern.match?(sql) : sql.start_with?(pattern) }
    next nil unless rule
    answer = rule[1].is_a?(Array) ? rule[1].shift : rule[1]
    answer.respond_to?(:call) ? answer.call(sql) : answer
  end
end

# `redis` seeds $redis (Flipper docs, version counters) and `memcached` the cache, before the run.
def capture(name, responder, user_id: 5, redis: {}, runs: 1)
  $redis.flushdb
  redis.each { |key, value| value.is_a?(Hash) ? $redis.hset(key, value) : $redis.set(key, value) }
  $memcached.clear
  $ops = []
  error = nil
  statements = FakeMysql.run(responder) do
    runs.times { WarmSellerReputationSummaryJob.new.perform(user_id) }
  rescue StandardError => e
    error = { "class" => e.class.name, "message" => e.message }
  end
  { "name" => name, "args" => [user_id], "seed" => redis, "runs" => runs, "error" => error, "statements" => statements,
    "redis" => snapshot, "cache_ops" => $ops, "memcached" => memcached_contents }.compact
end

user = ["SELECT `users`.*", rows(%w[id], [5])]
t = ->(string, usec = 0) { Time.utc(*string.scan(/\d+/).map(&:to_i), usec) }
lifecycle = ->(size, time) { [/\ASELECT COUNT\(\*\) AS `size`/, rows(%w[size timestamp], [size, time])] }
aggregate = ->(*row) { [/\ASELECT COUNT\(\*\), SUM/, rows(["COUNT(*)", "SUM(reviews_count)", "SUM(weighted)"], row)] }
for_actor = { "seller_reputation_summary" => { "actors/User;5" => "1" } }
enabled = { "seller_reputation_summary" => { "boolean" => "true" } }

cases = [
  capture("user not found", script()),
  capture("feature off", script(user)),
  capture("feature on for the seller, first warm", script(user, lifecycle.(4, t["2025-10-30 08:15:02"]), aggregate.(3, BigDecimal(40), BigDecimal(170))), redis: for_actor),
  capture("feature on for everyone, version bumped", script(user, lifecycle.(4, t["2025-10-30 08:15:02"]), aggregate.(3, BigDecimal(40), BigDecimal(170))),
          redis: enabled.merge("seller_reputation_summary/version/5" => "7")),
  capture("seller without products", script(user, lifecycle.(0, nil), aggregate.(0, nil, nil)), redis: enabled),
  capture("second warm reads the cached aggregate", script([/\ASELECT `users`.*/, [rows(%w[id], [5]), rows(%w[id], [5])]],
                                                           [/\ASELECT COUNT\(\*\) AS `size`/, [rows(%w[size timestamp], [2, t["2025-01-01"]]), rows(%w[size timestamp], [2, t["2025-01-01"]])]],
                                                           aggregate.(2, BigDecimal(12), BigDecimal(50))), redis: enabled, runs: 2),
]

out = File.join(__dir__, "reputation.golden.json")
File.write(out, JSON.pretty_generate("now" => FIXED_NOW.to_f, "namespace" => "rev123", "cases" => cases) + "\n")
puts "wrote #{File.basename(out)}"
