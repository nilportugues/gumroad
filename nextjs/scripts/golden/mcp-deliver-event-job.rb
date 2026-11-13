# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/mcp-deliver-event-job.golden.json:
# Mcp::DeliverEventJob run by the real app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). The delivery
# itself is the outbound POST (Mcp::EventWebhook.post, through SsrfFilter), which Node hands back whole before any write; those cases
# are recorded up to that call, which a marker exception stands in for, so nothing here touches the network. Run it like
# send-workflow-email-to-opened-non-clicker-job.rb (USE_DB_WORKER_REPLICAS=true).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/mcp-deliver-event-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[mcp_event_subscriptions oauth_access_tokens].freeze

Rails.logger = ActiveSupport::Logger.new(nil)

class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

Mcp::EventWebhook.singleton_class.prepend(Module.new do
  def post(*, **) = raise(HandBackMarker)
end)

def at(seconds_from_now) = (NOW + seconds_from_now).utc.strftime("%Y-%m-%d %H:%M:%S.%6N")

def subscription_row(id, expires_in: 3600, **overrides)
  { id:, user_id: 10, oauth_application_id: 20, event_name: "sale.created", arguments: "{}", callback_url: "https://example.com/hook/#{id}",
    key_digest: "digest#{id}", secret: "whsec_#{id}", expires_at: at(expires_in), created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def token_row(id, **overrides)
  { id:, resource_owner_id: 10, application_id: 20, token: "token#{id}", expires_in: nil, scopes: "view_sales", created_at: "2026-11-04 10:00:00" }.merge(overrides)
end

EVENT = { "name" => "sale.created", "eventId" => "evt_1", "data" => { "id" => "p1" } }.freeze

def run(name, args = [1, EVENT], subscriptions: [subscription_row(1)], tokens: [])
  hands_back = false
  result = capture(name, now: NOW, tables: TABLES, seed: { mcp_event_subscriptions: subscriptions, oauth_access_tokens: tokens }, sidekiq: true, job: "Mcp::DeliverEventJob", args:) do
    Mcp::DeliverEventJob.new.perform(*args)
  rescue HandBackMarker
    hands_back = true
  end
  result.delete("seed")
  result.merge("hands_back" => hands_back)
end

cases = []
cases << run("a live subscription with an active token", tokens: [token_row(1, scopes: "account")])
cases << run("a live subscription with an active token that holds the sales scope", tokens: [token_row(1, scopes: "view_sales")])
cases << run("a subscription that does not exist", subscriptions: [])
cases << run("a subscription that expired", subscriptions: [subscription_row(1, expires_in: -60)], tokens: [token_row(1)])
cases << run("a subscription expiring at the current instant", subscriptions: [subscription_row(1, expires_in: 0)], tokens: [token_row(1)])
cases << run("a subscription expiring a millisecond from now", subscriptions: [subscription_row(1, expires_in: 0.001)], tokens: [token_row(1)])
cases << run("a subscription with a nil id", [nil, EVENT])
cases << run("a subscription id given as a String", ["1", EVENT], tokens: [token_row(1)])
cases << run("a subscription id given as a String of another subscription", ["2", EVENT], subscriptions: [subscription_row(1), subscription_row(2)], tokens: [token_row(1)])
cases << run("a live subscription whose connection holds no token")
cases << run("a live subscription whose only token was revoked", tokens: [token_row(1, revoked_at: "2026-11-04 11:00:00")])
cases << run("a live subscription whose token belongs to another user", tokens: [token_row(1, resource_owner_id: 11)])
cases << run("a live subscription whose token belongs to another application", tokens: [token_row(1, application_id: 21)])
cases << run("a live subscription whose token has no owner", tokens: [token_row(1, resource_owner_id: nil)])
cases << run("a live subscription whose token has no scope Rails accepts", tokens: [token_row(1, scopes: "edit_products")])
cases << run("a live subscription whose token has several scopes", tokens: [token_row(1, scopes: "edit_products view_sales")])
cases << run("a live subscription whose token has no scopes", tokens: [token_row(1, scopes: nil)])
cases << run("a live subscription whose token expired", tokens: [token_row(1, expires_in: 60, created_at: "2026-11-04 10:00:00")])
cases << run("a live subscription with a revoked token and an active one", tokens: [token_row(1, revoked_at: "2026-11-04 11:00:00"), token_row(2)])
cases << run("a live subscription with an unusable token and a usable one", tokens: [token_row(1, scopes: "edit_products"), token_row(2)])
cases << run("a live subscription whose token belongs to a team membership that is gone", tokens: [token_row(1, team_membership_id: 5)])
cases << run("an event with no name", [1, EVENT.except("name")], tokens: [token_row(1)])
cases << run("an event with no name and no token", [1, EVENT.except("name")])
cases << run("a nil event", [1, nil], tokens: [token_row(1)])
cases << run("a nil event and no token", [1, nil])
cases << run("an event given as a String and no token", [1, "evt"])
cases << run("an event given as an Array and no token", [1, [1]])
cases << run("an attempt of the first retry", [1, EVENT, 1], tokens: [token_row(1)])
cases << run("an attempt past the last retry", [1, EVENT, 3], tokens: [token_row(1)])
cases << run("an attempt past the last retry and no token", [1, EVENT, 9])
cases << run("an attempt given as a String and no token", [1, EVENT, "1"])
cases << run("a nil attempt and no token", [1, EVENT, nil])
cases << run("an attempt given as a Float and no token", [1, EVENT, 1.5])
cases << run("two subscriptions, only the first is deleted", [1, EVENT], subscriptions: [subscription_row(1), subscription_row(2)])

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
