# frozen_string_literal: true

# Produces nextjs/src/server/models/concerns/__fixtures__/currency.golden.json: CurrencyHelper's
# get_rate / query_rate (Redis namespace plus the OpenExchangeRates request, answered by the local
# capture server), get_usd_cents, usd_cents_to_currency and formatted_dollar_amount, run by the real
# helper. Run like user-writes.rb (scratch database and Redis db 6, USE_DB_WORKER_REPLICAS=true).
require_relative "support/rails_cases"
require_relative "../../src/server/stripe/__fixtures__/capture_server"
include RailsCases

OUT = Rails.root.join("nextjs/src/server/models/concerns/__fixtures__/currency.golden.json")
NOW = Time.utc(2025, 11, 1, 12, 30, 45, 123_000)

SERVER = CaptureServer.new
Object.send(:remove_const, :CURRENCY_SOURCE)
CURRENCY_SOURCE = "http://127.0.0.1:#{SERVER.port}/api/latest.json?app_id=golden"

class Helper
  include CurrencyHelper
  attr_accessor :redis_down

  def currency_namespace
    raise Redis::CannotConnectError, "Connection refused" if redis_down

    super
  end
end

def json(body, status: 200) = [status, { "Content-Type" => "application/json" }, body.is_a?(String) ? body : body.to_json]

# A scenario is a list of steps, run in order on one helper so LAST_KNOWN_RATES carries over.
# step: { "call" => [method, *args], "redis" => { key => value } (set before), "down" => bool, "http" => [responses] }
def scenario(name, steps)
  helper = Helper.new
  CurrencyHelper::LAST_KNOWN_RATES.clear
  results = []
  result = capture(name, now: NOW, tables: [], sidekiq: true) do
    steps.each do |step|
      Redis.new(url: REDIS_URL).tap { |r| (step["redis"] || {}).each { |k, v| r.set(k, v) } }.close if step["redis"]
      SERVER.requests.clear
      SERVER.responses = (step["http"] || []).dup
      helper.redis_down = step["down"]
      method, *args = step["call"]
      kwargs = args.last.is_a?(Hash) ? args.pop.transform_keys(&:to_sym) : {}
      begin
        value = helper.public_send(method, *args, **kwargs)
        results << { "value" => value.is_a?(BigDecimal) ? value.to_s("F") : value }
      rescue StandardError => e
        results << { "error" => { "class" => e.class.name, "message" => e.message } }
      end
      results.last["http"] = SERVER.requests.map { _1.slice("method", "path", "query") }
    end
    nil
  end
  result.merge("steps" => steps, "results" => results)
end

RATES = { "base" => "USD", "rates" => { "CAD" => 1.3412, "JPY" => 149.5, "EUR" => 0.9234, "INR" => nil } }.freeze

cases = []
cases << scenario("usd needs no rate", [{ "call" => ["get_rate", "usd"] }])
cases << scenario("a rate cached in Redis", [{ "call" => ["get_rate", "cad"], "redis" => { "currencies:CAD" => "1.35" } }])
cases << scenario("a missing rate is fetched and cached", [{ "call" => ["get_rate", "cad"], "http" => [json(RATES)] }])
cases << scenario("a cached zero rate is refetched", [{ "call" => ["get_rate", "jpy"], "redis" => { "currencies:JPY" => "0" }, "http" => [json(RATES)] }])
cases << scenario("a failed fetch falls back to the cached value", [{ "call" => ["get_rate", "cad"], "redis" => { "currencies:CAD" => "-1" }, "http" => [json({}, status: 500)] }])
cases << scenario("a failed fetch with nothing cached", [{ "call" => ["get_rate", "cad"], "http" => [json("nope", status: 500)] }])
cases << scenario("a document without rates", [{ "call" => ["get_rate", "cad"], "redis" => { "currencies:CAD" => "0.0" }, "http" => [json({ "base" => "USD" })] }])
cases << scenario("a null rate", [{ "call" => ["get_rate", "inr"], "http" => [json(RATES)] }])
cases << scenario("a currency the document lacks", [{ "call" => ["get_rate", "zzz"], "http" => [json(RATES)] }])
cases << scenario("an integer rate", [{ "call" => ["get_rate", "krw"], "http" => [json({ "rates" => { "KRW" => 1300 } })] }])
cases << scenario("an exponent rate", [{ "call" => ["get_rate", "krw"], "http" => [json('{"rates":{"KRW":1.5e-7}}')] }])
cases << scenario("redis down with nothing remembered", [{ "call" => ["get_rate", "cad"], "down" => true }])
cases << scenario("redis down after the rate was read", [
  { "call" => ["get_rate", "cad"], "redis" => { "currencies:CAD" => "1.35" } },
  { "call" => ["get_rate", "cad"], "down" => true },
  { "call" => ["get_rate", "eur"], "down" => true },
])
cases << scenario("get_usd_cents converts with the cached rate", [
  { "call" => ["get_usd_cents", "cad", 1350], "redis" => { "currencies:CAD" => "1.35" } },
  { "call" => ["get_usd_cents", "jpy", 15_000], "redis" => { "currencies:JPY" => "149.5" } },
  { "call" => ["get_usd_cents", "usd", 15_000] },
])
cases << scenario("get_usd_cents with a zero rate", [
  { "call" => ["get_usd_cents", "cad", 100, { "rate" => 0.0 }] },
  { "call" => ["get_usd_cents", "cad", -100, { "rate" => 0.0 }] },
  { "call" => ["get_usd_cents", "cad", 0, { "rate" => 0.0 }] },
])
cases << scenario("usd_cents_to_currency converts with the cached rate", [
  { "call" => ["usd_cents_to_currency", "eur", 1000], "redis" => { "currencies:EUR" => "0.9234" } },
  { "call" => ["usd_cents_to_currency", "jpy", 1000], "redis" => { "currencies:JPY" => "149.5" } },
  { "call" => ["usd_cents_to_currency", "cad", 1000, 0.0] },
])

# Vectors with the rate given, so no Redis is involved.
rng = Random.new(44)
vectors = []
ties = [[1, 2.0], [3, 2.0], [5, 4.0], [1, 0.5], [7, 0.25], [1, 8.0], [250, 100.0], [15, 2.0]]
random = Array.new(400) do
  digits = rng.rand(1..17)
  [rng.rand(0..2_000_000_000), format("%.#{digits}g", rng.rand * 10**rng.rand(-3..4)).to_f]
end
helper = Helper.new
(ties + random).each do |quantity, rate|
  next if rate <= 0

  %w[cad jpy].each do |currency|
    vectors << { "currency" => currency, "quantity" => quantity, "rate" => rate,
                 "usd_cents" => helper.get_usd_cents(currency, quantity, rate:),
                 "to_currency" => helper.usd_cents_to_currency(currency, quantity, rate) }
  end
end

amounts = [0, 1, 5, 9, 10, 99, 100, 101, 1234, 100_000, 100_005, 123_456_789, 2_000_000_000, -1, -5, -99, -100, -1234, -123_456_789]
formatting = amounts.flat_map do |cents|
  [{}, { "with_currency" => true }, { "no_cents_if_whole" => false }, { "with_currency" => true, "no_cents_if_whole" => false }].map do |opts|
    { "cents" => cents, "options" => opts, "formatted" => helper.formatted_dollar_amount(cents, **opts.transform_keys(&:to_sym)) }
  end
end

File.write(OUT, JSON.pretty_generate({ "now" => Time.utc(2025, 11, 1, 12, 30, 45, 123_000).to_f, "cases" => cases, "vectors" => vectors, "formatting" => formatting }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases, #{vectors.size} vectors)"
