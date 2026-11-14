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
  { name: "dynamic registration cursor", method: "POST", path: "/cursor/v1/oauth2/register" },
  { name: "sales past page ten", method: "GET", path: "/v2/sales?page=11" },
  { name: "sales on page ten", method: "GET", path: "/v2/sales?page=10" },
  { name: "mobile download", method: "GET", path: "/mobile/url_redirects/download/tok/file.json" },
  { name: "user custom html patch", method: "PATCH", path: "/api/v2/user/custom_html", authorization: "Bearer abc123" },
  { name: "user custom html put by param", method: "PUT", path: "/v2/user/custom_html?access_token=xyz" },
  { name: "user preview", method: "POST", path: "/v2/user/preview_custom_html", authorization: "bearer tok" },
  { name: "media", method: "POST", path: "/v2/media", authorization: "Bearer MediaTOKEN " },
  { name: "product create", method: "POST", path: "/v2/products" },
  { name: "product comps", method: "GET", path: "/api/v2/products/comps", authorization: "Bearer comps" },
  { name: "product preview", method: "POST", path: "/v2/products/p/preview_custom_html", authorization: "Bearer prev" },
  { name: "root", method: "GET", path: "/" },
  { name: "mobile purchases index", method: "GET", path: "/mobile/purchases/index.json" },
  { name: "discover search", method: "GET", path: "/discover_search" },
  { name: "purchases", method: "GET", path: "/purchases" },
  { name: "stripe setup intents", method: "POST", path: "/stripe/setup_intents" },
  { name: "credit card", method: "PUT", path: "/settings/credit_card" },
  { name: "help contact", method: "POST", path: "/help/contact.xml" },
  { name: "purchase refund request", method: "POST", path: "/purchases/abc/refund_request.json" },
  { name: "purchase refund request with a nested id", method: "POST", path: "/purchases/a/b/refund_request" },
  { name: "oauth device code", method: "POST", path: "/oauth/device/code" },
  { name: "oauth device lookup", method: "GET", path: "/oauth/device" },
  { name: "oauth device decision", method: "POST", path: "/oauth/device.json" },
  { name: "oauth token alias", method: "POST", path: "/claude/v1/oauth2/token" },
  { name: "oauth token antigravity alias", method: "POST", path: "/antigravity/v1/oauth2/token.json" },
  { name: "resend receipt", method: "POST", path: "/purchases/abc/resend_receipt" },
  { name: "resend receipt with a format", method: "POST", path: "/service_charges/abc/resend_receipt.json" },
  { name: "resend receipt with a nested id", method: "POST", path: "/purchases/a/b/resend_receipt" },
  { name: "oauth device grant", method: "POST", path: "/oauth/token?grant_type=urn:ietf:params:oauth:grant-type:device_code&device_code=Abc" },
  { name: "oauth token other grant", method: "POST", path: "/oauth/token?grant_type=password" },
  { name: "totp confirm signed out", method: "POST", path: "/settings/totp/confirm" },
  { name: "passkey registration options signed out", method: "POST", path: "/settings/passkeys/registration_options" },
  { name: "marketing execute signed out", method: "POST", path: "/products/p/marketing_actions/m/execute.json" },
  { name: "passkey login options", method: "POST", path: "/login/passkey/options" },
  { name: "passkey login", method: "POST", path: "/login/passkey.json" },
  { name: "affiliate requests", method: "POST", path: "/seller/affiliate_requests" },
  { name: "ai product details", method: "POST", path: "/internal/ai_product_details_generations" },
  { name: "acme challenge", method: "GET", path: "/.well-known/acme-challenge/Tok_en" },
  { name: "product put without a token", method: "PUT", path: "/v2/products/p" },
  { name: "product patch with a param token", method: "PATCH", path: "/api/v2/products/p.json?access_token=Tok" },
  { name: "facebook", method: "GET", path: "/users/auth/facebook" },
  { name: "brand accounts", method: "POST", path: "/sellers/brand_accounts.json" },
  { name: "settings put", method: "PUT", path: "/settings" },
  { name: "signup", method: "GET", path: "/signup" },
  { name: "invalid percent encoding", method: "GET", path: "/discover", query: "a=%zz" },
  { name: "invalid utf-8", method: "GET", path: "/p", query: "a=%ff" },
  { name: "too many pairs", method: "GET", path: "/p", query: Array.new(4097) { |i| "k#{i}=1" }.join("&") },
  { name: "pairs at the limit", method: "GET", path: "/p", query: Array.new(4096) { |i| "k#{i}=1" }.join("&") },
  { name: "nested one past the limit", method: "GET", path: "/p", query: "a#{"[b]" * 33}=1" },
  { name: "nested at the limit", method: "GET", path: "/p", query: "a#{"[b]" * 32}=1" },
  { name: "nested a level below the limit", method: "GET", path: "/p", query: "a#{"[b]" * 31}=1" },
  { name: "invalid percent encoding in a key", method: "GET", path: "/p", query: "a%=1" }
].freeze

# The login, signup and settings rules exist only when Rails.env.production?, and the initializer reads that once at boot: load it again as production,
# so the golden holds them too (they come last, after the rules registered at boot).
%i[GROUPED_RECEIPT_LOOKUP_PATHS PASSWORD_RESET_PATH].each { |name| Rack::Attack.send(:remove_const, name) }
Rails.define_singleton_method(:env) { ActiveSupport::StringInquirer.new("production") }
load Rails.root.join("config/initializers/rack_attack.rb")
Rails.singleton_class.send(:remove_method, :env)

throttles = Rack::Attack.configuration.throttles.map { |name, throttle| { name:, limit: throttle.limit, period: throttle.period } }

counts = CASES.map do |entry|
  Rack::Attack.cache.store.flushdb
  env = Rack::MockRequest.env_for(entry[:path], method: entry[:method], "HTTP_CF_CONNECTING_IP" => IP, "HTTP_AUTHORIZATION" => entry[:authorization])
  env["QUERY_STRING"] = entry[:query] if entry[:query]
  travel_to(FROZEN_AT) { Rack::Attack.configuration.throttled?(Rack::Attack::Request.new(env)) }
  redis = Rack::Attack.cache.store
  keys = redis.keys("rack::attack:*").sort.to_h { |key| [key, { value: redis.get(key).to_i, ttl: redis.ttl(key) }] }
  entry.slice(:name, :method, :path, :query, :authorization).merge(at: FROZEN_AT.to_i, ip: IP, keys:)
end
Rack::Attack.cache.store.flushdb

normalized_paths = ["/v2/sales/", "//v2///sales", "/v2/sales//", "/a%2fb", "/caf%c3%a9/x", "v2/sales", "", "/", "//"].to_h do |path|
  [path, Rack::Attack::PathNormalizer.normalize_path(path)]
end

puts "JSONSTART"
puts JSON.pretty_generate({ throttles:, counts:, normalized_paths: })
