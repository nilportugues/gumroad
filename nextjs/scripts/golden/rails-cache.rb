# frozen_string_literal: true

# Golden vectors for nextjs/src/server/cache: Marshal, ActiveSupport::Cache's 7.1 entry coder,
# MemCacheStore keys and store semantics, Dalli's value wrapping, TTLs and ring, and
# ActiveRecord's relation cache_key_with_version. Writes
# nextjs/src/server/cache/__fixtures__/rails-cache.golden.json.
#
# Needs activesupport/activerecord 8.1.3.1, sqlite3 and dalli 3.2.8 (Gemfile.lock) on GEM_PATH;
# no memcached: Dalli's protocol object is replaced by an in-process server that keeps what
# Dalli would have sent (key, marshalled value, flags, sanitized TTL).
#   GEM_PATH=... ruby nextjs/scripts/golden/rails-cache.rb
gem "activesupport", "8.1.3.1"
gem "activerecord", "8.1.3.1"
gem "dalli", "3.2.8"
require "json"
require "zlib"
require "active_support"
require "active_support/core_ext"
require "active_support/cache"
require "active_support/cache/mem_cache_store"
require "active_record"

OUT = File.expand_path("../../src/server/cache/__fixtures__/rails-cache.golden.json", __dir__)

# config.load_defaults 8.1 / config/application.rb / new_framework_defaults_7_1.rb.
ActiveSupport::Digest.hash_digest_class = OpenSSL::Digest::SHA256
ActiveSupport::Cache.format_version = 7.1
ActiveSupport::Cache::Store.raise_on_invalid_cache_expiration_time = true

$now = Time.at(1_761_955_200, 123_456, :usec)
class Time
  class << self
    alias_method :real_now, :now
    def now(...) = $now
  end
end

# Values travel as tagged JSON so both sides build the same objects from scratch.
def build(desc)
  case desc["t"]
  when "nil" then nil
  when "bool" then desc["v"]
  when "int" then Integer(desc["v"])
  when "float" then [desc["v"]].pack("H*").unpack1("G")
  when "str" then String.new(desc["v"], encoding: Encoding::UTF_8)
  when "bin" then [desc["v"]].pack("H*").force_encoding(Encoding::BINARY)
  when "ascii" then String.new(desc["v"], encoding: Encoding::US_ASCII)
  when "sym" then desc["v"].to_sym
  when "arr" then desc["v"].map { |e| build(e) }
  when "hash" then desc["v"].to_h { |k, v| [build(k), build(v)] }
  else raise "unknown #{desc}"
  end
end

def describe(value)
  case value
  when nil then { "t" => "nil" }
  when true, false then { "t" => "bool", "v" => value }
  when Integer then { "t" => "int", "v" => value.to_s }
  when Float then { "t" => "float", "v" => [value].pack("G").unpack1("H*") }
  when Symbol then { "t" => "sym", "v" => value.to_s }
  when String
    case value.encoding
    when Encoding::UTF_8 then { "t" => "str", "v" => value }
    when Encoding::BINARY then { "t" => "bin", "v" => value.unpack1("H*") }
    when Encoding::US_ASCII then { "t" => "ascii", "v" => value }
    else raise "encoding #{value.encoding}"
    end
  when Array then { "t" => "arr", "v" => value.map { |e| describe(e) } }
  when Hash then { "t" => "hash", "v" => value.map { |k, v| [describe(k), describe(v)] } }
  else raise "cannot describe #{value.class}"
  end
end

def hex(string) = string.b.unpack1("H*")

# --- Marshal ---------------------------------------------------------------------------------
ints = [0, 1, 4, 5, 122, 123, 124, -1, -4, -5, -123, -124, -125, 255, 256, -256, -257, 65_535, 65_536,
        2**24, -(2**24), 2**30 - 1, 2**30, -(2**30), -(2**30) - 1, 2**31, 2**32, 2**53 + 1, -(2**62), 2**64 + 5, 2**100]
floats = [0.0, -0.0, 1.0, 1.5, -2.25, 0.1, 100.0, 1e15, 1e16, 1e20, 123_456_789.125, 1e-4, 1e-5, 0.000_123_4,
          1e100, 5e-324, 1.7976931348623157e308, 1e-300, Float::INFINITY, -Float::INFINITY, Float::NAN, 2.5e-7, 12_345.678]
