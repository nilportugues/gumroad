# frozen_string_literal: true

# Golden requests for nextjs/src/server/stripe: runs the real stripe gem (Gemfile.lock's 12.5.0,
# configured as config/initializers/003_stripe.rb does) against a local HTTP server that records
# every request and answers from a script, and writes what the gem sent and what it returned or
# raised to stripe-requests.golden.json next to this file.
#
#   GEM_PATH=<dir with stripe-12.5.0> ruby nextjs/src/server/stripe/__fixtures__/generate-stripe-requests-golden.rb
gem "stripe", "12.5.0"
require "json"
require "stripe"

OUT = File.expand_path("stripe-requests.golden.json", __dir__)

require_relative "capture_server"

server = CaptureServer.new
API_BASE = "http://127.0.0.1:#{server.port}"

# config/initializers/003_stripe.rb outside the test environment.
Stripe.api_version = "2023-10-16; risk_in_requirements_beta=v1; retrieve_tax_forms_beta=v1;"
Stripe.max_network_retries = 3
Stripe.api_key = "sk_test_golden"
Stripe.api_base = API_BASE

# Record the backoff instead of waiting for it.
$sleeps = []
Stripe::StripeClient.prepend(Module.new { def sleep(seconds) = $sleeps << seconds })

def ok(body, request_id: "req_ok")
  [200, { "Request-Id" => request_id, "Content-Type" => "application/json" }, JSON.generate(body)]
end

def error(status, error, headers = {})
  [status, { "Request-Id" => "req_err", "Content-Type" => "application/json" }.merge(headers), JSON.generate({ error: })]
end

account = { id: "acct_1", object: "account", business_profile: { url: "https://seller.gumroad.com" },
            risk_controls: { charges: { pause_requested: true }, payouts: { pause_requested: false } },
            requirements: { disabled_reason: "platform_paused", past_due: [] }, capabilities: { transfers: "active" } }
payout = { id: "po_1", object: "payout", amount: -1234, status: "paid", balance_transaction: { id: "txn_1", object: "balance_transaction", status: "available" } }
balance = { object: "balance", available: [{ amount: 100, currency: "usd" }], pending: [{ amount: 50, currency: "usd" }] }
transfer = { id: "tr_1", object: "transfer", amount: 1234, currency: "usd" }
transfer_list = { object: "list", url: "/v1/transfers", has_more: false, data: [transfer, { id: "tr_2", object: "transfer", amount: 99, currency: "eur" }] }
reversal = { id: "trr_1", object: "transfer_reversal", amount: 500, transfer: "tr_1" }
apple_pay_domain = { id: "apwc_1", object: "apple_pay_domain", domain_name: "seller.gumroad.com" }

