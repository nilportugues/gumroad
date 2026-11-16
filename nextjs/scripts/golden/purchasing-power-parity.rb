# frozen_string_literal: true

# Produces nextjs/src/server/models/__fixtures__/purchasing-power-parity.golden.json: PurchasingPowerParityService
# (get_factor, get_all_countries_factors, set_factor) and User#min_ppp_factor, run by the real service against a
# scratch Redis, with every Redis command it sent and the keys it left. Run like subscription-reminder-jobs.rb
# (scratch database and Redis db other than 0; the REDIS_HOST of the app is the one written to):
#
#   RAILS_ENV=test DATABASE_NAME=gumroad_ws52 TEST_DATABASE_NAME=gumroad_ws52 DISABLE_TEST_REDIS_ISOLATION=1 \
#     REDIS_HOST=127.0.0.1:6379/9 SIDEKIQ_REDIS_HOST=127.0.0.1:6379/9 RPUSH_REDIS_HOST=127.0.0.1:6379/9 \
#     RACK_ATTACK_REDIS_HOST=127.0.0.1:6379/9 bundle exec rails runner nextjs/scripts/golden/purchasing-power-parity.rb
abort "Refusing to run against Redis db 0" if ENV.fetch("REDIS_HOST").match?(%r{/0\z}) || !ENV.fetch("REDIS_HOST").match?(%r{/\d+\z})
abort "Refusing to run against #{ActiveRecord::Base.connection_db_config.database}" unless ActiveRecord::Base.connection_db_config.database.match?(/_ws\d+\z/)

OUT = Rails.root.join("nextjs/src/server/models/__fixtures__/purchasing-power-parity.golden.json")

# Every command redis-client sends, as the service's namespace sees it.
module CommandLog
  class << self
    attr_accessor :commands
  end

  def call(command, config)
    CommandLog.commands&.push(command.map(&:to_s))
    super
  end
end
RedisClient.register(CommandLog)

redis = Redis.new(url: "redis://#{ENV.fetch("REDIS_HOST")}")

cases = []
run = lambda do |name, call:, seed: {}, limit: nil, down: nil|
  redis.flushdb
  seed.each do |key, value|
    value.is_a?(Array) ? redis.rpush(key, value) : redis.set(key, value)
  end
  seller = User.new(purchasing_power_parity_limit: limit)
  subject = PurchasingPowerParityService.new
  if down
    error = down == "timeout" ? Redis::TimeoutError.new("Waited 1.0 seconds") : RedisClient::CannotConnectError.new("Connection refused")
    subject.define_singleton_method(:ppp_namespace) { raise error }
  end
  CommandLog.commands = []
  result = begin
    value = subject.public_send(*call.map { |arg| arg == "seller" ? seller : arg })
    { "value" => value.is_a?(Hash) ? value.to_a : value }
  rescue StandardError => e
    { "error" => { "class" => e.class.name, "message" => e.message } }
  end
  commands = CommandLog.commands
  CommandLog.commands = nil
  after = redis.keys("*").sort.to_h { |key| [key, redis.type(key) == "string" ? redis.get(key) : redis.lrange(key, 0, -1)] }
  # JSON cannot tell 1 from 1.0; the string the service stores can.
  cases << { "name" => name, "factor_to_s" => (call[2].to_s if call[0] == "set_factor"), "seed" => seed, "limit" => limit, "down" => down, "call" => call, "result" => result, "commands" => commands, "after" => after }
end

stored = ["0.5", "0.4", "1", "1.0", "0", "0.0", "", " ", "\t", "abc", "0.5abc", "1e-1", "1e2", ".7", "-0.3", " 0.7 ", "0.7 ", "1_0", "0x1A", "NaN", "Infinity", "1e400", "0.123456789012345678", "00.6", "+0.9", "0,5"]
[nil, 0, 20, 50, 80, 100, 150, -10].each do |limit|
  run.("get_factor: no country, limit #{limit.inspect}", call: ["get_factor", nil, "seller"], limit:)
  run.("get_factor: blank country, limit #{limit.inspect}", call: ["get_factor", "", "seller"], limit:)
  run.("get_factor: whitespace country, limit #{limit.inspect}", call: ["get_factor", "  ", "seller"], limit:)
  run.("get_factor: unset country, limit #{limit.inspect}", call: ["get_factor", "IN", "seller"], limit:)
  stored.each do |value|
    run.("get_factor: stored #{value.inspect}, limit #{limit.inspect}", call: ["get_factor", "IN", "seller"], seed: { "ppp:IN" => value }, limit:)
  end
