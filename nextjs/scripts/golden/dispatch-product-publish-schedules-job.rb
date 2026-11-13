# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/dispatch-product-publish-schedules-job.golden.json: DispatchProductPublishSchedulesJob run
# by the real app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). A stale claim is what Node hands back
# (`recover_stale_claim!` reads the product and writes the outcome); those cases are recorded up to that call, which a marker exception
# stands in for. Run it like pdf-unstampable-notifier-job.rb (env as in publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/dispatch-product-publish-schedules-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[product_publish_schedules].freeze

Rails.logger = ActiveSupport::Logger.new(nil)

class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

ProductPublishSchedule.prepend(Module.new do
  def recover_stale_claim! = raise(HandBackMarker)
end)

def schedule_row(id, **overrides)
  { id:, product_id: id, scheduled_by_id: 1, publish_at: "2026-11-04 12:00:00", status: "scheduled", created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def run(name, rows)
  hands_back = false
  result = capture(name, now: NOW, tables: TABLES, seed: { product_publish_schedules: rows }, sidekiq: true, job: "DispatchProductPublishSchedulesJob", args: []) do
    DispatchProductPublishSchedulesJob.new.perform
  rescue HandBackMarker
    hands_back = true
  end
  result.delete("rows")
  result.delete("seed")
  result.merge("hands_back" => hands_back)
end

CLAIMED = "2026-11-04 12:00:00"
OLD = "2026-11-04 12:00:00"

cases = []
cases << run("no schedules", [])
cases << run("a due schedule", [schedule_row(1)])
cases << run("a schedule due this instant", [schedule_row(1, publish_at: "2026-11-04 12:30:45.123")])
cases << run("a schedule due a millisecond from now", [schedule_row(1, publish_at: "2026-11-04 12:30:45.124")])
cases << run("a schedule not due", [schedule_row(1, publish_at: "2026-11-04 13:00:00")])
cases << run("several due schedules", [schedule_row(3), schedule_row(1), schedule_row(2, publish_at: "2026-11-05 00:00:00")])
cases << run("a due schedule that is being published", [schedule_row(1, status: "publishing", claimed_at: "2026-11-04 12:30:00")])
cases << run("a schedule that is published and already noticed", [schedule_row(1, status: "published", notice_sent_at: OLD, updated_at: OLD)])
cases << run("a schedule that is failed and already noticed", [schedule_row(1, status: "failed", notice_sent_at: OLD, updated_at: OLD)])
cases << run("a published schedule with its notice unsent", [schedule_row(1, status: "published", updated_at: OLD)])
cases << run("a failed schedule with its notice unsent", [schedule_row(1, status: "failed", failure_message: "no", updated_at: OLD)])
cases << run("a notice unsent for 3 minutes", [schedule_row(1, status: "published", updated_at: "2026-11-04 12:27:45.123")])
cases << run("a notice unsent for 2 minutes", [schedule_row(1, status: "published", updated_at: "2026-11-04 12:28:45.123")])
cases << run("a notice unsent for 2 minutes less a millisecond", [schedule_row(1, status: "published", updated_at: "2026-11-04 12:28:45.124")])
cases << run("a notice unsent for a minute", [schedule_row(1, status: "published", updated_at: "2026-11-04 12:29:45")])
cases << run("a scheduled row with its notice unsent", [schedule_row(1, publish_at: "2026-11-05 00:00:00", updated_at: OLD)])
cases << run("two notices unsent", [schedule_row(2, status: "published", updated_at: OLD), schedule_row(1, status: "failed", updated_at: OLD)])
cases << run("a due schedule and a notice unsent", [schedule_row(1), schedule_row(2, status: "published", updated_at: OLD)])
cases << run("a claim held for 14 minutes", [schedule_row(1, status: "publishing", claimed_at: "2026-11-04 12:16:45")])
cases << run("a claim held for 15 minutes", [schedule_row(1, status: "publishing", claimed_at: "2026-11-04 12:15:45.123")])
cases << run("a claim held for 15 minutes less a millisecond", [schedule_row(1, status: "publishing", claimed_at: "2026-11-04 12:15:45.124")])
cases << run("a claim held for 16 minutes", [schedule_row(1, status: "publishing", claimed_at: "2026-11-04 12:14:45")])
cases << run("a stale claim and a due schedule", [schedule_row(1), schedule_row(2, status: "publishing", claimed_at: "2026-11-04 11:00:00")])
cases << run("a stale claim and a notice unsent", [schedule_row(1, status: "published", updated_at: OLD), schedule_row(2, status: "publishing", claimed_at: "2026-11-04 11:00:00")])
cases << run("a publishing row with no claim time", [schedule_row(1, status: "publishing")])
cases << run("a stale claim among fresh ones", [schedule_row(1, status: "publishing", claimed_at: "2026-11-04 12:30:00"), schedule_row(2, status: "publishing", claimed_at: "2026-11-04 11:00:00")])

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