marshal_values = ints + floats + [
  nil, true, false, "", "hello", "ünïcødé ✓", "x" * 300, "\x00\xFF".b, "abc".encode("US-ASCII"), :a, :"ünï",
  [], [1, 2, 3], [:a, :a, :b, :a], [1.5, 1.5, 2.5, 1.5], [1e-300, 1e-300], %w[x x], [[1], [2]], [:"ünï", :"ünï", "é"],
  {}, { "a" => 1, "b" => [1, 2] }, { a: 1, b: "x" }, { url: "https://example.com/a.png", key: "abc" }, { 1 => 2, nil => true },
  [{ a: 1 }, { a: 2 }], [nil, true, false, :sym, "str", 1.5, 2**40, -0.0, 0.0, 0.0],
  [3, 40, 170],
]
marshal = marshal_values.map do |value|
  desc = describe(value)
  dumped = Marshal.dump(build(desc))
  { "value" => desc, "dump" => hex(dumped), "load" => describe(Marshal.load(dumped)) }
end

# --- Zlib -------------------------------------------------------------------------------------
lcg = 12_345
pseudo_random = Array.new(1500) { lcg = (lcg * 1_103_515_245 + 12_345) % 2**31; lcg >> 16 & 0xff }.pack("C*")
deflate_inputs = ["", "a", "abc" * 1000, Marshal.dump((1..500).to_a), pseudo_random, ("lorem ipsum dolor sit amet " * 80)]
deflate = deflate_inputs.map { |input| { "input" => hex(input), "output" => hex(Zlib::Deflate.deflate(input)) } }

# --- Entry coder + Dalli value ---------------------------------------------------------------
coder = ActiveSupport::Cache::Coder.new(ActiveSupport::Cache::SerializerWithFallback[:marshal_7_1], Zlib)
dalli_marshaller = Dalli::Protocol::ValueMarshaller.new(serializer: Marshal, compress: false)
entry_cases = [
  [[3, 40, 170], $now.to_f + 600, nil, 1024],
  ["hello", nil, nil, 1024],
  ["\x00\x01binary".b, nil, nil, 1024],
  ["ascii".encode("US-ASCII"), nil, nil, 1024],
  ["versioned", 1_761_955_260.5, "v1", 1024],
  ["empty version", nil, "", 1024],
  ["marshal-looking version", nil, "\x04\x08x", 1024],
  ["abc" * 1000, nil, nil, 1024],
  ["abc" * 1000, nil, nil, Float::INFINITY],
  [(1..500).to_a, nil, nil, 1024],
  [pseudo_random, nil, nil, 1024],
  [nil, nil, nil, 1024],
  [{ url: "u", key: "k" }, $now.to_f + 300, nil, 1024],
]
entries = entry_cases.map do |value, expires_at, version, threshold|
  entry = ActiveSupport::Cache::Entry.new(value, expires_at:, version:)
  dumped = coder.dump_compressed(entry, threshold)
  dalli_value, flags = dalli_marshaller.store("k", dumped, {})
  loaded = coder.load(dumped)
  {
    "value" => describe(value), "expires_at" => expires_at, "version" => version,
    "threshold" => threshold.infinite? ? nil : threshold,
    "coder" => hex(dumped), "dalli" => hex(dalli_value), "flags" => flags,
    "loaded" => { "value" => describe(loaded.value), "expires_at" => loaded.expires_at, "version" => loaded.version },
  }
end

# --- Keys -------------------------------------------------------------------------------------
Keyed = Struct.new(:cache_key, :cache_version)
def build_name(desc)
  case desc
  when Array then desc.map { |part| build_name(part) }
  when Hash then Keyed.new(desc["cacheKey"], desc["cacheVersion"])
  else desc
  end
end

key_names = [
  "plain", "with space and %percent", "ünï", "tab\tnew\nline\x01\x7F", "x" * 300, "é" * 130, "#{"y" * 240}é",
  ["a", 1, "b"], ["solo"], [{ "cacheKey" => "links/1", "cacheVersion" => "20251101" }, "sub", { "cacheKey" => "users/2", "cacheVersion" => nil }],
  { "cacheKey" => "links/query-abc", "cacheVersion" => "3-20251101000000123456" },
]
keys = [nil, "rev123"].flat_map do |namespace|
  store = ActiveSupport::Cache::MemCacheStore.new("127.0.0.1:11211", namespace:)
  key_names.map do |name|
    built = build_name(name)
    { "name" => name, "namespace" => namespace, "key" => store.send(:normalize_key, built, store.options),
      "version" => store.send(:normalize_version, built, {}) }
  end
