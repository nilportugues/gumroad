# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/publish-scheduled-product-job.golden.json: PublishScheduledProductJob run by the real
# app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). A schedule that is found is what Node hands back
# (`run!` claims it with an UPDATE, then publishes the product); those cases are recorded up to that call, which a marker exception
# stands in for. Run it like pdf-unstampable-notifier-job.rb (env as in publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/publish-scheduled-product-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[product_publish_schedules].freeze

Rails.logger = ActiveSupport::Logger.new(nil)

class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

ProductPublishSchedule.prepend(Module.new do
  def run!(*, **) = raise(HandBackMarker)
end)

def schedule_row(id, **overrides)
  { id:, product_id: id, scheduled_by_id: 1, publish_at: "2026-11-04 12:00:00", status: "scheduled", created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def run(name, args, rows)
  hands_back = false
  result = capture(name, now: NOW, tables: TABLES, seed: { product_publish_schedules: rows }, sidekiq: true, job: "PublishScheduledProductJob", args:) do
    PublishScheduledProductJob.new.perform(*args)
  rescue HandBackMarker
    hands_back = true
  end
  result.delete("rows")
  result.delete("seed")
  result.merge("hands_back" => hands_back)
end

S = [schedule_row(1), schedule_row(2)].freeze

cases = []
cases << run("a schedule that does not exist", [9], S)
cases << run("a due schedule", [1], S)
cases << run("a schedule among others", [2], S)
cases << run("a schedule not yet due", [1], [schedule_row(1, publish_at: "2026-11-05 00:00:00")])
cases << run("a schedule being published", [1], [schedule_row(1, status: "publishing", claimed_at: "2026-11-04 12:30:00")])
cases << run("a published schedule", [1], [schedule_row(1, status: "published")])
cases << run("a failed schedule", [1], [schedule_row(1, status: "failed")])
cases << run("the schedule id as a digit string", ["2"], S)
cases << run("the schedule id as a digit string that does not exist", ["9"], S)
cases << run("a schedule id of nil", [nil], S)
cases << run("a schedule id as a float", [1.0], S)
cases << run("a schedule id as a float with a fraction", [1.5], S)
cases << run("a schedule id as a word", ["one"], S)
cases << run("a schedule id as a digit string with text", ["1x"], S)
cases << run("a schedule id of zero", [0], S)
cases << run("a negative schedule id", [-1], S)
cases << run("a schedule id as true", [true], S)
cases << run("a schedule id as an array", [[1]], S)
cases << run("no arguments", [], S)
cases << run("two arguments", [1, 2], S)

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
