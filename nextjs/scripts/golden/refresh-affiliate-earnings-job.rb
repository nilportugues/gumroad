# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/refresh-affiliate-earnings-job.golden.json: RefreshAffiliateEarningsJob (and the block
# of its sidekiq_retries_exhausted) run by the real app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb), with
# Rails.cache (the test environment's memory store) spied on. Every read, write and delete of the cache is recorded under `cache_ops`
# with the value described the way rails-cache.golden.json describes it (a TimeWithZone as seconds and nanoseconds); the entries a case
# starts from are in `cache_before`. The clock is frozen at NOW, which has a sub-microsecond part. A failing sum is a Mysql2::Error
# injected on the statement that carries the MAX_EXECUTION_TIME hint. Run it like publish-scheduled-post.rb (env as there).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/refresh-affiliate-earnings-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45) + Rational(123_456_789, 1_000_000_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[affiliates purchases].freeze
CHARGEBACK_REVERSED = Purchase.flag_mapping["flags"][:chargeback_reversed]

Rails.logger = ActiveSupport::Logger.new(nil)

def desc_of(value)
  case value
  when nil then { "t" => "nil" }
  when true, false then { "t" => "bool", "v" => value }
  when Integer then { "t" => "int", "v" => value.to_s }
  when String then { "t" => "str", "v" => value }
  when Symbol then { "t" => "sym", "v" => value.to_s }
  when ActiveSupport::TimeWithZone then { "t" => "twz", "sec" => value.to_i.to_s, "nsec" => value.nsec }
  when Hash then { "t" => "hash", "v" => value.map { |k, v| [desc_of(k), desc_of(v)] } }
  else raise "cannot describe #{value.class}"
  end
end

def options_for(options)
  options = options.to_h
  options.to_h { |key, value| [key.to_s, value.respond_to?(:to_f) && !value.is_a?(TrueClass) && !value.is_a?(FalseClass) ? value.to_f : value] }
end

# Spies on the cache the job reaches through Rails.cache.
$cache_ops = []
$recording_cache = false
Rails.cache.singleton_class.prepend(Module.new do
  def read(name, options = nil)
    super.tap { |result| $cache_ops << ["read", name, desc_of(result)] if $recording_cache }
  end

  def write(name, value, options = nil)
    super.tap { |result| $cache_ops << ["write", name, desc_of(value), options_for(options), result] if $recording_cache }
  end

  def delete(name, options = nil)
    super.tap { |result| $cache_ops << ["delete", name, result] if $recording_cache }
  end
end)

# A failure of the sum, reported by MySQL for the statement that carries the optimizer hint.
$sum_error = nil
Mysql2::Client.prepend(Module.new do
  def query(sql, *rest, **options)
    if $sum_error && sql.include?("MAX_EXECUTION_TIME")
      error = Mysql2::Error.new($sum_error[:message], nil, $sum_error[:number], $sum_error[:sqlstate])
      RailsRecorder.record_error(sql, error)
      raise error
    end
    super
  end
end)

def affiliate_row(id, **overrides) = { id:, seller_id: 1, affiliate_user_id: 2, type: "DirectAffiliate", flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)

