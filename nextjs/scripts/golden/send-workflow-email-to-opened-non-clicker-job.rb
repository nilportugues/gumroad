# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/send-workflow-email-to-opened-non-clicker-job.golden.json:
# SendWorkflowEmailToOpenedNonClickerJob run by the real app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb).
# A send that passes every check is what Node hands back (`send_installment_from_workflow_for_opened_no_click` reads DynamoDB, the sale
# and its subscription, then mails); those cases are recorded up to that call, which a marker exception stands in for. Run it like
# pdf-unstampable-notifier-job.rb (env as in publish-scheduled-post.rb, USE_DB_WORKER_REPLICAS=true).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/send-workflow-email-to-opened-non-clicker-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[installments workflows users installment_rules feature_announcement_newsletter_cutovers].freeze
TRIGGER = '{"workflow_trigger":"opened_no_click"}'

Rails.logger = ActiveSupport::Logger.new(nil)

class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

Installment.prepend(Module.new do
  def send_installment_from_workflow_for_opened_no_click(*, **) = raise(HandBackMarker)
end)

def user_row(id, **overrides)
  { id:, email: "seller#{id}@example.com", username: "seller#{id}", external_id: (1000 + id).to_s, recommendation_type: "own_products",
    user_risk_state: "compliant", flags: 0, confirmed_at: nil, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def workflow_row(id, **overrides) = { id:, name: "Workflow #{id}", seller_id: 1, workflow_type: "seller", json_data: TRIGGER, flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)

def installment_row(id, **overrides)
  { id:, workflow_id: 1, seller_id: 1, name: "Email #{id}", installment_type: "seller", published_at: SEEDED_AT, flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def rule_row(id, installment_id, version, **overrides) = { id:, installment_id:, version:, delayed_delivery_time: 86_400, time_period: "day", created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)

def cutover_row(id, seller_id, state) = { id:, seller_id:, state:, cutoff_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT }

BASE = { users: [user_row(1)], workflows: [workflow_row(1)], installments: [installment_row(1)], installment_rules: [rule_row(1, 1, 3)], feature_announcement_newsletter_cutovers: [] }.freeze

def run(name, args = [1, 3, 5, "digest"], **seed)
  hands_back = false
  data = BASE.merge(seed)
  result = capture(name, now: NOW, tables: TABLES, seed: data, sidekiq: true, job: "SendWorkflowEmailToOpenedNonClickerJob", args:) do
    SendWorkflowEmailToOpenedNonClickerJob.new.perform(*args)
  rescue HandBackMarker
    hands_back = true
  end
  result.delete("rows")
  result.delete("seed")
  result.merge("hands_back" => hands_back)
end

cases = []
cases << run("an email that passes every check")
cases << run("an email that does not exist", [99, 3, 5, "digest"])
cases << run("a nil installment id", [nil, 3, 5, "digest"])
cases << run("an installment id given as a String", ["1", 3, 5, "digest"])
cases << run("an email with no workflow", installments: [installment_row(1, workflow_id: nil)])
cases << run("an email of a workflow that does not exist", installments: [installment_row(1, workflow_id: 9)])
cases << run("a workflow with another trigger", workflows: [workflow_row(1, json_data: '{"workflow_trigger":"member_cancellation"}')])
cases << run("a workflow with no trigger", workflows: [workflow_row(1, json_data: "{}")])
cases << run("a workflow with no json data", workflows: [workflow_row(1, json_data: nil)])
cases << run("a deleted workflow", workflows: [workflow_row(1, deleted_at: SEEDED_AT)])
cases << run("a deleted email", installments: [installment_row(1, deleted_at: SEEDED_AT)])
cases << run("an email that is not published", installments: [installment_row(1, published_at: nil)])
cases << run("an email with no seller", installments: [installment_row(1, seller_id: nil)])
cases << run("an email whose seller does not exist", installments: [installment_row(1, seller_id: 9)])
cases << run("a seller suspended for fraud", users: [user_row(1, user_risk_state: "suspended_for_fraud")])
cases << run("a seller suspended for a tos violation", users: [user_row(1, user_risk_state: "suspended_for_tos_violation")])
cases << run("a seller flagged for fraud", users: [user_row(1, user_risk_state: "flagged_for_fraud")])
cases << run("a seller on probation", users: [user_row(1, user_risk_state: "on_probation")])
%w[follower audience].each do |type|
  cases << run("#{type == "audience" ? "an" : "a"} #{type} email with no cutover", installments: [installment_row(1, installment_type: type)])
  cases << run("#{type == "audience" ? "an" : "a"} #{type} email of a retired newsletter", installments: [installment_row(1, installment_type: type)], feature_announcement_newsletter_cutovers: [cutover_row(1, 1, "retired")])
  cases << run("#{type == "audience" ? "an" : "a"} #{type} email of a newsletter still in cutover", installments: [installment_row(1, installment_type: type)], feature_announcement_newsletter_cutovers: [cutover_row(1, 1, "cutting_over")])
  cases << run("#{type == "audience" ? "an" : "a"} #{type} email of another seller's retired newsletter", installments: [installment_row(1, installment_type: type)], feature_announcement_newsletter_cutovers: [cutover_row(1, 2, "retired")])
  cases << run("#{type == "audience" ? "an" : "a"} #{type} email with no seller", installments: [installment_row(1, installment_type: type, seller_id: nil)])
  cases << run("#{type == "audience" ? "an" : "a"} #{type} email of a suspended seller with a retired newsletter", installments: [installment_row(1, installment_type: type)], users: [user_row(1, user_risk_state: "suspended_for_fraud")], feature_announcement_newsletter_cutovers: [cutover_row(1, 1, "retired")])
end
cases << run("a product email of a retired newsletter", installments: [installment_row(1, installment_type: "product")], feature_announcement_newsletter_cutovers: [cutover_row(1, 1, "retired")])
cases << run("a seller email of a retired newsletter", feature_announcement_newsletter_cutovers: [cutover_row(1, 1, "retired")])
cases << run("an email with no rule", installment_rules: [])
cases << run("a rule newer than the job", [1, 2, 5, "digest"])
cases << run("a rule older than the job", [1, 4, 5, "digest"])
cases << run("a job version of zero", [1, 0, 5, "digest"])
cases << run("a nil job version", [1, nil, 5, "digest"])
cases << run("a job version given as a String", [1, "3", 5, "digest"])
cases << run("a job version given as a Float equal to the rule's", [1, 3.0, 5, "digest"])
cases << run("a rule that was deleted", installment_rules: [rule_row(1, 1, 3, deleted_at: SEEDED_AT)])
cases << run("a blank digest and nil purchase", [1, 3, nil, nil])
cases << run("a workflow with other keys next to the trigger", workflows: [workflow_row(1, json_data: '{"a":1,"workflow_trigger":"opened_no_click"}')])
cases << run("a workflow with a trigger of another case", workflows: [workflow_row(1, json_data: '{"workflow_trigger":"Opened_No_Click"}')])

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
