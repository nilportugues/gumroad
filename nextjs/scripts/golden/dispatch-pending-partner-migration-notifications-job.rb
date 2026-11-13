# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/dispatch-pending-partner-migration-notifications-job.golden.json:
# DispatchPendingPartnerMigrationNotificationsJob run by the real app against a scratch database as a Sidekiq job
# (support/sidekiq_executor.rb). Each case's Redis snapshot holds the PartnerMigrationNotificationJob pushes. Run it like
# pdf-unstampable-notifier-job.rb (env as in publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/dispatch-pending-partner-migration-notifications-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[users partner_migrations].freeze
DUE = "2026-11-04 12:00:00"

Rails.logger = ActiveSupport::Logger.new(nil)

def user_row(id, **overrides)
  { id:, email: "seller#{id}@example.com", username: "seller#{id}", external_id: (1000 + id).to_s, recommendation_type: "own_products",
    user_risk_state: "compliant", flags: 0, confirmed_at: nil, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def migration_row(id, user_id = id, **overrides)
  { id:, oauth_application_id: 1, external_user_id: "ext#{id}", public_id: "pm#{id}", code_digest: "digest#{id}", products: "[]", status: "completed",
    user_id:, expires_at: "2027-01-01 00:00:00", completed_at: DUE, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def run(name, users, migrations)
  result = capture(name, now: NOW, tables: TABLES, seed: { users:, partner_migrations: migrations }, sidekiq: true, job: "DispatchPendingPartnerMigrationNotificationsJob", args: []) do
    DispatchPendingPartnerMigrationNotificationsJob.new.perform
  end
  result.delete("rows")
  result.delete("seed")
  result
end

U = [user_row(1), user_row(2), user_row(3)].freeze

cases = []
cases << run("no migrations", U, [])
cases << run("a completed migration", U, [migration_row(1)])
cases << run("a failed migration", U, [migration_row(1, status: "failed")])
cases << run("a pending migration", U, [migration_row(1, status: "pending", completed_at: nil)])
cases << run("a claimed migration", U, [migration_row(1, status: "claimed")])
cases << run("a migration already notified", U, [migration_row(1, notified_at: DUE)])
cases << run("a migration completed 11 minutes ago", U, [migration_row(1, completed_at: "2026-11-04 12:19:45")])
cases << run("a migration completed exactly 10 minutes ago", U, [migration_row(1, completed_at: "2026-11-04 12:20:45.123")])
cases << run("a migration completed 10 minutes ago less a millisecond", U, [migration_row(1, completed_at: "2026-11-04 12:20:45.124")])
cases << run("a migration completed 9 minutes ago", U, [migration_row(1, completed_at: "2026-11-04 12:21:45")])
cases << run("a completed migration with no completion time", U, [migration_row(1, completed_at: nil)])
cases << run("a migration with no user", U, [migration_row(1, nil)])
cases << run("a migration of a user that does not exist", U, [migration_row(1, 9)])
cases << run("a migration of a deleted user", [user_row(1, deleted_at: SEEDED_AT)], [migration_row(1)])
cases << run("a migration of a user suspended for fraud", [user_row(1, user_risk_state: "suspended_for_fraud")], [migration_row(1)])
cases << run("a migration of a user suspended for a tos violation", [user_row(1, user_risk_state: "suspended_for_tos_violation")], [migration_row(1)])
cases << run("a migration of a flagged user", [user_row(1, user_risk_state: "flagged_for_fraud")], [migration_row(1)])
cases << run("a migration of a user on probation", [user_row(1, user_risk_state: "on_probation")], [migration_row(1)])
cases << run("a migration of a user with a blank email and no unconfirmed email", [user_row(1, email: "")], [migration_row(1)])
cases << run("a migration of a user with a null email", [user_row(1, email: nil)], [migration_row(1)])
cases << run("a migration of a user with a blank email and an unconfirmed email", [user_row(1, email: "", unconfirmed_email: "new1@example.com")], [migration_row(1)])
cases << run("a migration of a user with both emails blank", [user_row(1, email: "", unconfirmed_email: "")], [migration_row(1)])
cases << run("a migration whose failed email is the email", U, [migration_row(1, notification_failed_email: "seller1@example.com")])
cases << run("a migration whose failed email is another address", U, [migration_row(1, notification_failed_email: "old@example.com")])
cases << run("a migration whose failed email is the unconfirmed email", [user_row(1, unconfirmed_email: "new1@example.com")], [migration_row(1, notification_failed_email: "new1@example.com")])
cases << run("a migration whose failed email is the old email of a user with an unconfirmed email", [user_row(1, unconfirmed_email: "new1@example.com")], [migration_row(1, notification_failed_email: "seller1@example.com")])
cases << run("a migration whose failed email is empty", U, [migration_row(1, notification_failed_email: "")])
cases << run("a migration whose failed email differs by case", U, [migration_row(1, notification_failed_email: "SELLER1@example.com")])
cases << run("a migration whose user has an empty unconfirmed email", [user_row(1, unconfirmed_email: "")], [migration_row(1, notification_failed_email: "seller1@example.com")])
cases << run("two parts of one user", U, [migration_row(1, 1), migration_row(2, 1, part: 2)])
cases << run("migrations of three users", U, [migration_row(3, 3), migration_row(1, 1), migration_row(2, 2, status: "failed")])
cases << run("one eligible migration among others", U, [migration_row(1, notified_at: DUE), migration_row(2, 2, status: "claimed"), migration_row(3)])
cases << run("a thousand and one eligible migrations", (1..1001).map { |id| user_row(id) }, (1..1001).map { |id| migration_row(id) })

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
