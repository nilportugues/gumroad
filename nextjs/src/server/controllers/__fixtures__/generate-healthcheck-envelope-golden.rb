# frozen_string_literal: true

# Produces healthcheck-envelope.golden.json: what Rails sends for healthcheck requests through the
# full middleware stack, which the controller-spec parity fixtures cannot see (the session
# cookie and the CSRF token it carries, XSRF-TOKEN, Rack::ETag, SecureHeaders, Rack::Cors' Vary,
# Rack::Head, the subdomain redirect). Random values (the guid, the session id, the CSRF token)
# are recorded by shape, and the session by its decrypted contents.
#
# Runs inside the app, in the test environment, against a scratch database and Redis DB:
#
#   SECRET_KEY_BASE=healthcheck-envelope-golden RAILS_ENV=test DISABLE_SPRING=1 \
#     TEST_DATABASE_NAME=<scratch db> REDIS_HOST=127.0.0.1:6379/14 SIDEKIQ_REDIS_HOST=127.0.0.1:6379/14 \
#     bundle exec rails runner nextjs/src/server/controllers/__fixtures__/generate-healthcheck-envelope-golden.rb

raise "SECRET_KEY_BASE must be set so Node can read the sessions" unless Rails.application.secret_key_base == ENV["SECRET_KEY_BASE"]

APP_HOST = "app.test.gumroad.com:31337"
REDIRECT_CONFIG = "old-seller.example.com/healthcheck/payouts=https://new-seller.example.com/landing"
SESSION_KEY = Rails.application.config.session_options[:key]
VOLATILE_HEADERS = %w[date x-request-id x-runtime x-original-headers-class content-length set-cookie].freeze
GUID = /\A\h{8}-\h{4}-\h{4}-\h{4}-\h{12}\z/

def session_cookie_value(data)
  jar = ActionDispatch::Request.new(Rails.application.env_config.merge("HTTP_HOST" => APP_HOST)).cookie_jar
  jar.encrypted[SESSION_KEY] = { value: data, expires: 1.day.from_now }
  jar[SESSION_KEY]
end

def decrypt_session(value)
  env = Rails.application.env_config.merge("HTTP_HOST" => APP_HOST, "HTTP_COOKIE" => "#{SESSION_KEY}=#{Rack::Utils.escape(value)}")
  ActionDispatch::Request.new(env).cookie_jar.encrypted[SESSION_KEY]
end

def describe_cookie(line, session_csrf)
  pair, *attributes = line.split(/;\s*/)
  name, raw = pair.split("=", 2)
  value = Rack::Utils.unescape(raw.to_s)
  attributes = attributes.map do |attribute|
    key, time = attribute.split("=", 2)
    key.casecmp?("expires") ? "#{key}=<now+#{((Time.httpdate(time) - Time.now) / 3600).round}h>" : attribute
  end
  out = { "name" => name, "attributes" => attributes }
  case name
  when "_gumroad_guid"
    out["value"] = value.match?(GUID) ? "<uuid>" : value
  when "XSRF-TOKEN"
    out["value"] = "<masked csrf token>"
  when SESSION_KEY
    session = decrypt_session(value)
    out["session"] = session.to_h do |key, v|
      [key, case key
            when "session_id" then v.match?(/\A\h{32}\z/) ? "<hex32>" : v
            when "_csrf_token" then v == session_csrf ? "<request csrf token>" : (v.match?(/\A[\w-]{43}\z/) ? "<new csrf token>" : v)
            else v
            end]
    end
  else
    out["value"] = value
  end
  out
end

