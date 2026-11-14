# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/send-workflow-emails-to-opened-non-clickers-job.golden.json:
# SendWorkflowEmailsToOpenedNonClickersJob run by the real app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb).
# The guards before the trigger post are reads of the installment and its workflow; a run that passes them goes on to resolve the post
# through the seller's emailed posts and to the rule, the seller fanout lock, DynamoDB and the sends, which Node hands back to Rails.
# Those cases are recorded up to `Workflow#workflow_trigger_post`, which a marker exception stands in for. A run is checked to hold
# nothing but SELECT, SET and SHOW statements. Run it like pdf-unstampable-notifier-job.rb (env as in publish-scheduled-post.rb,
# USE_DB_WORKER_REPLICAS=true).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/send-workflow-emails-to-opened-non-clickers-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[installments workflows].freeze
TRIGGER = '{"workflow_trigger":"opened_no_click","workflow_trigger_post_id":"abc"}'

Rails.logger = ActiveSupport::Logger.new(nil)

class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

Workflow.prepend(Module.new do
  def workflow_trigger_post = raise(HandBackMarker)
end)

def workflow_row(id, **overrides) = { id:, name: "Workflow #{id}", seller_id: 1, workflow_type: "seller", json_data: TRIGGER, flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)

def installment_row(id, **overrides)
  { id:, workflow_id: 1, seller_id: 1, name: "Email #{id}", installment_type: "seller", published_at: SEEDED_AT, flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

BASE = { workflows: [workflow_row(1)], installments: [installment_row(1)] }.freeze

def run(name, args = [1], **seed)
  hands_back = false
  data = BASE.merge(seed)
  result = capture(name, now: NOW, tables: TABLES, seed: data, sidekiq: true, job: "SendWorkflowEmailsToOpenedNonClickersJob", args:) do
    SendWorkflowEmailsToOpenedNonClickersJob.new.perform(*args)
  rescue HandBackMarker
    hands_back = true
  end
  result.delete("rows")
  result.delete("seed")
  unless result["statements"].all? { |s| s["sql"].match?(/\A\s*(SELECT|SET|SHOW)\b/i) }
    raise "#{name}: a write ran before the marker"
  end
  result.merge("hands_back" => hands_back)
end

cases = []
cases << run("an email that passes every guard")
cases << run("an email that passes every guard on a daily scan", [1, 172_800])
cases << run("an email that passes every guard with no lookback", [1, nil])
cases << run("an email that passes every guard with an opened_after", [1, nil, "2026-11-01T00:00:00Z"])
cases << run("an email that passes every guard with a minimum rule version", [1, 172_800, nil, 3])
cases << run("an email that passes every guard with a minimum rule version of zero", [1, 172_800, nil, 0])
cases << run("an email that passes every guard with a nil minimum rule version", [1, 172_800, nil, nil])
cases << run("an email that passes every guard with a false minimum rule version", [1, 172_800, nil, false])
cases << run("an email that passes every guard with a minimum rule version as a Float", [1, 172_800, nil, 3.0])
cases << run("an email that passes every guard with a minimum rule version as a String", [1, 172_800, nil, "3"])
cases << run("an email that passes every guard with a blank minimum rule version", [1, 172_800, nil, ""])
cases << run("an email that passes every guard with a minimum rule version as an Array", [1, 172_800, nil, [3]])
cases << run("an email that passes every guard with a minimum rule version of true", [1, 172_800, nil, true])
cases << run("an email that does not exist", [99])
cases << run("an email that does not exist with a minimum rule version", [99, 172_800, nil, 3])
cases << run("a nil installment id", [nil])
cases << run("an installment id given as a String", ["1"])
cases << run("an installment id given as a Float", [1.0])
cases << run("an installment id given as a word", ["one"])
cases << run("an email with no workflow", installments: [installment_row(1, workflow_id: nil)])
cases << run("an email of a workflow that does not exist", installments: [installment_row(1, workflow_id: 9)])
cases << run("a workflow with another trigger", workflows: [workflow_row(1, json_data: '{"workflow_trigger":"member_cancellation"}')])
cases << run("a workflow with no trigger", workflows: [workflow_row(1, json_data: "{}")])
cases << run("a workflow with no json data", workflows: [workflow_row(1, json_data: nil)])
cases << run("a workflow with a trigger of another case", workflows: [workflow_row(1, json_data: '{"workflow_trigger":"Opened_No_Click"}')])
cases << run("a workflow with the trigger and no post", workflows: [workflow_row(1, json_data: '{"workflow_trigger":"opened_no_click"}')])
cases << run("a deleted workflow", workflows: [workflow_row(1, deleted_at: SEEDED_AT)])
cases << run("a deleted email", installments: [installment_row(1, deleted_at: SEEDED_AT)])
cases << run("an email that is not published", installments: [installment_row(1, published_at: nil)])
cases << run("a deleted workflow of another trigger", workflows: [workflow_row(1, deleted_at: SEEDED_AT, json_data: "{}")])
cases << run("an email of a seller other than its workflow's", installments: [installment_row(1, seller_id: 2)])
cases << run("an email with no seller", installments: [installment_row(1, seller_id: nil)])
cases << run("an email among others", [2], installments: [installment_row(1), installment_row(2), installment_row(3, published_at: nil)], workflows: [workflow_row(1), workflow_row(2, json_data: "{}")])
cases << run("an email of the second workflow", [2], installments: [installment_row(1), installment_row(2, workflow_id: 2)], workflows: [workflow_row(1), workflow_row(2, json_data: "{}")])
cases << run("a workflow with other keys next to the trigger", workflows: [workflow_row(1, json_data: '{"a":1,"workflow_trigger":"opened_no_click"}')])
cases << run("no arguments", [])
cases << run("five arguments", [1, 2, 3, 4, 5])

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