CASES = [
  ["account retrieve", -> { Stripe::Account.retrieve("acct_1") }, [ok(account)]],
  ["account retrieve escapes the id", -> { Stripe::Account.retrieve("acct_ 1/x") }, [ok(account)]],
  ["account update business profile url", -> { Stripe::Account.update("acct_1", business_profile: { url: "https://new.gumroad.com" }) }, [ok(account)]],
  ["account update lifts the charges pause", -> { Stripe::Account.update("acct_1", risk_controls: { charges: { pause_requested: false } }) }, [ok(account)]],
  ["payout retrieve expanded on a connected account",
   -> { Stripe::Payout.retrieve({ id: "po_1", expand: %w[balance_transaction] }, { stripe_account: "acct_1" }) }, [ok(payout)]],
  ["payout retrieve on a connected account", -> { Stripe::Payout.retrieve("po_1", { stripe_account: "acct_1" }) }, [ok(payout)]],
  ["balance retrieve on a connected account", -> { Stripe::Balance.retrieve({ stripe_account: "acct_1" }) }, [ok(balance)]],
  ["transfer create on a connected account",
   -> { Stripe::Transfer.create({ amount: 1234, currency: "usd", destination: "acct_platform" }, { stripe_account: "acct_1" }) }, [ok(transfer)]],
  ["transfer retrieve", -> { Stripe::Transfer.retrieve("tr_1") }, [ok(transfer)]],
  ["transfer list drops nil params", -> { Stripe::Transfer.list(destination: "acct_1", created: { 'lt': 1_700_000_000 }, limit: 100, starting_after: nil) }, [ok(transfer_list)]],
  ["transfer list pages", -> { Stripe::Transfer.list(destination: "acct_1", created: { 'lt': 1_700_000_000 }, limit: 100, starting_after: "tr_2") }, [ok(transfer_list)]],
  ["transfer reversal", -> { Stripe::Transfer.create_reversal("tr_1", { amount: 500 }) }, [ok(reversal)]],
  ["apple pay domain create", -> { Stripe::ApplePayDomain.create(domain_name: "seller.gumroad.com") }, [ok(apple_pay_domain)]],
  ["apple pay domain retrieve", -> { Stripe::ApplePayDomain.retrieve("apwc_1") }, [ok(apple_pay_domain)]],
  ["apple pay domain delete", -> { Stripe::ApplePayDomain.delete("apwc_1") }, [ok({ id: "apwc_1", object: "apple_pay_domain", deleted: true })]],
  ["form encoding edge cases",
   lambda do
     Stripe::Account.update(
       "acct_1",
       {
         metadata: { "a b" => "x&y=z+ü*~!'()", "skipped" => nil, "t" => true, "f" => false, "n" => 12, "neg" => -3, "float" => 1.5, "sym" => :value },
         individual: { address: { line1: "", line2: "Apt. #4 [rear]" } },
         list: ["a", { k: "v" }, %w[x y], nil],
         empty_hash: {},
         empty_list: [],
       },
       { idempotency_key: "idem-fixed", stripe_account: "acct_9" }
     )
   end,
   [ok(account)]],
  ["post with no params", -> { Stripe::Account.update("acct_1") }, [ok(account)]],
  ["telemetry of the previous request", -> { Stripe::Transfer.retrieve("tr_1"); Stripe::Transfer.retrieve("tr_2") },
   [ok(transfer, request_id: "req_first"), ok(transfer, request_id: "req_second")]],

  ["400 invalid request is not retried", -> { Stripe::Account.retrieve("acct_missing") },
   [error(400, { type: "invalid_request_error", code: "resource_missing", message: "No such account: 'acct_missing'", param: "account" })]],
  ["404 invalid request", -> { Stripe::Transfer.retrieve("tr_missing") },
   [error(404, { type: "invalid_request_error", code: "resource_missing", message: "No such transfer: 'tr_missing'" })]],
  ["403 permission error", -> { Stripe::Account.update("acct_1", business_profile: { url: "x" }) },
   [error(403, { type: "invalid_request_error", message: "The provided key does not have access to account 'acct_1'." })]],
  ["401 authentication error", -> { Stripe::Balance.retrieve({ stripe_account: "acct_1" }) },
   [error(401, { type: "invalid_request_error", message: "Invalid API Key provided: sk_test_****" })]],
  ["402 card error", -> { Stripe::Transfer.create({ amount: 1, currency: "usd", destination: "acct_2" }) },
   [error(402, { type: "card_error", code: "card_declined", message: "Your card was declined.", param: "source" })]],
  ["400 idempotency error", -> { Stripe::Transfer.create({ amount: 1, currency: "usd", destination: "acct_2" }) },
   [error(400, { type: "idempotency_error", message: "Keys for idempotent requests can only be used with the same parameters." })]],
  ["429 lock timeout is retried with the same idempotency key", -> { Stripe::Transfer.create({ amount: 1, currency: "usd", destination: "acct_2" }) },
   [error(429, { type: "invalid_request_error", code: "lock_timeout", message: "This object cannot be accessed right now." }), ok(transfer)]],
  ["429 rate limit is not retried", -> { Stripe::Account.retrieve("acct_1") },
   [error(429, { type: "invalid_request_error", code: "rate_limit", message: "Too many requests." })]],
  ["409 conflict is retried", -> { Stripe::Account.retrieve("acct_1") },
   [error(409, { type: "invalid_request_error", message: "Conflict." }), ok(account)]],
  ["500 is retried until max_network_retries", -> { Stripe::Account.retrieve("acct_1") },
   Array.new(4) { error(500, { type: "api_error", message: "An unknown error occurred" }) }],
  ["payout create is sent four times under one idempotency key when Stripe answers 500",
   -> { Stripe::Payout.create({ amount: 1234, currency: "usd", method: "instant" }, { stripe_account: "acct_1" }) },
   Array.new(4) { error(500, { type: "api_error", message: "An unknown error occurred" }) }],
  ["payout create is sent four times under one idempotency key when the connection drops",
   -> { Stripe::Payout.create({ amount: 1234, currency: "usd", method: "instant" }, { stripe_account: "acct_1" }) },
   Array.new(4) { [:drop, {}, ""] }],
  ["payout create succeeds on the third attempt after two drops, keeping its key",
   -> { Stripe::Payout.create({ amount: 1234, currency: "usd" }, { stripe_account: "acct_1" }) },
   [[:drop, {}, ""], [:drop, {}, ""], ok(payout)]],
  ["payout create 429 rate limit is not retried",
   -> { Stripe::Payout.create({ amount: 1234, currency: "usd" }, { stripe_account: "acct_1" }) },
   [error(429, { type: "invalid_request_error", message: "Too many requests." })]],
  ["transfer create 500 is retried under one idempotency key",
   -> { Stripe::Transfer.create({ amount: 1234, currency: "usd", destination: "acct_1" }) },
   [error(500, { type: "api_error", message: "An unknown error occurred" }), ok(transfer)]],
  ["transfer reversal is sent four times when the connection drops",
   -> { Stripe::Transfer.create_reversal("tr_1", { amount: 500 }) },
   Array.new(4) { [:drop, {}, ""] }],
  ["stripe-should-retry false stops a 500 retry", -> { Stripe::Account.retrieve("acct_1") },
   [error(500, { type: "api_error", message: "Do not retry" }, { "Stripe-Should-Retry" => "false" })]],
  ["stripe-should-retry true retries a 400", -> { Stripe::Account.retrieve("acct_1") },
   [error(400, { type: "invalid_request_error", message: "Retry me" }, { "Stripe-Should-Retry" => "true" }), ok(account)]],
  ["unparseable body", -> { Stripe::Account.retrieve("acct_1") },
   Array.new(4) { [502, {}, "<html>bad gateway</html>"] }],
  ["error body without an error key", -> { Stripe::Account.retrieve("acct_1") },
   [[400, { "Request-Id" => "req_x" }, JSON.generate({ message: "nope" })]]],
  ["oauth error", -> { Stripe::Account.retrieve("acct_1") },
   [[400, { "Request-Id" => "req_x" }, JSON.generate({ error: "invalid_grant", error_description: "Authorization code expired" })]]],
]