end

# --- Relation cache key (sqlite stands in for MySQL; the composition is what is pinned) ------
ActiveRecord::Base.establish_connection(adapter: "sqlite3", database: ":memory:")
ActiveRecord::Schema.verbose = false
ActiveRecord::Schema.define { create_table(:links) { |t| t.integer :user_id; t.datetime :updated_at, precision: 6 } }
class Link < ActiveRecord::Base; end
Link.create!(user_id: 1, updated_at: Time.utc(2025, 10, 30, 12, 0, 0, 654_321))
Link.create!(user_id: 1, updated_at: Time.utc(2025, 11, 1, 9, 5, 7, 1_234))
Link.create!(user_id: 2, updated_at: Time.utc(2025, 11, 2))
relations = [Link.where(user_id: 1), Link.where(user_id: 3)].map do |relation|
  max = relation.maximum(:updated_at)
  { "model" => "links", "sql" => relation.to_sql, "size" => relation.count,
    "max_updated_at" => max && max.utc.iso8601(6), "key" => relation.cache_key_with_version }
end

# --- Dalli TTL and ring -------------------------------------------------------------------------
ttls = [0, 1, 600, 30 * 86_400, 30 * 86_400 + 1, 40 * 86_400, 1_761_955_200 + 99, 1_761_955_200 - 5].map do |ttl|
  { "ttl" => ttl, "now" => $now.to_f, "sanitized" => Dalli::Protocol::TtlSanitizer.sanitize(ttl) }
end

Dalli::Protocol::Binary.define_method(:alive?) { true }
ring_keys = Array.new(60) { |i| "rev123:key-#{i}" } + ["plain", "x" * 250, "seller_reputation_summary/v2/1"]
rings = [%w[10.0.0.1:11211 10.0.0.2:11211], %w[10.0.0.1:11211 10.0.0.2:11211 10.0.0.3:11212:2], %w[memcache-a memcache-b:11311 memcache-c]].map do |servers|
  ring = Dalli::Ring.new(servers, Dalli::Protocol::Binary, {})
  { "servers" => servers, "keys" => ring_keys.to_h { |key| [key, ring.server_for_key(key).name] } }
end

# --- Store flows against an in-process memcached ---------------------------------------------
$memcached = {}
$ops = []
module FakeMemcached
  def request(opkey, *args)
    now = Time.now.to_i
    $memcached.delete_if { |_, e| e[:expires_at] && e[:expires_at] <= now }
    case opkey
    when :get
      entry = $memcached[args[0]]
      $ops << ["get", args[0]]
      entry && @value_marshaller.retrieve(entry[:value], entry[:flags])
    when :set, :add
      key, value, ttl = args
      options = opkey == :set ? args[4] : args[3]
      stored_value, flags = @value_marshaller.store(key, value, options)
      exptime = Dalli::Protocol::TtlSanitizer.sanitize(ttl)
      $ops << [opkey.to_s, key, flags, exptime, hex(stored_value)]
      return false if opkey == :add && $memcached.key?(key)
      expires_at = exptime.zero? ? nil : (exptime <= 30 * 86_400 ? now + exptime : exptime)
      $memcached[key] = { value: stored_value, flags:, exptime:, expires_at: }
      1
    when :delete
      $ops << ["delete", args[0]]
      !$memcached.delete(args[0]).nil?
    else raise "unexpected #{opkey}"
    end
  end
end
Dalli::Protocol::Binary.prepend(FakeMemcached)

def ruby_options(options)
  map = { "expiresIn" => :expires_in, "version" => :version, "raceConditionTtl" => :race_condition_ttl, "skipNil" => :skip_nil,
          "unlessExist" => :unless_exist, "compress" => :compress, "force" => :force }
  options.to_h { |key, value| [map.fetch(key), value] }
end