def purchase_row(id, affiliate: 7, credit: 100, **overrides)
  { id:, link_id: 1, seller_id: 1, email: "buyer#{id}@example.com", purchase_state: "successful", price_cents: 500, flags: 0,
    affiliate_id: affiliate, affiliate_credit_cents: credit, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

# Purchases the sum must keep (1 to 3) and drop (4 to 11).
PURCHASES = [
  purchase_row(1, credit: 100), purchase_row(2, credit: 250), purchase_row(3, credit: 40, chargeback_date: "2026-02-01 00:00:00", flags: CHARGEBACK_REVERSED),
  purchase_row(4, credit: 999, purchase_state: "failed"), purchase_row(5, credit: 999, price_cents: 0), purchase_row(6, credit: 999, stripe_refunded: true),
  purchase_row(7, credit: 999, chargeback_date: "2026-02-01 00:00:00"), purchase_row(8, credit: 999, affiliate: 8),
  purchase_row(9, credit: 999, affiliate: nil), purchase_row(10, credit: 5, stripe_refunded: false), purchase_row(11, credit: 999, purchase_state: "in_progress"),
].freeze

def now_twz = Time.zone.at(NOW)
def cached(cents, age = 6.minutes) = { cents:, computed_at: now_twz - age }

# `cache`: the entries the case starts with ([key, value, expires_in seconds or nil]).
def run(name, args = [7], affiliates: [affiliate_row(7)], purchases: PURCHASES, cache: [], sum_error: nil)
  $sum_error = sum_error
  before = nil
  result = capture(name, now: NOW, tables: TABLES, seed: { affiliates:, purchases: }, sidekiq: true, job: "RefreshAffiliateEarningsJob", args:) do
    $recording_cache = false
    cache.each { |key, value, expires_in| Rails.cache.write(key, value, expires_in: expires_in) }
    before = cache.map { |key, value, expires_in| [key, desc_of(value), expires_in&.to_f] }
    $cache_ops.clear
    $recording_cache = true
    RefreshAffiliateEarningsJob.new.perform(*args)
  ensure
    $recording_cache = false
  end
  result.delete("seed")
  result.merge("cache_before" => before || [], "cache_ops" => $cache_ops.dup)
end

def exhausted(name, args, affiliates: [affiliate_row(7)], cache: [])
  $sum_error = nil
  before = nil
  result = capture(name, now: NOW, tables: TABLES, seed: { affiliates: }, sidekiq: true, job: "RefreshAffiliateEarningsJob", args:, hook: true) do
    $recording_cache = false
    cache.each { |key, value, expires_in| Rails.cache.write(key, value, expires_in: expires_in) }
    before = cache.map { |key, value, expires_in| [key, desc_of(value), expires_in&.to_f] }
    $cache_ops.clear
    $recording_cache = true
    RefreshAffiliateEarningsJob.sidekiq_retries_exhausted_block.call({ "args" => args }, StandardError.new("boom"))
  ensure
    $recording_cache = false
  end
  result.delete("seed")
  result.merge("cache_before" => before || [], "cache_ops" => $cache_ops.dup)
end

VALUE_KEY = "affiliate/7/total_cents_earned"
CLAIM_KEY = "#{VALUE_KEY}/computing"
RUN_KEY = "#{VALUE_KEY}/refreshing"
TIMEOUT = { number: 3024, sqlstate: "HY000", message: "Query execution was interrupted, maximum statement execution time exceeded" }.freeze

cases = []
cases << run("an affiliate that does not exist", [99])
cases << run("an affiliate id of nil", [nil])
cases << run("an affiliate id given as a digit string", ["7"])
cases << run("an affiliate id given as a float", [7.0])
cases << run("an affiliate id given as a word", ["abc"])
cases << run("an empty cache computes the sum")
cases << run("an affiliate with no purchases", purchases: [])
cases << run("a sum past 2**30", purchases: [purchase_row(1, credit: 2_000_000_000), purchase_row(2, credit: 2_000_000_000), purchase_row(3, credit: nil)])
cases << run("a global affiliate", affiliates: [affiliate_row(7, type: "GlobalAffiliate")])
cases << run("a collaborator", affiliates: [affiliate_row(7, type: "Collaborator")])
cases << run("a deleted affiliate", affiliates: [affiliate_row(7, deleted_at: SEEDED_AT)])
cases << run("a value cached a minute ago", cache: [[VALUE_KEY, cached(900, 1.minute), 86_400]])
cases << run("a value cached just under five minutes ago", cache: [[VALUE_KEY, cached(900, 5.minutes - Rational(1, 1_000_000_000)), 86_400]])
cases << run("a value cached exactly five minutes ago", cache: [[VALUE_KEY, cached(900, 5.minutes), 86_400]])
cases << run("a value cached just over five minutes ago", cache: [[VALUE_KEY, cached(900, 5.minutes + Rational(1, 1_000_000_000)), 86_400]])
cases << run("a value cached an hour ago", cache: [[VALUE_KEY, cached(900, 1.hour), 86_400]])
cases << run("a zero cached an hour ago", cache: [[VALUE_KEY, cached(0, 1.hour), 86_400]])
cases << run("a value cached in the future", cache: [[VALUE_KEY, cached(900, -10.minutes), 86_400]])
cases << run("a stale value with a nil computed_at", cache: [[VALUE_KEY, { cents: 900, computed_at: nil }, 86_400]])
cases << run("a stale value without computed_at", cache: [[VALUE_KEY, { cents: 900 }, 86_400]])
cases << run("a cached hash without cents", cache: [[VALUE_KEY, { computed_at: now_twz - 1.minute }, 86_400]])
cases << run("a cached value that is not a hash", cache: [[VALUE_KEY, 900, 86_400]])
cases << run("a cached hash with a string key", cache: [[VALUE_KEY, { "cents" => 900 }, 86_400]])
cases << run("a stale value, a claim held by a request", cache: [[VALUE_KEY, cached(900), 86_400], [CLAIM_KEY, true, 3]])
cases << run("an empty cache, a claim held by a request", cache: [[CLAIM_KEY, true, 3]])
cases << run("a stale value, another worker running", cache: [[VALUE_KEY, cached(900), 86_400], [RUN_KEY, true, 600]])
cases << run("an empty cache, another worker running", cache: [[RUN_KEY, true, 600]])
cases << run("a stale value, another worker running and a claim", cache: [[VALUE_KEY, cached(900), 86_400], [RUN_KEY, true, 600], [CLAIM_KEY, true, 3]])
cases << run("a fresh value, another worker running", cache: [[VALUE_KEY, cached(900, 1.minute), 86_400], [RUN_KEY, true, 600]])
cases << run("the run lock of another affiliate", cache: [["affiliate/8/total_cents_earned/refreshing", true, 600]])
cases << run("the sum times out", sum_error: TIMEOUT)
cases << run("the sum times out on a stale value", cache: [[VALUE_KEY, cached(900), 86_400]], sum_error: TIMEOUT)
cases << run("the sum loses its connection", sum_error: { number: 2013, sqlstate: "HY000", message: "Lost connection to MySQL server during query" })
cases << run("the sum times out behind a claim", cache: [[CLAIM_KEY, true, 3]], sum_error: TIMEOUT)
cases << exhausted("retries exhausted", [7])
cases << exhausted("retries exhausted with a claim held", [7], cache: [[CLAIM_KEY, true, 600]])
cases << exhausted("retries exhausted for an affiliate that does not exist", [99])
cases << exhausted("retries exhausted with an id of nil", [nil])
cases << exhausted("retries exhausted with a digit string id", ["7"])

File.write(OUT, JSON.pretty_generate({ "now" => { "sec" => NOW.to_i, "nsec" => NOW.nsec }, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