CASES = [
  { name: "index on the app host", path: "/healthcheck" },
  { name: "index on the instance IP", path: "/healthcheck", host: "10.0.34.160" },
  { name: "an action answering 503", path: "/healthcheck/paypal_balance" },
  { name: "an Accept header the request does not look like a browser's", path: "/healthcheck/stripe_balance", headers: { "Accept" => "*/*" } },
  { name: "a browser's Accept header", path: "/healthcheck/stripe_balance", headers: { "Accept" => "text/html,application/xhtml+xml,*/*;q=0.8" } },
  { name: "a foreign referrer", path: "/healthcheck/paypal_balance", headers: { "Referer" => "https://www.Google.com/search?q=gumroad" } },
  { name: "a referrer on the root domain", path: "/healthcheck/paypal_balance", headers: { "Referer" => "https://seller.test.gumroad.com:31337/l/abc" } },
  { name: "an _sref param", path: "/healthcheck/paypal_balance", query: "_sref=newsletter" },
  { name: "a visitor that already has a guid", path: "/healthcheck/paypal_balance", cookies: { "_gumroad_guid" => "11111111-2222-3333-4444-555555555555" } },
  {
    name: "a visitor with a session",
    path: "/healthcheck/paypal_balance",
    session: { "session_id" => "0123456789abcdef0123456789abcdef", "_csrf_token" => "Tz3yI4bH3Y3nCkdzG3Su6n7YXy6GQx2Fv8Z1g6gL8rQ", "signup_referrer" => "earlier.example.com", "cart_hint" => "kept" },
  },
  { name: "a HEAD request", method: :head, path: "/healthcheck" },
  { name: "If-None-Match with the current ETag", path: "/healthcheck", if_none_match: true },
  { name: "a host with a subdomain redirect", path: "/healthcheck/payouts", host: "old-seller.example.com", redirect: true },
  { name: "a subdomain redirect does not apply to index", path: "/healthcheck", host: "old-seller.example.com", redirect: true },
].freeze

namespace = Redis::Namespace.new(:subdomain_redirect_namespace, redis: $redis)
cases = CASES.map do |spec|
  $redis.del(RedisKey.paypal_topup_needed, RedisKey.stripe_balance_topup_needed)
  Rails.cache.clear
  spec[:redirect] ? namespace.set("subdomain_redirects_config", REDIRECT_CONFIG) : namespace.del("subdomain_redirects_config")

  session = ActionDispatch::Integration::Session.new(Rails.application)
  host = spec[:host] || APP_HOST
  session.host! host
  headers = (spec[:headers] || {}).dup
  cookies = (spec[:cookies] || {}).dup
  cookies[SESSION_KEY] = session_cookie_value(spec[:session]) if spec[:session]
  if spec[:if_none_match]
    probe = ActionDispatch::Integration::Session.new(Rails.application)
    probe.host! host
    probe.get spec[:path]
    headers["If-None-Match"] = probe.response.headers["etag"]
  end
  headers["Cookie"] = cookies.map { |k, v| "#{k}=#{Rack::Utils.escape(v)}" }.join("; ") if cookies.any?
  path = spec[:query] ? "#{spec[:path]}?#{spec[:query]}" : spec[:path]
  session.process(spec[:method] || :get, path, headers:)
  response = session.response

  response_headers = response.headers.to_h.transform_keys(&:downcase).except(*VOLATILE_HEADERS)
  response_headers["content-security-policy"] = "<present>" if response_headers.key?("content-security-policy")
  {
    "name" => spec[:name],
    "request" => {
      "method" => (spec[:method] || :get).to_s.upcase,
      "url" => "http://#{host}#{path}",
      "headers" => headers.transform_keys(&:downcase),
      "redirectConfig" => spec[:redirect] ? REDIRECT_CONFIG : nil,
    }.compact,
    "response" => {
      "status" => response.status,
      "headers" => response_headers.sort.to_h,
      "cookies" => Array(response.headers["set-cookie"]).map { describe_cookie(_1, spec.dig(:session, "_csrf_token")) },
      "body" => response.body,
    },
  }
end
namespace.del("subdomain_redirects_config")

File.write(
  File.join(__dir__, "healthcheck-envelope.golden.json"),
  JSON.pretty_generate({ "secretKeyBase" => ENV["SECRET_KEY_BASE"], "sessionKey" => SESSION_KEY, "cases" => cases }) + "\n"
)
puts "#{cases.size} cases"
