# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/mcp-delete-expired-event-subscriptions-job.golden.json:
# Mcp::DeleteExpiredEventSubscriptionsJob run by the real app against a scratch database as a Sidekiq job
# (support/sidekiq_executor.rb). Run it like publish-scheduled-post.rb.
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/mcp-delete-expired-event-subscriptions-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[mcp_event_subscriptions].freeze

Rails.logger = ActiveSupport::Logger.new(nil)

$replica_lag_watches = 0
ReplicaLagWatcher.singleton_class.prepend(Module.new do
  def watch(*) = ($replica_lag_watches += 1)
end)

def at(seconds_from_now) = (NOW + seconds_from_now).utc.strftime("%Y-%m-%d %H:%M:%S.%6N")

def row(id, user_id:, expires_in:)
  { id:, user_id:, oauth_application_id: 1, event_name: "sale.created", arguments: "{}", callback_url: "https://example.com/hook/#{id}",
    key_digest: "digest#{id}", secret: "whsec_#{id}", expires_at: at(expires_in), created_at: SEEDED_AT, updated_at: SEEDED_AT }
end

def run(name, rows)
  $replica_lag_watches = 0
  result = capture(name, now: NOW, tables: TABLES, seed: { mcp_event_subscriptions: rows }, sidekiq: true, job: "Mcp::DeleteExpiredEventSubscriptionsJob", args: []) do
    Mcp::DeleteExpiredEventSubscriptionsJob.new.perform
  end
  result.merge("replica_lag_watches" => $replica_lag_watches)
end

cases = []
cases << run("no subscriptions", [])
cases << run("a subscription that expired", [row(1, user_id: 10, expires_in: -60)])
cases << run("a subscription that is live", [row(1, user_id: 10, expires_in: 60)])
cases << run("a subscription expiring at the current instant", [row(1, user_id: 10, expires_in: 0)])
cases << run("a subscription expiring a microsecond from now", [row(1, user_id: 10, expires_in: 0.000001)])
cases << run("a subscription expired a microsecond ago", [row(1, user_id: 10, expires_in: -0.000001)])
cases << run("a seller with expired and live subscriptions", [row(1, user_id: 10, expires_in: -60), row(2, user_id: 10, expires_in: 60), row(3, user_id: 10, expires_in: -3600)])
cases << run("three sellers, one with only live subscriptions", [row(1, user_id: 12, expires_in: -60), row(2, user_id: 11, expires_in: 60), row(3, user_id: 10, expires_in: -5), row(4, user_id: 12, expires_in: -90)])
cases << run("exactly one batch of sellers", (1..100).map { |i| row(i, user_id: 1000 + i, expires_in: -60) })
cases << run("more sellers than one batch holds", (1..101).map { |i| row(i, user_id: 1000 + i, expires_in: -60) })
cases << run("two batches of sellers with live rows among them", (1..230).map { |i| row(i, user_id: 1000 + (i % 205), expires_in: i.even? ? -60 : 60) })

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