end
run.("get_factor: the code is case sensitive", call: ["get_factor", "in", "seller"], seed: { "ppp:IN" => "0.3" })
run.("get_factor: other countries are not read", call: ["get_factor", "BR", "seller"], seed: { "ppp:IN" => "0.3", "ppp:BR" => "0.6" })
run.("get_factor: a key outside the namespace is not read", call: ["get_factor", "IN", "seller"], seed: { "IN" => "0.3" })
run.("get_factor: a code that is not a country", call: ["get_factor", "ZZ", "seller"], seed: { "ppp:ZZ" => "0.35" })
run.("get_factor: a code with a colon", call: ["get_factor", "I:N", "seller"], seed: { "ppp:I:N" => "0.35" })
run.("get_factor: a code with a glob character", call: ["get_factor", "I*", "seller"], seed: { "ppp:IN" => "0.35" })
run.("get_factor: a non-ASCII code", call: ["get_factor", "Ünï", "seller"], seed: { "ppp:Ünï" => "0.35" })
run.("get_factor: wrong type at the key", call: ["get_factor", "IN", "seller"], seed: { "ppp:IN" => ["a"] })
run.("get_factor: wrong type at the key, limit", call: ["get_factor", "IN", "seller"], seed: { "ppp:IN" => ["a"] }, limit: 30)
run.("get_factor: read times out", call: ["get_factor", "IN", "seller"], seed: { "ppp:IN" => "0.3" }, down: "timeout")
run.("get_factor: read times out, limit", call: ["get_factor", "IN", "seller"], seed: { "ppp:IN" => "0.3" }, down: "timeout", limit: 20)
run.("get_factor: connection refused", call: ["get_factor", "IN", "seller"], down: "refused", limit: 50)
run.("get_factor: no country reads nothing when Redis is down", call: ["get_factor", nil, "seller"], down: "timeout", limit: 50)

all_seed = { "ppp:IN" => "0.4", "ppp:BR" => "0.55", "ppp:US" => "1", "ppp:DE" => "", "ppp:FR" => " ", "ppp:JP" => "abc", "ppp:AR" => "0.2", "ppp:XK" => "0.45", "ppp:ZZ" => "0.1", "ppp:AD" => "-1" }
[nil, 0, 30, 60, 100].each do |limit|
  run.("get_all_countries_factors: limit #{limit.inspect}", call: ["get_all_countries_factors", "seller"], seed: all_seed, limit:)
  run.("get_all_countries_factors: nothing stored, limit #{limit.inspect}", call: ["get_all_countries_factors", "seller"], limit:)
end
run.("get_all_countries_factors: wrong type at a key", call: ["get_all_countries_factors", "seller"], seed: all_seed.merge("ppp:IN" => ["x"]), limit: 30)
run.("get_all_countries_factors: read times out", call: ["get_all_countries_factors", "seller"], seed: all_seed, down: "timeout", limit: 30)
run.("get_all_countries_factors: connection refused", call: ["get_all_countries_factors", "seller"], down: "refused")

[0.4, 1, 0.65, 0.0, 0.8, 0.45, 1.0, "0.5", 0.30000000000000004, 2].each do |factor|
  run.("set_factor: #{factor.inspect}", call: ["set_factor", "IN", factor])
end
run.("set_factor: overwrites", call: ["set_factor", "IN", 0.4], seed: { "ppp:IN" => "1" })
run.("set_factor: read back", call: ["set_factor", "BR", 0.55])
run.("set_factor: wrong type at the key", call: ["set_factor", "IN", 0.4], seed: { "ppp:IN" => ["a"] })

min_factors = [nil, 0, 1, 10, 25, 33, 50, 99, 100, 101, 250, -5].map do |limit|
  { "limit" => limit, "min_ppp_factor" => User.new(purchasing_power_parity_limit: limit).min_ppp_factor }
end

redis.flushdb
File.write(OUT, "{\n\"min_ppp_factors\": #{min_factors.to_json},\n\"cases\": [\n#{cases.map(&:to_json).join(",\n")}\n]\n}\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
