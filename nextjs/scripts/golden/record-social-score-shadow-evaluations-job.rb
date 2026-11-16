# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/record-social-score-shadow-evaluations-job.golden.json: RecordSocialScoreShadowEvaluationsJob
# run by the real app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). SocialScoreShadowEvaluationService#evaluate
# (the scoring of one seller) answers nil, so no row is written; the golden keeps the user ids it was asked to evaluate under `processed`.
# ReplicaLagWatcher.watch is recorded under `lag_checks`. Run it like publish-scheduled-post.rb (env in its header).
require_relative "support/rails_cases"
include RailsCases
capture_http!

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/record-social-score-shadow-evaluations-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[social_connect_verifications users social_score_shadow_evaluations].freeze

Rails.logger = ActiveSupport::Logger.new(nil)

$processed = []
$lag_checks = 0
SocialScoreShadowEvaluationService.prepend(Module.new do
  define_method(:evaluate) { $processed << @user.id; nil }
end)
ReplicaLagWatcher.singleton_class.prepend(Module.new do
  define_method(:watch) { |*| $lag_checks += 1; nil }
end)

def user_row(id) = { id:, email: "user#{id}@example.com", username: "user#{id}", external_id: (1000 + id).to_s, flags: 0, confirmed_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT }

def verification_row(id, user_id, **overrides)
  { id:, user_id:, platform: "x", uid: "uid#{id}", last_verified_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def run(name, args, verifications, users)
  $processed = []
  $lag_checks = 0
  result = capture(name, now: NOW, tables: TABLES, seed: { social_connect_verifications: verifications, users: }, sidekiq: true, job: "RecordSocialScoreShadowEvaluationsJob", args:) do
    RecordSocialScoreShadowEvaluationsJob.new.perform(*args)
  end
  result.delete("seed")
  result.delete("rows")
  result.merge("processed" => $processed.dup, "lag_checks" => $lag_checks)
end

cases = []
cases << run("the cron tick with no date", [], [], [])
cases << run("the cron tick with a nil date", [nil], [verification_row(1, 1)], [user_row(1)])
cases << run("a date and no verifications", ["2026-11-03"], [], [])
cases << run("a date and a verification of a user that does not exist", ["2026-11-03"], [verification_row(1, 99)], [])
cases << run("a date and a verified user", ["2026-11-03"], [verification_row(1, 1)], [user_row(1)])
cases << run("a user verified on two platforms", ["2026-11-03"], [verification_row(1, 1), verification_row(2, 1, platform: "bluesky")], [user_row(1)])
cases << run("two verified users", ["2026-11-03"], [verification_row(1, 2), verification_row(2, 1)], [user_row(1), user_row(2)])
cases << run("one verified user and one missing", ["2026-11-03"], [verification_row(1, 1), verification_row(2, 99)], [user_row(1)])
cases << run("a superseded verification", ["2026-11-03"], [verification_row(1, 1, superseded_at: SEEDED_AT)], [user_row(1)])
cases << run("a batch of verified users that are all missing", ["2026-11-03"], (1..500).map { verification_row(_1, _1) }, [])
cases << run("a batch and one more of missing users", ["2026-11-03"], (1..501).map { verification_row(_1, _1) }, [])
cases << run("a second batch holding the only user", ["2026-11-03"], (1..501).map { verification_row(_1, _1) }, [user_row(501)])
cases << run("a date with a time", ["2026-11-03T10:00:00Z"], [], [])
cases << run("a date that is not a date", ["never"], [], [])
cases << run("a date of the wrong calendar day", ["2026-02-30"], [], [])
cases << run("a date written out", ["Nov 3 2026"], [], [])
cases << run("a date given as an integer", [20_261_103], [], [])

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
