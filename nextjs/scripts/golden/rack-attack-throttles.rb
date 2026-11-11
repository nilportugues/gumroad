# frozen_string_literal: true

# Writes parity/golden/rack-attack-throttles.json: every throttle of config/initializers/rack_attack.rb (name, limit, period, in definition order),
# the Redis key and TTL Rack::Attack writes for a request with the clock frozen, and the paths it normalizes.
#   RACK_ATTACK_REDIS_HOST=<a scratch Redis db> bundle exec rails runner nextjs/scripts/golden/rack-attack-throttles.rb \
#     | sed -n '/^JSONSTART$/,$p' | tail -n +2 > nextjs/parity/golden/rack-attack-throttles.json
require "json"
require "active_support/testing/time_helpers"

include ActiveSupport::Testing::TimeHelpers

FROZEN_AT = Time.at(1_700_000_000)
IP = "203.0.113.9"

CASES = [
  { name: "discover", method: "GET", path: "/discover" },
  { name: "dynamic registration", method: "POST", path: "/claude/v1/oauth2/register.json" },
  { name: "sales past page ten", method: "GET", path: "/v2/sales?page=11" },
  { name: "sales on page ten", method: "GET", path: "/v2/sales?page=10" },
  { name: "mobile download", method: "GET", path: "/mobile/url_redirects/download/tok/file.json" },
  { name: "user custom html patch", method: "PATCH", path: "/api/v2/user/custom_html", authorization: "Bearer abc123" },
  { name: "user custom html put by param", method: "PUT", path: "/v2/user/custom_html?access_token=xyz" },
  { name: "user preview", method: "POST", path: "/v2/user/preview_custom_html", authorization: "bearer tok" },
  { name: "media", method: "POST", path: "/v2/media", authorization: "Bearer MediaTOKEN " },
  { name: "product create", method: "POST", path: "/v2/products" },
  { name: "product comps", method: "GET", path: "/api/v2/products/comps", authorization: "Bearer comps" },
  { name: "product preview", method: "POST", path: "/v2/products/p/preview_custom_html", authorization: "Bearer prev" }
].freeze

throttles = Rack::Attack.configuration.throttles.map { |name, throttle| { name:, limit: throttle.limit, period: throttle.period } }

counts = CASES.map do |entry|
  Rack::Attack.cache.store.flushdb
  env = Rack::MockRequest.env_for(entry[:path], method: entry[:method], "HTTP_CF_CONNECTING_IP" => IP, "HTTP_AUTHORIZATION" => entry[:authorization])
  travel_to(FROZEN_AT) { Rack::Attack.configuration.throttled?(Rack::Attack::Request.new(env)) }
  redis = Rack::Attack.cache.store
  keys = redis.keys("rack::attack:*").sort.to_h { |key| [key, { value: redis.get(key).to_i, ttl: redis.ttl(key) }] }
  entry.slice(:name, :method, :path, :authorization).merge(at: FROZEN_AT.to_i, ip: IP, keys:)
end
Rack::Attack.cache.store.flushdb

normalized_paths = ["/v2/sales/", "//v2///sales", "/v2/sales//", "/a%2fb", "/caf%c3%a9/x", "v2/sales", "", "/", "//"].to_h do |path|
  [path, Rack::Attack::PathNormalizer.normalize_path(path)]
end

puts "JSONSTART"
puts JSON.pretty_generate({ throttles:, counts:, normalized_paths: })
