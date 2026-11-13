# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/partner-migration-notification-job.golden.json: PartnerMigrationNotificationJob run by
# the real app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). The result email is what Node hands back
# (CreatorMailer#partner_migration_finished, then the notified_at update); those cases are recorded up to the mailer call, which a
# marker exception stands in for. Every other path (nothing to send, or a quiet `notify_parts`) runs in Node. Run it like
# pdf-unstampable-notifier-job.rb (env as in publish-scheduled-post.rb, USE_DB_WORKER_REPLICAS=true).
require "digest"
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/partner-migration-notification-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
DONE_AT = "2026-11-04 12:00:00"
TABLES = %w[partner_migrations users].freeze
PASSWORD = "encrypted-password"

Rails.logger = ActiveSupport::Logger.new(nil)

class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

CreatorMailer.singleton_class.prepend(Module.new do
  def partner_migration_finished(*, **) = raise(HandBackMarker)
end)

def at(seconds_from_now) = (NOW + seconds_from_now).utc.strftime("%Y-%m-%d %H:%M:%S.%6N")

def user_row(id, **overrides)
  { id:, email: "seller#{id}@example.com", username: "seller#{id}", external_id: (1000 + id).to_s, recommendation_type: "own_products",
    user_risk_state: "compliant", flags: 0, confirmed_at: nil, encrypted_password: PASSWORD, sign_in_count: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def migration_row(id, part: 1, **overrides)
  { id:, oauth_application_id: 1, external_user_id: "ext", public_id: "pm#{id}", code_digest: "digest#{id}", products: "[]", status: "completed",
    user_id: 1, expires_at: "2027-01-01 00:00:00", completed_at: DONE_AT, part:, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

# An account the setup email can still be used for.
def setup(**overrides)
  { account_created: 1, account_setup_token_digest: "token", account_setup_password_digest: Digest::SHA256.hexdigest(PASSWORD), claimed_at: at(-60) }.merge(overrides)
end

U = [user_row(1)].freeze

def run(name, migrations, users = U, args = [1])
  hands_back = false
  result = capture(name, now: NOW, tables: TABLES, seed: { users:, partner_migrations: migrations }, sidekiq: true, job: "PartnerMigrationNotificationJob", args:) do
    PartnerMigrationNotificationJob.new.perform(*args)
  rescue HandBackMarker
    hands_back = true
  end
  result.delete("rows")
  result.delete("seed")
  result.merge("hands_back" => hands_back)
end

cases = []
cases << run("no migrations", [])
cases << run("a migration that does not exist", [migration_row(1)], U, [9])
cases << run("a nil migration id", [migration_row(1)], U, [nil])
cases << run("a migration id given as a String", [migration_row(1)], U, ["1"])
cases << run("a completed migration with an active user", [migration_row(1)])
cases << run("a failed migration", [migration_row(1, status: "failed")])
cases << run("a failed migration already notified of a failure", [migration_row(1, status: "failed", failure_notified_at: DONE_AT)])
cases << run("a completed migration whose failure was notified before", [migration_row(1, failure_notified_at: DONE_AT)])
cases << run("a migration not completed", [migration_row(1, completed_at: nil)])
cases << run("a migration already notified", [migration_row(1, notified_at: DONE_AT)])
cases << run("two parts, both completed", [migration_row(1), migration_row(2, part: 2)])
cases << run("two parts, the second still running", [migration_row(1), migration_row(2, part: 2, completed_at: nil, status: "claimed")])
cases << run("two parts, the first notified and the second not", [migration_row(1, notified_at: DONE_AT), migration_row(2, part: 2)])
cases << run("two parts, both notified", [migration_row(1, notified_at: DONE_AT), migration_row(2, part: 2, notified_at: DONE_AT)])
cases << run("two parts, the second failed", [migration_row(1), migration_row(2, part: 2, status: "failed")])
cases << run("two parts, the second failed and already notified of a failure", [migration_row(1, failure_notified_at: DONE_AT), migration_row(2, part: 2, status: "failed")])
cases << run("the second part's job", [migration_row(1), migration_row(2, part: 2)], U, [2])
cases << run("the second part's job when the first has not finished", [migration_row(1, completed_at: nil), migration_row(2, part: 2)], U, [2])
cases << run("a second part whose first part is gone", [migration_row(2, part: 2)], U, [2])
cases << run("three parts of two catalogs", [migration_row(1), migration_row(2, part: 2), migration_row(3, external_user_id: "other", code_digest: "d3", public_id: "p3", completed_at: nil)])
cases << run("a migration with no user", [migration_row(1, user_id: nil)])
cases << run("a migration whose user does not exist", [migration_row(1, user_id: 9)])
cases << run("a deleted user", [migration_row(1)], [user_row(1, deleted_at: SEEDED_AT)])
cases << run("a user suspended for fraud", [migration_row(1)], [user_row(1, user_risk_state: "suspended_for_fraud")])
cases << run("a user suspended for a tos violation", [migration_row(1)], [user_row(1, user_risk_state: "suspended_for_tos_violation")])
cases << run("a user flagged for fraud", [migration_row(1)], [user_row(1, user_risk_state: "flagged_for_fraud")])
cases << run("a user with an unconfirmed email", [migration_row(1)], [user_row(1, unconfirmed_email: "new@example.com")])
cases << run("a user with a blank unconfirmed email", [migration_row(1)], [user_row(1, unconfirmed_email: "")])
cases << run("a user with no email", [migration_row(1)], [user_row(1, email: nil)])
cases << run("a user with a blank email", [migration_row(1)], [user_row(1, email: "")])
cases << run("a user with a blank email and an unconfirmed one", [migration_row(1)], [user_row(1, email: "", unconfirmed_email: "new@example.com")])
cases << run("a failed address equal to the user's email", [migration_row(1, notification_failed_email: "seller1@example.com")])
cases << run("a failed address different from the user's email", [migration_row(1, notification_failed_email: "old@example.com")])
cases << run("a failed address equal to the unconfirmed email", [migration_row(1, notification_failed_email: "new@example.com")], [user_row(1, unconfirmed_email: "new@example.com")])
cases << run("a failed address equal to the old email while an unconfirmed one exists", [migration_row(1, notification_failed_email: "seller1@example.com")], [user_row(1, unconfirmed_email: "new@example.com")])
cases << run("a failed address different in case", [migration_row(1, notification_failed_email: "SELLER1@example.com")])
cases << run("an open account setup", [migration_row(1, **setup)])
cases << run("an open account setup and a failed migration", [migration_row(1, status: "failed", **setup)])
cases << run("an open account setup and a failed migration already notified", [migration_row(1, status: "failed", failure_notified_at: DONE_AT, **setup)])
cases << run("an open account setup with a second part that failed", [migration_row(1, **setup), migration_row(2, part: 2, status: "failed")])
cases << run("an account setup not created by the migration", [migration_row(1, **setup(account_created: 0))])
cases << run("an account setup with no token digest", [migration_row(1, **setup(account_setup_token_digest: nil))])
cases << run("an account setup with a blank token digest", [migration_row(1, **setup(account_setup_token_digest: ""))])
cases << run("an account setup with no user", [migration_row(1, user_id: nil, **setup)])
cases << run("an account setup of a missing user", [migration_row(1, user_id: 9, **setup)])
cases << run("an account setup of a deleted user", [migration_row(1, **setup)], [user_row(1, deleted_at: SEEDED_AT)])
cases << run("an account setup of a suspended user", [migration_row(1, **setup)], [user_row(1, user_risk_state: "suspended_for_fraud")])
cases << run("an account setup of a user who signed in", [migration_row(1, **setup)], [user_row(1, sign_in_count: 1)])
cases << run("an account setup of a user with no sign in count", [migration_row(1, **setup)], [user_row(1, sign_in_count: nil)])
cases << run("an account setup whose password changed", [migration_row(1, **setup(account_setup_password_digest: "other"))])
cases << run("an account setup with no password digest", [migration_row(1, **setup(account_setup_password_digest: nil))])
cases << run("an account setup never claimed", [migration_row(1, **setup(claimed_at: nil))])
cases << run("an account setup claimed just under 7 days ago", [migration_row(1, **setup(claimed_at: at(-7 * 86_400 + 1)))])
cases << run("an account setup claimed exactly 7 days ago", [migration_row(1, **setup(claimed_at: at(-7 * 86_400)))])
cases << run("an account setup claimed just over 7 days ago", [migration_row(1, **setup(claimed_at: at(-7 * 86_400 - 1)))])
cases << run("an open account setup of a user with no email", [migration_row(1, **setup)], [user_row(1, email: "")])
cases << run("an open account setup of a user with a failed address", [migration_row(1, notification_failed_email: "seller1@example.com", **setup)])

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
