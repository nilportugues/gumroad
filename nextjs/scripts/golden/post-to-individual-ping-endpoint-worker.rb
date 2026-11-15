# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/post-to-individual-ping-endpoint-worker.golden.json:
# PostToIndividualPingEndpointWorker run by the real app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb).
# The POST itself (SsrfFilter's fetch_once) is what Node never makes: a case that reaches it is recorded up to there, a marker
# exception standing in for it, and Node hands it back whole. Hostnames are answered by a stubbed resolver so nothing touches DNS or
# the network. Run it like publish-scheduled-post.rb (env as there, USE_DB_WORKER_REPLICAS=true).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/post-to-individual-ping-endpoint-worker.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[users ping_deliveries].freeze
ENDPOINT = "https://example.com/ping"

Rails.logger = ActiveSupport::Logger.new(nil)

class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

SsrfFilter.singleton_class.prepend(Module.new do
  private

  def fetch_once(*, **) = raise(HandBackMarker)
end)

RESOLVED = { "example.com" => "93.184.216.34", "internal.example.com" => "10.0.0.5" }.freeze
Resolv.singleton_class.prepend(Module.new do
  def getaddresses(name) = RESOLVED.key?(name) ? [RESOLVED.fetch(name)] : super
end)

def user_row(id, **overrides)
  { id:, email: "seller#{id}@example.com", username: "seller#{id}", external_id: (1000 + id).to_s, recommendation_type: "own_products",
    user_risk_state: "compliant", flags: 0, confirmed_at: nil, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

PING = { "purchase_id" => 7, "subscription_id" => 9, "resource_name" => "sale" }.freeze
PARAMS = { "seller_id" => "abc", "product_name" => "Art", "retry_count" => 0 }.freeze

def run(name, post_url, params = PARAMS, content_type = "application/x-www-form-urlencoded", user_id = 1, ping = PING, users: [user_row(1)], arity: nil)
  args = [post_url, params, content_type, user_id, ping]
  args = args.first(arity) if arity
  hands_back = false
  result = capture(name, now: NOW, tables: TABLES, seed: { users: }, sidekiq: true, job: "PostToIndividualPingEndpointWorker", args:) do
    PostToIndividualPingEndpointWorker.new.perform(*args)
  rescue HandBackMarker
    hands_back = true
  end
  result.delete("seed")
  result.delete("rows")
  result.merge("hands_back" => hands_back)
end

cases = []
# Verdicts reached from the URL alone, no DNS and no connection.
cases << run("a scheme other than http and https", "ftp://example.com/ping")
cases << run("a scheme other than http and https with a port and a path", "gopher://example.com:7070/a/b-c_d.e~f")
cases << run("a scheme other than http and https and no user", "ftp://example.com/ping", PARAMS, "application/x-www-form-urlencoded", nil, nil)
cases << run("a scheme other than http and https and no ping", "ftp://example.com/ping", PARAMS, "application/x-www-form-urlencoded", 1, nil)
cases << run("a scheme other than http and https and a ping that is not a Hash", "ftp://example.com/ping", PARAMS, "application/x-www-form-urlencoded", 1, "sale")
cases << run("a scheme other than http and https and an empty ping", "ftp://example.com/ping", PARAMS, "application/x-www-form-urlencoded", 1, {})
cases << run("a scheme other than http and https and a ping with symbol keys of the resource", "ftp://example.com/ping", PARAMS, "application/x-www-form-urlencoded", 1, { resource_name: "cancellation" })
cases << run("a scheme other than http and https and a blank resource name", "ftp://example.com/ping", PARAMS, "application/x-www-form-urlencoded", 1, { "resource_name" => "" })
cases << run("a scheme other than http and https and a user that does not exist", "ftp://example.com/ping", PARAMS, "application/x-www-form-urlencoded", 2)
cases << run("a scheme other than http and https for a user who signs pings", "ftp://example.com/ping", PARAMS, "application/x-www-form-urlencoded", 1, PING, users: [user_row(1, notification_endpoint: "ftp://example.com/ping")])
cases << run("a scheme other than http and https with JSON content", "ftp://example.com/ping", PARAMS, "application/json")
cases << run("a scheme other than http and https with another content type", "ftp://example.com/ping", PARAMS, "text/plain")
cases << run("a scheme other than http and https on the second retry", "ftp://example.com/ping", PARAMS.merge("retry_count" => 2))
cases << run("a scheme other than http and https on the last retry", "ftp://example.com/ping", PARAMS.merge("retry_count" => 3))
cases << run("a scheme other than http and https with no retry count", "ftp://example.com/ping", PARAMS.except("retry_count"))
cases << run("a scheme other than http and https with a nil retry count", "ftp://example.com/ping", PARAMS.merge("retry_count" => nil))
cases << run("a scheme other than http and https with brackets in the parameter names", "ftp://example.com/ping", { "a[b]" => { "c" => [1, 2] }, "retry_count" => 1 })
cases << run("a scheme other than http and https and a ping with ids that are Strings", "ftp://example.com/ping", PARAMS, "application/x-www-form-urlencoded", 1, { "purchase_id" => "7", "subscription_id" => "9", "resource_name" => "sale" })
cases << run("a scheme other than http and https and a ping with nil ids", "ftp://example.com/ping", PARAMS, "application/x-www-form-urlencoded", 1, { "purchase_id" => nil, "subscription_id" => nil, "resource_name" => nil })
cases << run("a scheme other than http and https and a user id given as a String", "ftp://example.com/ping", PARAMS, "application/x-www-form-urlencoded", "1")
cases << run("a scheme other than http and https and an endpoint past the column's length", "ftp://example.com/#{"a" * 260}")
cases << run("a scheme other than http and https and a job enqueued without a ping argument", "ftp://example.com/ping", PARAMS, "application/x-www-form-urlencoded", 1, nil, arity: 4)
cases << run("a scheme other than http and https and a job enqueued with the first two arguments", "ftp://example.com/ping", PARAMS, nil, nil, nil, arity: 2)

%w[10.0.0.1 127.0.0.1 192.168.1.20 169.254.169.254 0.0.0.0 100.64.0.1 100.127.255.255 172.16.0.1 172.17.0.1 172.20.1.1 192.0.0.255 240.255.255.254 127.255.255.255 10.255.255.255 169.254.0.1 192.168.255.255 203.0.113.255 172.31.255.255 255.255.255.255 224.0.0.1 240.0.0.1 198.18.0.1 198.19.255.255 192.0.2.1 198.51.100.7 203.0.113.9 192.0.0.8].each do |ip|
  cases << run("a private address #{ip}", "http://#{ip}/ping")
end
cases << run("a private address over https with a port and a path", "https://10.1.2.3:8443/hooks/a-b_c.d")
cases << run("a private address and no user", "http://127.0.0.1/ping", PARAMS, "application/x-www-form-urlencoded", nil, nil)
cases << run("a private address for a user who signs pings", "http://127.0.0.1/ping", PARAMS, "application/x-www-form-urlencoded", 1, PING, users: [user_row(1, notification_endpoint: "http://127.0.0.1/ping")])
cases << run("a private address on the third retry", "http://127.0.0.1/ping", PARAMS.merge("retry_count" => 3))
cases << run("an address just outside the private ranges", "http://172.32.0.1/ping")
cases << run("an address just below 172.16.0.0", "http://172.15.255.255/ping")
cases << run("a public address", "http://8.8.8.8/ping")
cases << run("a public address over https", "https://93.184.216.34/ping")
cases << run("a documentation address outside the listed blocks", "http://192.0.1.1/ping")
cases << run("an address just past 100.64.0.0/10", "http://100.128.0.1/ping")
cases << run("an address just before 100.64.0.0/10", "http://100.63.255.255/ping")
cases << run("an address just before 198.18.0.0/15", "http://198.17.255.255/ping")
cases << run("an address just past 198.18.0.0/15", "http://198.20.0.1/ping")
cases << run("an address just before 223.255.255.255", "http://223.255.255.255/ping")

%w[file ws wss ldap ldaps].each { |scheme| cases << run("a scheme with its own parser #{scheme}", "#{scheme}://example.com/ping") }
cases << run("a scheme other than http and https with a port past 65535", "ftp://example.com:70000/ping")
cases << run("a scheme other than http and https with a hyphen in the host", "ssh://my-host.example.com/ping")

# Everything else is a connection or a name Node does not resolve.
cases << run("a hostname that resolves to a public address", ENDPOINT)
cases << run("a hostname that resolves to a private address", "https://internal.example.com/ping")
cases << run("a hostname that does not resolve", "https://nowhere.example.com/ping")
cases << run("a hostname that does not resolve on the last retry", "https://nowhere.example.com/ping", PARAMS.merge("retry_count" => 3))
cases << run("a hostname with credentials", "https://user:secret@example.com/ping")
cases << run("an address with credentials", "http://user:secret@127.0.0.1/ping")
cases << run("an upper case scheme", "HTTP://127.0.0.1/ping")
cases << run("an upper case scheme other than http", "FTP://example.com/ping")
cases << run("an IPv6 address", "http://[::1]/ping")
cases << run("an address written as one number", "http://2130706433/ping")
cases << run("an address with a leading zero", "http://010.0.0.1/ping")
cases << run("an address with a query string", "http://127.0.0.1/ping?a=b")
cases << run("an address with a fragment", "http://127.0.0.1/ping#frag")
cases << run("a URL with a space", "http://example.com/a b")
cases << run("an empty URL", "")
cases << run("a URL with no scheme", "example.com/ping")
cases << run("a URL with a scheme and no authority", "mailto:seller@example.com")
cases << run("a URL with a trailing dot host", "http://127.0.0.1./ping")
cases << run("params that are not a Hash", ENDPOINT, [1, 2])
cases << run("a retry count that is a String", "ftp://example.com/ping", PARAMS.merge("retry_count" => "2"))
cases << run("a retry count that is a Float", "ftp://example.com/ping", PARAMS.merge("retry_count" => 1.5))
cases << run("a retry count that is false", "ftp://example.com/ping", PARAMS.merge("retry_count" => false))
cases << run("a retry count that is negative", "ftp://example.com/ping", PARAMS.merge("retry_count" => -1))
cases << run("a ping with a purchase id that is not a number", "ftp://example.com/ping", PARAMS, "application/x-www-form-urlencoded", 1, { "purchase_id" => "abc" })
cases << run("a ping with a resource name that is not a String", "ftp://example.com/ping", PARAMS, "application/x-www-form-urlencoded", 1, { "resource_name" => 5 })
cases << run("a nil user id with a ping", "ftp://example.com/ping", PARAMS, "application/x-www-form-urlencoded", nil)
cases << run("a user id that is not a number", "ftp://example.com/ping", PARAMS, "application/x-www-form-urlencoded", "abc")
cases << run("a blank user id", "ftp://example.com/ping", PARAMS, "application/x-www-form-urlencoded", "")

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
