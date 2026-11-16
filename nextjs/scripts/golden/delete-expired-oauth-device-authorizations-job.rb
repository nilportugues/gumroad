# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/delete-expired-oauth-device-authorizations-job.golden.json:
# DeleteExpiredOauthDeviceAuthorizationsJob run by the real app against a scratch database as a Sidekiq job
# (support/sidekiq_executor.rb). Run it like publish-scheduled-post.rb:
#
#   bundle exec rails runner nextjs/scripts/golden/delete-expired-oauth-device-authorizations-job.rb   (env as in publish-scheduled-post.rb)
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/delete-expired-oauth-device-authorizations-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[oauth_device_authorizations].freeze
STATUSES = OauthDeviceAuthorization::STATUSES

Rails.logger = ActiveSupport::Logger.new(nil)

$replica_lag_watches = 0
ReplicaLagWatcher.singleton_class.prepend(Module.new do
  def watch(*) = ($replica_lag_watches += 1)
end)

def at(seconds_from_now) = (NOW + seconds_from_now).utc.strftime("%Y-%m-%d %H:%M:%S")

def row(id, status:, expires_in:, **overrides)
  {
    id:, oauth_application_id: 1, device_code_digest: "device#{id}", user_code_digest: "user#{id}", scopes: "view_profile",
    status:, expires_at: at(expires_in), poll_interval_seconds: 5, poll_count: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT
  }.merge(overrides)
end

def run(name, rows)
  $replica_lag_watches = 0
  result = capture(name, now: NOW, tables: TABLES, seed: { oauth_device_authorizations: rows }, sidekiq: true, job: "DeleteExpiredOauthDeviceAuthorizationsJob", args: []) do
    DeleteExpiredOauthDeviceAuthorizationsJob.new.perform
  end
  result.merge("replica_lag_watches" => $replica_lag_watches)
end

cases = []
cases << run("no authorizations", [])
STATUSES.each_with_index do |status, i|
  cases << run("a #{status} authorization that expired", [row(1 + i, status:, expires_in: -60)])
  cases << run("a #{status} authorization that has not expired", [row(1 + i, status:, expires_in: 60)])
end
cases << run("an authorization expiring at the current second", [row(1, status: "pending", expires_in: 0)])
cases << run("an authorization expiring in a second", [row(1, status: "pending", expires_in: 1)])
cases << run("an unknown status that expired", [row(1, status: "revoked", expires_in: -60)])
cases << run("an approval inside its grace window", [row(1, status: "approved", expires_in: -2, approved_at: at(-10))])
cases << run("an approval whose grace window ends at the current second", [row(1, status: "approved", expires_in: -5, approved_at: at(-10))])
cases << run("an approval whose grace window ended a second ago", [row(1, status: "approved", expires_in: -6, approved_at: at(-10))])
cases << run("an approval with a longer poll interval inside the grace window", [row(1, status: "approved", expires_in: -30, approved_at: at(-40), poll_interval_seconds: 35)])
cases << run("an approval made after it expired", [row(1, status: "approved", expires_in: -2, approved_at: at(-1))])
cases << run("an approval made at the second it expired", [row(1, status: "approved", expires_in: -2, approved_at: at(-2))])
cases << run("an expired approval with no approval time", [row(1, status: "approved", expires_in: -2)])
cases << run("an expired denial inside what would be a grace window", [row(1, status: "denied", expires_in: -2, approved_at: at(-10))])
cases << run("a mix of expired, live and graced authorizations", [
  row(1, status: "pending", expires_in: -60), row(2, status: "pending", expires_in: 60), row(3, status: "approved", expires_in: -2, approved_at: at(-10)),
  row(4, status: "consumed", expires_in: -3600), row(5, status: "denied", expires_in: 3600), row(6, status: "approved", expires_in: -600, approved_at: at(-900))
])
cases << run("99 expired authorizations", (1..99).map { row(_1, status: "pending", expires_in: -60) })
cases << run("100 expired authorizations", (1..100).map { row(_1, status: "pending", expires_in: -60) })
cases << run("101 expired authorizations", (1..101).map { row(_1, status: "consumed", expires_in: -60) })
cases << run("250 expired authorizations and 3 live ones", (1..250).map { row(_1, status: "denied", expires_in: -60) } + (251..253).map { row(_1, status: "pending", expires_in: 60) })
cases << run("100 expired authorizations beside 5 that are kept", (1..100).map { row(_1, status: "pending", expires_in: -60) } + (101..105).map { row(_1, status: "approved", expires_in: -2, approved_at: at(-10)) })

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
