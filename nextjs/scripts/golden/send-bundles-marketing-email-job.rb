# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/send-bundles-marketing-email-job.golden.json:
# SendBundlesMarketingEmailJob run by the real app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). A seller
# in the scan is where Node hands back (`Link.search` asks Elasticsearch, and the bundles mail is enqueued after it); those cases are
# recorded up to that call, which a marker exception stands in for, so nothing leaves the machine. Run it like
# send-workflow-email-to-opened-non-clicker-job.rb (USE_DB_WORKER_REPLICAS=true).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/send-bundles-marketing-email-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[users payments].freeze

Rails.logger = ActiveSupport::Logger.new(nil)

class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

$replica_lag_watches = 0
ReplicaLagWatcher.singleton_class.prepend(Module.new do
  def watch(*) = ($replica_lag_watches += 1)
end)

Link.singleton_class.prepend(Module.new do
  def search(*, **) = raise(HandBackMarker)
end)

def at(seconds_from_now) = (NOW + seconds_from_now).utc.strftime("%Y-%m-%d %H:%M:%S.%6N")

def user_row(id, **overrides)
  { id:, email: "seller#{id}@example.com", username: "seller#{id}", external_id: (1000 + id).to_s, recommendation_type: "own_products", user_risk_state: "compliant", flags: 0,
    currency_type: "usd", created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def payment_row(id, user_id, **overrides) = { id:, user_id:, state: "completed", created_at: at(-3600), updated_at: SEEDED_AT, flags: 0 }.merge(overrides)

def run(name, users: [user_row(1)], payments: [payment_row(1, 1)])
  $replica_lag_watches = 0
  hands_back = false
  result = capture(name, now: NOW, tables: TABLES, seed: { users:, payments: }, sidekiq: true, job: "SendBundlesMarketingEmailJob", args: []) do
    SendBundlesMarketingEmailJob.new.perform
  rescue HandBackMarker
    hands_back = true
  end
  result.delete("rows")
  result.delete("seed")
  result.merge("hands_back" => hands_back, "replica_lag_watches" => $replica_lag_watches)
end

year_ago = -1.year

cases = []
cases << run("no users", users: [], payments: [])
cases << run("a seller paid out this year")
cases << run("a user with no payment", payments: [])
cases << run("a seller whose payout was a year and a second ago", payments: [payment_row(1, 1, created_at: at(year_ago - 1))])
cases << run("a seller whose payout was a year ago to the second", payments: [payment_row(1, 1, created_at: at(year_ago))])
cases << run("a seller whose payout was a year ago and a second from now", payments: [payment_row(1, 1, created_at: at(year_ago + 1))])
cases << run("a seller whose only payout failed", payments: [payment_row(1, 1, state: "failed")])
cases << run("a seller whose only payout is processing", payments: [payment_row(1, 1, state: "processing")])
cases << run("a seller whose only payout has no state", payments: [payment_row(1, 1, state: nil)])
cases << run("a payout that is in the future", payments: [payment_row(1, 1, created_at: at(3600))])
cases << run("a payout with no user", payments: [payment_row(1, nil)])
cases << run("a payout of another user", payments: [payment_row(1, 2)])
%w[suspended_for_fraud suspended_for_tos_violation flagged_for_fraud flagged_for_tos_violation on_probation not_reviewed compliant].each do |state|
  cases << run("a seller #{state.tr("_", " ")}", users: [user_row(1, user_risk_state: state)])
end
cases << run("a seller with no risk state", users: [user_row(1, user_risk_state: nil)])
cases << run("a seller that was deleted", users: [user_row(1, deleted_at: SEEDED_AT)])
cases << run("a seller paid out twice", payments: [payment_row(1, 1), payment_row(2, 1)])
cases << run("a seller paid out once completed and once failed", payments: [payment_row(1, 1, state: "failed"), payment_row(2, 1)])
cases << run("a seller in another currency", users: [user_row(1, currency_type: "gbp")])
cases << run("a seller with no currency", users: [user_row(1, currency_type: nil)])
cases << run("two sellers, the first suspended", users: [user_row(1, user_risk_state: "suspended_for_fraud"), user_row(2)], payments: [payment_row(1, 1), payment_row(2, 2)])
cases << run("two sellers, the second deleted", users: [user_row(1), user_row(2, deleted_at: SEEDED_AT)], payments: [payment_row(1, 1), payment_row(2, 2)])
cases << run("two sellers, only the second paid out this year", users: [user_row(1), user_row(2)], payments: [payment_row(1, 1, created_at: at(year_ago - 60)), payment_row(2, 2)])
cases << run("three sellers paid out", users: [user_row(1), user_row(2), user_row(3)], payments: [payment_row(1, 1), payment_row(2, 2), payment_row(3, 3)])

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