def describe_error(error)
  {
    "class" => error.class.name, "message" => error.message, "to_s" => error.to_s, "code" => error.code,
    "http_status" => error.http_status, "request_id" => error.request_id,
    "param" => error.respond_to?(:param) ? error.param : nil,
  }
end

results = CASES.map do |name, call, responses|
  Stripe::StripeClient.current_thread_context.default_client = nil
  server.requests.clear
  server.responses = responses.map { |status, headers, body| [status, headers.dup, body] }
  $sleeps = []
  outcome = begin
    { "result" => call.call.to_hash }
  rescue Stripe::StripeError => e
    { "error" => describe_error(e) }
  end
  { "name" => name, "responses" => responses, "requests" => server.requests.dup, "retries" => $sleeps.size, **outcome }
end

# A refused connection: the gem retries network errors, then raises APIConnectionError.
closed = TCPServer.new("127.0.0.1", 0)
closed_port = closed.addr[1]
closed.close
Stripe.api_base = "http://127.0.0.1:#{closed_port}"
Stripe::StripeClient.current_thread_context.default_client = nil
$sleeps = []
begin
  Stripe::Account.retrieve("acct_1")
rescue Stripe::StripeError => e
  results << { "name" => "connection refused", "api_base_port" => closed_port, "retries" => $sleeps.size, "error" => describe_error(e) }
end

golden = {
  "generated_with" => { "ruby" => RUBY_VERSION, "stripe" => Stripe::VERSION },
  "api_base" => API_BASE,
  "sleep_time" => (1..3).map { |n| { "retries" => n, "samples" => Array.new(200) { Stripe::StripeClient.sleep_time(n) }.minmax } },
  "cases" => results,
}
File.write(OUT, JSON.pretty_generate(golden) + "\n")
puts "wrote #{OUT}"