rep_key = "seller_reputation_summary/v2/1/links/query-0123456789abcdef0123456789abcdef-2-20251101090507001234/7"
big_string = { "t" => "str", "v" => "abcdefghij" * 300 }
steps = [
  [0, "write", "plain", {}, { "t" => "str", "v" => "hello" }],
  [0, "read", "plain", {}],
  [0, "fetch", rep_key, { "expiresIn" => 600 }, describe([3, 40, 170])],
  [1, "fetch", rep_key, { "expiresIn" => 600 }, describe([9, 9, 9])],
  [1, "write", "versioned", { "version" => "v1" }, { "t" => "str", "v" => "v1 value" }],
  [1, "read", "versioned", { "version" => "v2" }],
  [1, "read", "versioned", { "version" => "v1" }],
  [1, "write", "big", { "expiresIn" => 3600 }, big_string],
  [1, "read", "big", {}],
  [1, "write", "bigarray", {}, describe((1..500).to_a)],
  [1, "write", "k" * 300, {}, describe({ a: 1, "b" => [true, nil] })],
  [1, "read", "k" * 300, {}],
  [601, "read", rep_key, {}],
  [601, "fetch", "race", { "expiresIn" => 60, "raceConditionTtl" => 10 }, { "t" => "str", "v" => "r1" }],
  [666, "fetch", "race", { "expiresIn" => 60, "raceConditionTtl" => 10 }, { "t" => "str", "v" => "r2" }],
  [666, "fetch", "skipnil", { "skipNil" => true }, { "t" => "nil" }],
  [666, "fetch", "nilval", {}, { "t" => "nil" }],
  [666, "read", "nilval", {}],
  [666, "write", "plain", { "unlessExist" => true }, { "t" => "str", "v" => "other" }],
  [666, "delete", "plain", {}],
  [666, "delete", "plain", {}],
  [666, "write", ["a", 1, "b"], {}, { "t" => "str", "v" => "arr" }],
  [666, "read", ["a", 1, "b"], {}],
  [666, "write", "long-ttl", { "expiresIn" => 40 * 86_400 }, describe(1)],
  [666, "write", "symhash", { "expiresIn" => 300 }, describe({ url: "x", key: "y" })],
  [666, "exist", "symhash", {}],
  [700, "exist", rep_key, {}],
  [700, "write", "nocompress", { "compress" => false }, big_string],
  [700, "fetch", "plain2", { "force" => true }, { "t" => "str", "v" => "forced" }],
  [700, "fetch", "plain2", {}, { "t" => "str", "v" => "unused" }],
  [700, "write", "ascii", {}, { "t" => "ascii", "v" => "only ascii" }],
  [700, "write", "binary", {}, { "t" => "bin", "v" => "00ff10" }],
  [700, "read", "binary", {}],
  [700, "write", "intversion", { "version" => 3 }, { "t" => "str", "v" => "three" }],
  [700, "read", "intversion", { "version" => "3" }],
  [700, "read", ["a", 1, "b"], { "version" => 4 }],
  [1000, "read", "symhash", {}],
]

store = ActiveSupport::Cache::MemCacheStore.new("127.0.0.1:11211", namespace: "rev123")
flow = steps.map do |offset, op, name, options, value|
  $now = Time.at(1_761_955_200 + offset, 123_456, :usec)
  $ops = []
  opts = ruby_options(options)
  block_ran = false
  result =
    case op
    when "write" then store.write(name, build(value), **opts)
    when "read"
      found = store.read(name, **opts)
      found.nil? && !store.exist?(name, **opts) ? "miss" : describe(found)
    when "fetch" then describe(store.fetch(name, **opts) { block_ran = true; build(value) })
    when "delete" then store.delete(name, **opts)
    when "exist" then store.exist?(name, **opts)
    end
  # exist? on a read miss is a second lookup, not part of the step.
  ops = op == "read" ? $ops.take_while.with_index { |entry, i| i.zero? || entry[0] != "get" } : $ops
  { "now" => $now.to_f, "op" => op, "name" => name, "options" => options, "value" => value, "result" => result,
    "block_ran" => block_ran, "ops" => ops,
    "memcached" => $memcached.sort.to_h { |key, e| [key, { "value" => hex(e[:value]), "flags" => e[:flags], "exptime" => e[:exptime] }] } }
end

File.write(OUT, JSON.pretty_generate(
  "generated_with" => { "ruby" => RUBY_VERSION, "activesupport" => ActiveSupport.version.to_s, "dalli" => Dalli::VERSION, "zlib" => Zlib.zlib_version },
  "marshal" => marshal, "deflate" => deflate, "entries" => entries, "keys" => keys, "relations" => relations,
  "ttls" => ttls, "rings" => rings, "flow" => flow,
) + "\n")
puts "wrote #{OUT}"
