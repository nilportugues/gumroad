# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/remove-suspended-account-follows-worker.golden.json: RemoveSuspendedAccountFollowsWorker
# run by the real app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). The first Follower#mark_deleted!
# is what Node hands back to Rails; those cases are recorded up to the call a marker exception stands in for. Run it like
# delete-wishlist-products-job.rb:
#
#   bundle exec rails runner nextjs/scripts/golden/remove-suspended-account-follows-worker.rb   (env as in publish-scheduled-post.rb)
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/remove-suspended-account-follows-worker.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[users followers].freeze

Rails.logger = ActiveSupport::Logger.new(nil)

class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

Follower.prepend(Module.new do
  def mark_deleted!(*) = raise(HandBackMarker)
end)

def user_row(id, state, **overrides)
  {
    id:, email: "user#{id}@example.com", username: "user#{id}", name: "User #{id}", external_id: (1000 + id).to_s,
    recommendation_type: "own_products", user_risk_state: state, flags: 0, json_data: nil, confirmed_at: SEEDED_AT,
    created_at: SEEDED_AT, updated_at: SEEDED_AT
  }.merge(overrides)
end

def follower_row(id, **overrides)
  { id:, followed_id: 50, email: "other#{id}@example.com", follower_user_id: nil, confirmed_at: SEEDED_AT, deleted_at: nil, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

DELETED = { deleted_at: "2026-11-01 00:00:00" }.freeze
SUSPENDED = "suspended_for_fraud"

def run(name, args, seed: {})
  hands_back = false
  result = capture(name, now: NOW, tables: TABLES, seed:, sidekiq: true, job: "RemoveSuspendedAccountFollowsWorker", args:) do
    RemoveSuspendedAccountFollowsWorker.new.perform(*args)
  rescue HandBackMarker
    hands_back = true
  end
  result.delete("rows")
  result.delete("seed")
  result.merge("hands_back" => hands_back)
end

cases = []
cases << run("the user does not exist", [99])
cases << run("a user who is not suspended", [1], seed: { users: [user_row(1, "not_reviewed")], followers: [follower_row(1, follower_user_id: 1)] })
cases << run("a user flagged but not suspended", [1], seed: { users: [user_row(1, "flagged_for_fraud")], followers: [follower_row(1, follower_user_id: 1)] })
cases << run("a user suspended for a policy violation with no follows", [1], seed: { users: [user_row(1, "suspended_for_tos_violation")] })
cases << run("a user suspended for fraud with no follows", [1], seed: { users: [user_row(1, SUSPENDED)] })
cases << run("a suspended user with an empty email", [1], seed: { users: [user_row(1, SUSPENDED, email: "")] })
cases << run("a suspended user with a blank email", [1], seed: { users: [user_row(1, SUSPENDED, email: " \t ")] })
cases << run("a suspended user with a blank email and an email-less follower", [1], seed: { users: [user_row(1, SUSPENDED, email: "")], followers: [follower_row(1, email: "")] })
cases << run("follows already deleted", [1], seed: { users: [user_row(1, SUSPENDED)], followers: [follower_row(1, follower_user_id: 1, **DELETED), follower_row(2, email: "user1@example.com", **DELETED)] })
cases << run("a follow held by another account", [1], seed: { users: [user_row(1, SUSPENDED)], followers: [follower_row(1, follower_user_id: 2)] })
cases << run("an email match linked to a different account", [1], seed: { users: [user_row(1, SUSPENDED)], followers: [follower_row(1, email: "user1@example.com", follower_user_id: 2)] })
cases << run("a follow under a different email", [1], seed: { users: [user_row(1, SUSPENDED)], followers: [follower_row(1)] })
cases << run("a follow linked to the account", [1], seed: { users: [user_row(1, SUSPENDED)], followers: [follower_row(1, follower_user_id: 1)] })
cases << run("a follow linked to the account of a user suspended for a policy violation", [1], seed: { users: [user_row(1, "suspended_for_tos_violation")], followers: [follower_row(1, follower_user_id: 1)] })
cases << run("an unconfirmed follow linked to the account", [1], seed: { users: [user_row(1, SUSPENDED)], followers: [follower_row(1, follower_user_id: 1, confirmed_at: nil)] })
cases << run("an email-only follow", [1], seed: { users: [user_row(1, SUSPENDED)], followers: [follower_row(1, email: "user1@example.com")] })
cases << run("an email-only follow of a suspended user with a blank email", [1], seed: { users: [user_row(1, SUSPENDED, email: "")], followers: [follower_row(1, email: "")] })
cases << run("the id as digits", ["1"], seed: { users: [user_row(1, SUSPENDED)], followers: [follower_row(1, follower_user_id: 1)] })
cases << run("the id as digits for a user without follows", ["1"], seed: { users: [user_row(1, SUSPENDED)] })

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
