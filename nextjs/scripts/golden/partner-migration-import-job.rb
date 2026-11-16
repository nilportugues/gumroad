# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/partner-migration-import-job.golden.json: PartnerMigrationImportJob run by the real app
# against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). The job locks the migration row; a migration that is no
# longer claimed ends there, or re-enqueues its notification (the push Node hands back), and a claimed one is recorded up to the
# `import_started_at` write, which a marker exception stands in for. Run it like partner-migration-notification-job.rb
# (env as in publish-scheduled-post.rb, USE_DB_WORKER_REPLICAS=true).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/partner-migration-import-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
DONE_AT = "2026-11-04 12:00:00"
TABLES = %w[partner_migrations users].freeze

Rails.logger = ActiveSupport::Logger.new(nil)

class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

PartnerMigration.prepend(Module.new do
  def update!(attributes)
    raise HandBackMarker if attributes.is_a?(Hash) && attributes.key?(:import_started_at)

    super
  end
end)
PartnerMigrationNotificationJob.singleton_class.prepend(Module.new do
  def perform_async(*) = raise(HandBackMarker)
end)

def migration_row(id, part: 1, **overrides)
  { id:, oauth_application_id: 1, external_user_id: "ext", public_id: "pm#{id}", code_digest: "digest#{id}", products: "[]", status: "claimed",
    user_id: 1, expires_at: "2027-01-01 00:00:00", part:, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def run(name, migrations, args = [1])
  hands_back = false
  result = capture(name, now: NOW, tables: TABLES, seed: { partner_migrations: migrations }, sidekiq: true, job: "PartnerMigrationImportJob", args:) do
    PartnerMigrationImportJob.new.perform(*args)
  rescue HandBackMarker
    hands_back = true
  end
  result.delete("rows")
  result.delete("seed")
  result.merge("hands_back" => hands_back)
end

cases = []
cases << run("no migrations", [])
cases << run("a migration that does not exist", [migration_row(1)], [9])
cases << run("a nil migration id", [migration_row(1)], [nil])
cases << run("a migration id given as a String", [migration_row(1)], ["1"])
cases << run("a migration id given as a float", [migration_row(1)], [1.0])
cases << run("a migration id given as a word", [migration_row(1)], ["one"])
cases << run("a claimed migration", [migration_row(1)])
cases << run("a claimed migration among others", [migration_row(1), migration_row(2, part: 2), migration_row(3, external_user_id: "other", code_digest: "d3", public_id: "p3")], [2])
cases << run("a claimed migration whose import already started", [migration_row(1, import_started_at: DONE_AT)])
cases << run("a claimed migration that has a completion time", [migration_row(1, completed_at: DONE_AT)])
cases << run("a pending migration", [migration_row(1, status: "pending")])
cases << run("a completed migration", [migration_row(1, status: "completed", completed_at: DONE_AT)])
cases << run("a failed migration with a completion time", [migration_row(1, status: "failed", completed_at: DONE_AT)])
cases << run("a failed migration with no completion time", [migration_row(1, status: "failed")])
cases << run("a completed migration with no completion time", [migration_row(1, status: "completed")])
cases << run("a pending migration with a completion time", [migration_row(1, status: "pending", completed_at: DONE_AT)])
cases << run("a second part that is no longer claimed", [migration_row(1), migration_row(2, part: 2, status: "completed", completed_at: DONE_AT)], [2])
cases << run("no arguments", [migration_row(1)], [])
cases << run("two arguments", [migration_row(1)], [1, 2])

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
