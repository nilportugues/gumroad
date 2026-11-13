# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/schedule-opened-no-click-workflow-emails-job.golden.json:
# ScheduleOpenedNoClickWorkflowEmailsJob run by the real app against a scratch database as a Sidekiq job
# (support/sidekiq_executor.rb). Each case's Redis snapshot holds the SendWorkflowEmailsToOpenedNonClickersJob pushes. Run it like
# pdf-unstampable-notifier-job.rb (env as in publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/schedule-opened-no-click-workflow-emails-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[installments workflows].freeze
TRIGGER = '{"workflow_trigger":"opened_no_click"}'

Rails.logger = ActiveSupport::Logger.new(nil)

def workflow_row(id, **overrides) = { id:, name: "Workflow #{id}", seller_id: 1, workflow_type: "seller", json_data: TRIGGER, flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)

def installment_row(id, workflow_id = 1, **overrides)
  { id:, workflow_id:, name: "Email #{id}", installment_type: "workflow", published_at: SEEDED_AT, flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def run(name, workflows, installments)
  result = capture(name, now: NOW, tables: TABLES, seed: { workflows:, installments: }, sidekiq: true, job: "ScheduleOpenedNoClickWorkflowEmailsJob", args: []) do
    ScheduleOpenedNoClickWorkflowEmailsJob.new.perform
  end
  result.delete("rows")
  result.delete("seed")
  result
end

W = [workflow_row(1)].freeze

cases = []
cases << run("no installments", W, [])
cases << run("no workflows", [], [installment_row(1)])
cases << run("a published email of an opened no click workflow", W, [installment_row(1)])
cases << run("an email that is not published", W, [installment_row(1, published_at: nil)])
cases << run("a deleted email", W, [installment_row(1, deleted_at: SEEDED_AT)])
cases << run("a deleted workflow", [workflow_row(1, deleted_at: SEEDED_AT)], [installment_row(1)])
cases << run("an unpublished workflow", [workflow_row(1, published_at: nil)], [installment_row(1)])
cases << run("a workflow with another trigger", [workflow_row(1, json_data: '{"workflow_trigger":"member_cancellation"}')], [installment_row(1)])
cases << run("a workflow with no trigger", [workflow_row(1, json_data: "{}")], [installment_row(1)])
cases << run("a workflow with no json data", [workflow_row(1, json_data: nil)], [installment_row(1)])
cases << run("a workflow with a trigger of another case", [workflow_row(1, json_data: '{"workflow_trigger":"Opened_No_Click"}')], [installment_row(1)])
cases << run("a workflow with other keys next to the trigger", [workflow_row(1, json_data: '{"a":1,"workflow_trigger":"opened_no_click"}')], [installment_row(1)])
cases << run("an email with no workflow", W, [installment_row(1, nil)])
cases << run("an email of a workflow that does not exist", W, [installment_row(1, 9)])
cases << run("emails of two workflows", [workflow_row(1), workflow_row(2)], [installment_row(2, 2), installment_row(1, 1), installment_row(3, 1)])
cases << run("an email of a workflow with another trigger next to one that matches", [workflow_row(1), workflow_row(2, json_data: "{}")], [installment_row(1, 2), installment_row(2, 1)])
cases << run("200 emails", W, (1..200).map { |id| installment_row(id) })
cases << run("201 emails", W, (1..201).map { |id| installment_row(id) })
cases << run("401 emails", W, (1..401).map { |id| installment_row(id) })

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
