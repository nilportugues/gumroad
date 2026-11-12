# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/google-calendar-invite-job.golden.json: GoogleCalendarInviteJob run by the real app
# against a scratch database as a Sidekiq job (support/sidekiq_executor.rb), Google answered by WebMock (nothing leaves the machine;
# `http` holds each request Rails sent and `http_responses` each answer it got). Run it like publish-scheduled-post.rb:
#
#   bundle exec rails runner nextjs/scripts/golden/google-calendar-invite-job.rb   (env as in publish-scheduled-post.rb)
require_relative "support/rails_cases"
include RailsCases
capture_http!

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/google-calendar-invite-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[users links purchases calls integrations product_integrations].freeze
JSON_HEADERS = { "Content-Type" => "application/json" }.freeze

Rails.logger = ActiveSupport::Logger.new(nil)

def user_row(id, email)
  { id:, email:, username: "user#{id}", external_id: (1000 + id).to_s, user_risk_state: "compliant", flags: 0, confirmed_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT }
end

def link_row(id = 1, **overrides)
  { id:, name: "Coaching", user_id: 1, unique_permalink: "p#{id}", native_type: "call", price_currency_type: "usd", flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def purchase_row(id = 1, **overrides)
  { id:, seller_id: 1, link_id: 1, email: "buyer@example.com", price_cents: 500, purchase_state: "successful", flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def call_row(id = 1, **overrides)
  { id:, purchase_id: 1, start_time: "2026-11-10 15:00:00", end_time: "2026-11-10 15:30:00", created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def integration_row(id = 1, type: "GoogleCalendarIntegration", **details)
  json = { access_token: "old-access", refresh_token: "refresh-1", calendar_id: "primary@group.calendar.google.com", calendar_summary: "Calls", email: "seller@example.com" }.merge(details)
  { id:, type:, json_data: json.to_json, flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }
end

def product_integration_row(id = 1, **overrides)
  { id:, product_id: 1, integration_id: 1, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

BASE = {
  users: [user_row(1, "seller@example.com"), user_row(2, "account@example.com")],
  links: [link_row],
  purchases: [purchase_row],
  calls: [call_row],
  integrations: [integration_row],
  product_integrations: [product_integration_row],
}.freeze

def ok(id = "evt-1") = { status: 200, body: { id: }.to_json, headers: JSON_HEADERS }
def answer(status, body = {}) = { status:, body: body.to_json, headers: JSON_HEADERS }

def run(name, args, seed: {}, http: [])
  result = capture(name, now: NOW, tables: TABLES, seed: BASE.merge(seed), sidekiq: true, job: "GoogleCalendarInviteJob", args:, http_responses: http) do
    GoogleCalendarInviteJob.new.perform(*args)
  end
  result.delete("rows")
  result.delete("seed")
  result
end

cases = []
cases << run("a call that does not exist", [99])
cases << run("a call that already has an event", [1], seed: { calls: [call_row(google_calendar_event_id: "evt-0")] })
cases << run("a product with no integration", [1], seed: { product_integrations: [] })
cases << run("an integration removed from the product", [1], seed: { product_integrations: [product_integration_row(deleted_at: "2026-02-01 00:00:00")] })
cases << run("an integration of another kind", [1], seed: { integrations: [integration_row(type: "ZoomIntegration")] })
cases << run("an event is inserted", [1], http: [ok])
cases << run("the digits of the id", ["1"], http: [ok("evt-2")])
cases << run("the buyer has an account", [1], seed: { purchases: [purchase_row(purchaser_id: 2)] }, http: [ok])
cases << run("the buyer's account is gone", [1], seed: { purchases: [purchase_row(purchaser_id: 9)] }, http: [ok])
cases << run("the calendar id needs escaping", [1], seed: { integrations: [integration_row(calendar_id: "team calendar@example.com")] }, http: [ok])
cases << run("an integration with no calendar id", [1], seed: { integrations: [integration_row(calendar_id: nil)] }, http: [ok])
cases << run("Google answers a server error", [1], http: [answer(500, { error: "backend" })])
cases << run("Google answers forbidden", [1], http: [answer(403, { error: "forbidden" })])
cases << run("Google answers unauthorized and the token refreshes", [1], http: [answer(401, { error: "expired" }), answer(200, { access_token: "new-access" }), ok("evt-3")])
cases << run("Google answers unauthorized and the refresh fails", [1], http: [answer(401), answer(400, { error: "invalid_grant" })])
cases << run("Google answers unauthorized, the token refreshes and the retry fails", [1], http: [answer(401), answer(200, { access_token: "new-access" }), answer(500)])
cases << run("Google answers unauthorized and the refresh has no token", [1], http: [answer(401), answer(200, {}), ok("evt-4")])
cases << run("Google answers unauthorized twice", [1], http: [answer(401), answer(200, { access_token: "new-access" }), answer(401)])
cases << run("the event has no id", [1], http: [answer(200, {})])
cases << run("the answer is plain text without id", [1], http: [{ status: 200, body: "ok", headers: { "Content-Type" => "text/plain" } }])
cases << run("the answer is plain text with id", [1], http: [{ status: 200, body: "valid", headers: { "Content-Type" => "text/plain" } }])
cases << run("the answer is an empty body", [1], http: [{ status: 200, body: "", headers: JSON_HEADERS }])
cases << run("the answer is a JSON list", [1], http: [{ status: 200, body: "[]", headers: JSON_HEADERS }])
cases << run("the answer is a JSON number", [1], http: [{ status: 200, body: "5", headers: JSON_HEADERS }])
cases << run("the answer is JSON null", [1], http: [{ status: 200, body: "null", headers: JSON_HEADERS }])
cases << run("the answer is JSON true", [1], http: [{ status: 200, body: "true", headers: JSON_HEADERS }])
cases << run("the product is not a call", [1], seed: { links: [link_row(native_type: "digital")] }, http: [ok])
cases << run("a call that ends before it starts", [1], seed: { calls: [call_row(start_time: "2026-11-10 16:00:00", end_time: "2026-11-10 15:30:00")] }, http: [ok])
cases << run("a call whose purchase is gone", [1], seed: { purchases: [] }, http: [ok])
cases << run("a product that is gone", [1], seed: { links: [] }, http: [ok])
cases << run("the answer has a numeric id", [1], http: [answer(200, { id: 5 })])
cases << run("the answer has a boolean id", [1], http: [answer(200, { id: true })])
cases << run("the answer has a null id", [1], http: [answer(200, { id: nil })])
cases << run("the answer has a float id", [1], http: [{ status: 200, body: '{"id":1.5}', headers: JSON_HEADERS }])
cases << run("the answer has a list for an id", [1], http: [answer(200, { id: [1] })])
cases << run("the answer is a JSON float", [1], http: [{ status: 200, body: "5.5", headers: JSON_HEADERS }])
cases << run("the answer is a JSON string", [1], http: [{ status: 200, body: '"an id"', headers: JSON_HEADERS }])
cases << run("the answer is plain text with no content type", [1], http: [{ status: 200, body: "valid", headers: {} }])
cases << run("the event id is longer than the column", [1], http: [answer(200, { id: "e" * 300 })])
cases << run("a product name Ruby escapes in JSON", [1], seed: { links: [link_row(name: "Q&A <live>   \"coaching\"")] }, http: [ok])
cases << run("a call that starts with seconds", [1], seed: { calls: [call_row(start_time: "2026-11-10 15:00:30")] }, http: [ok])
cases << run("several calls", [2], seed: { calls: [call_row(1), call_row(2, google_calendar_event_id: "evt-0")] }, http: [ok])
cases << run("no id", [])

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
