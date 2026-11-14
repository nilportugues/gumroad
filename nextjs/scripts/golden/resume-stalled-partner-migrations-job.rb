# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/resume-stalled-partner-migrations-job.golden.json: ResumeStalledPartnerMigrationsJob run
# by the real app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). A stalled migration is what Node hands
# back (`resume_stalled_import!` locks the row, enqueues the import or fails the migration); those cases are recorded up to that call,
# which a marker exception stands in for. Run it like pdf-unstampable-notifier-job.rb (env as in publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/resume-stalled-partner-migrations-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[partner_migrations].freeze
STALLED = "2026-11-04 01:00:00"

Rails.logger = ActiveSupport::Logger.new(nil)

class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

PartnerMigration.prepend(Module.new do
  def resume_stalled_import! = raise(HandBackMarker)
end)

def migration_row(id, **overrides)
  { id:, oauth_application_id: 1, external_user_id: "ext#{id}", public_id: "pm#{id}", code_digest: "digest#{id}", products: "[]", status: "claimed",
    user_id: id, expires_at: "2027-01-01 00:00:00", import_started_at: STALLED, created_at: SEEDED_AT, updated_at: STALLED }.merge(overrides)
end

def run(name, rows)
  hands_back = false
  result = capture(name, now: NOW, tables: TABLES, seed: { partner_migrations: rows }, sidekiq: true, job: "ResumeStalledPartnerMigrationsJob", args: []) do
    ResumeStalledPartnerMigrationsJob.new.perform
  rescue HandBackMarker
    hands_back = true
  end
  result.delete("rows")
  result.delete("seed")
  result.merge("hands_back" => hands_back)
end

cases = []
cases << run("no migrations", [])
cases << run("a stalled migration", [migration_row(1)])
cases << run("a claimed migration touched a minute ago", [migration_row(1, updated_at: "2026-11-04 12:29:45")])
cases << run("a claimed migration touched 6 hours ago", [migration_row(1, updated_at: "2026-11-04 06:30:45.123")])
cases << run("a claimed migration touched 6 hours ago less a millisecond", [migration_row(1, updated_at: "2026-11-04 06:30:45.124")])
cases << run("a claimed migration touched just over 6 hours ago", [migration_row(1, updated_at: "2026-11-04 06:30:45.122")])
cases << run("a claimed migration whose import never started", [migration_row(1, import_started_at: nil)])
cases << run("a pending migration", [migration_row(1, status: "pending")])
cases << run("a completed migration", [migration_row(1, status: "completed")])
cases << run("a failed migration", [migration_row(1, status: "failed")])
cases << run("stalled migrations among others", [migration_row(1, status: "completed"), migration_row(2), migration_row(3, import_started_at: nil), migration_row(4)])

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
