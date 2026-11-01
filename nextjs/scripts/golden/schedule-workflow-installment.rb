# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/schedule-workflow-installment.golden.json: ScheduleWorkflowInstallmentJob
# (and the Workflow#schedule_installment and WorkflowInstallmentScheduleIntent writes it makes) run by the real app against
# a scratch database, each case as a Sidekiq job (support/sidekiq_executor.rb). Run it like workflow-jobs.rb:
#
#   RAILS_ENV=test DATABASE_NAME=gumroad_ws59 TEST_DATABASE_NAME=gumroad_ws59 DISABLE_TEST_REDIS_ISOLATION=1 \
#     USE_DB_WORKER_REPLICAS=true REDIS_HOST=127.0.0.1:6379/7 SIDEKIQ_REDIS_HOST=127.0.0.1:6379/7 \
#     RPUSH_REDIS_HOST=127.0.0.1:6379/7 RACK_ATTACK_REDIS_HOST=127.0.0.1:6379/7 \
#     OBFUSCATE_IDS_CIPHER_KEY=ws59-golden-obfuscate-key OBFUSCATE_IDS_NUMERIC_CIPHER_KEY=123456789 \
#     bundle exec rails runner nextjs/scripts/golden/schedule-workflow-installment.rb
require_relative "support/rails_cases"
include RailsCases
capture_elasticsearch!

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/schedule-workflow-installment.golden.json")
NOW = Time.utc(2025, 11, 1, 12, 30, 45, 123_000)
SEEDED_AT = "2025-01-01 00:00:00"
PUBLISHED_AT = "2025-10-30 09:00:00"
TABLES = %w[users links workflows installments installment_rules workflow_installment_schedule_intents versions].freeze

Stripe.api_base = "http://127.0.0.1:9"
Stripe.max_network_retries = 0
ActiveJob::Base.queue_adapter = :sidekiq
ActiveJob::Base.logger = Logger.new(nil)
Rails.logger = ActiveSupport::Logger.new(nil)

$uuid_seq = 0
SecureRandom.singleton_class.prepend(Module.new do
  def uuid
    $uuid_seq += 1
    format("00000000-0000-4000-8000-%012d", $uuid_seq)
  end
end)

DAY = 86_400
HOUR = 3600
INSTALLMENT_FLAGS = { is_for_new_customers_of_workflow: 6, workflow_installment_published_once_already: 7, send_emails: 9 }.freeze
def installment_flags(*names) = names.sum { 1 << (INSTALLMENT_FLAGS.fetch(_1) - 1) }
WORKFLOW_FLAGS = { send_to_past_customers: 1 }.freeze

def at(time) = time.utc.strftime("%Y-%m-%d %H:%M:%S.%6N")

def user_row(id, **overrides)
  { id:, email: "user#{id}@example.com", username: "user#{id}", external_id: (1000 + id).to_s, recommendation_type: "own_products",
    user_risk_state: "compliant", flags: 0, json_data: nil, confirmed_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def link_row(id = 1, **overrides)
  { id:, name: "Product #{id}", user_id: 1, unique_permalink: "p#{id}", price_currency_type: "usd", flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def workflow_row(id = 1, trigger: nil, **overrides)
  { id:, seller_id: 1, link_id: 1, workflow_type: "product", published_at: SEEDED_AT, json_data: trigger ? { workflow_trigger: trigger }.to_json : nil,
    flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def installment_row(id = 10, **overrides)
  { id:, link_id: 1, seller_id: 1, workflow_id: 1, installment_type: "product", name: "Post #{id}", published_at: PUBLISHED_AT, flags: installment_flags(:send_emails),
    created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def rule_row(id = 10, **overrides)
  { id:, installment_id: id, delayed_delivery_time: HOUR, version: 3, time_period: "hour", created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def intent_row(id = 1, **overrides)
  { id:, token: "tok-#{id}", installment_id: 10, rule_version: 3, old_delayed_delivery_time: nil, cutoff_reference_time: at(NOW - HOUR), expected_published_at: nil,
    dispatch_token: "dispatch-#{id}", dispatch_expires_at: at(NOW + 600), created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def base_seed(**extra)
  { users: [user_row(1)], links: [link_row], workflows: [workflow_row], installments: [installment_row], installment_rules: [rule_row],
    workflow_installment_schedule_intents: [intent_row] }.merge(extra)
end

SJ = "ScheduleWorkflowInstallmentJob"
def run(name, args = ["tok-1", "dispatch-1"], seed: {}, now: NOW)
  $uuid_seq = 0
  result = capture(name, now:, tables: TABLES, seed: base_seed(**seed), sidekiq: true, job: SJ, args:, case_now: now.to_f) { SJ.constantize.new.perform(*args) }
  result.delete("rows")
  result.delete("seed")
  result
end

cases = []
cases << run("intent does not exist", ["missing", nil])
cases << run("intent already processed", seed: { workflow_installment_schedule_intents: [intent_row(processed_at: at(NOW - 60))] })
cases << run("another dispatch holds the intent", ["tok-1", "dispatch-other"], seed: { workflow_installment_schedule_intents: [intent_row(dispatch_token: "dispatch-1", dispatch_expires_at: at(NOW + 600))] })
cases << run("another dispatch holds the intent but has expired", ["tok-1", "dispatch-other"], seed: { workflow_installment_schedule_intents: [intent_row(dispatch_expires_at: at(NOW - 600))] })
cases << run("a fanout holds the intent", ["tok-1", "dispatch-other"], seed: { workflow_installment_schedule_intents: [intent_row(dispatch_token: nil, dispatch_expires_at: nil, fanout_token: "fanout-1", fanout_expires_at: at(NOW + 600))] })
cases << run("no dispatch token given", ["tok-1"], seed: { workflow_installment_schedule_intents: [intent_row(dispatch_token: "dispatch-x")] })
cases << run("installment does not exist", seed: { installments: [], installment_rules: [] })
cases << run("installment without a rule", seed: { installment_rules: [] })
cases << run("rule older than the intent", seed: { workflow_installment_schedule_intents: [intent_row(rule_version: 4)] })
cases << run("installment without a workflow", seed: { installments: [installment_row(workflow_id: nil)] })
cases << run("deleted workflow", seed: { workflows: [workflow_row(deleted_at: SEEDED_AT)] })
cases << run("deleted installment", seed: { installments: [installment_row(deleted_at: SEEDED_AT)] })
cases << run("unpublished installment", seed: { installments: [installment_row(published_at: nil)] })
cases << run("expected publication matches", seed: { workflows: [workflow_row(published_at: PUBLISHED_AT)], workflow_installment_schedule_intents: [intent_row(expected_published_at: PUBLISHED_AT)] })
cases << run("expected publication differs", seed: { workflow_installment_schedule_intents: [intent_row(expected_published_at: "2025-10-29 00:00:00")] })
cases << run("expected publication differs on the installment", seed: { workflows: [workflow_row(published_at: PUBLISHED_AT)], workflow_installment_schedule_intents: [intent_row(expected_published_at: PUBLISHED_AT)], installments: [installment_row(published_at: "2025-10-30 09:00:01")] })
cases << run("new customer workflow, first schedule", seed: { installments: [installment_row(flags: installment_flags(:send_emails))] })
cases << run("new customer workflow for new customers only, first schedule", seed: { installments: [installment_row(flags: installment_flags(:send_emails, :is_for_new_customers_of_workflow))] })
cases << run("new customer workflow, delay edit", seed: { workflow_installment_schedule_intents: [intent_row(old_delayed_delivery_time: 1800)] })
cases << run("new customer workflow, delay edit of a new customers only post", seed: { installments: [installment_row(flags: installment_flags(:send_emails, :is_for_new_customers_of_workflow))], workflow_installment_schedule_intents: [intent_row(old_delayed_delivery_time: 1800)] })
cases << run("abandoned cart installment", seed: { installments: [installment_row(installment_type: "abandoned_cart")] })
cases << run("workflow with another trigger", seed: { workflows: [workflow_row(trigger: "something_else")] })
cases << run("member cancellation workflow", seed: { workflows: [workflow_row(trigger: "member_cancellation")] })
cases << run("member cancellation workflow for past customers", seed: { workflows: [workflow_row(trigger: "member_cancellation", flags: 1)] })
cases << run("member cancellation workflow, delay edit", seed: { workflows: [workflow_row(trigger: "member_cancellation", flags: 1)], workflow_installment_schedule_intents: [intent_row(old_delayed_delivery_time: 1800)] })
cases << run("a fanout of its own already runs", seed: { workflow_installment_schedule_intents: [intent_row(fanout_token: "fanout-old", fanout_expires_at: at(NOW + 600))] })
cases << run("an expired fanout is taken over", seed: { workflow_installment_schedule_intents: [intent_row(fanout_token: "fanout-old", fanout_expires_at: at(NOW - 600))] })

# --- Workflow#schedule_installment and WorkflowInstallmentScheduleIntent.enqueue!, called directly ---------------------
def direct(name, kind, params = {}, seed: {}, now: NOW, &block)
  $uuid_seq = 0
  $return = nil
  result = capture(name, now:, tables: TABLES, seed: base_seed(**seed), sidekiq: true, kind:, params:, case_now: now.to_f) do
    $return = block.call
  end
  result.delete("rows")
  result.delete("seed")
  result.merge("return" => $return.is_a?(WorkflowInstallmentScheduleIntent) ? { "token" => $return.token } : $return&.to_s)
end

reference = NOW - HOUR
schedule = lambda do |name, workflow_seed: {}, installment_seed: {}, **options|
  seed = {}
  seed[:workflows] = [workflow_row(**workflow_seed)] unless workflow_seed.empty?
  seed[:installments] = [installment_row(**installment_seed)] unless installment_seed.empty?
  params = options.transform_values { _1.is_a?(Time) ? _1.iso8601 : _1 }
  cases << direct(name, "schedule_installment", { "workflow" => workflow_seed.to_s, "installment" => installment_seed.to_s, "options" => params }, seed:) do
    workflow = Workflow.find(1)
    workflow.schedule_installment(Installment.find(10), **options)
  end
end
schedule.call("schedule_installment: first schedule", cutoff_reference_time: reference)
schedule.call("schedule_installment: delay edit", old_delayed_delivery_time: 1800, cutoff_reference_time: reference)
schedule.call("schedule_installment: delay edit with recovery", old_delayed_delivery_time: 1800, cutoff_reference_time: reference, reschedule_on_stale: true, minimum_rule_version: 3)
schedule.call("schedule_installment: delay edit of a new customers only post", old_delayed_delivery_time: 1800, cutoff_reference_time: reference, installment_seed: { flags: installment_flags(:send_emails, :is_for_new_customers_of_workflow) })
schedule.call("schedule_installment: delay edit of a new customers only post published after the cutoff", old_delayed_delivery_time: 1800, cutoff_reference_time: NOW, installment_seed: { flags: installment_flags(:send_emails, :is_for_new_customers_of_workflow), published_at: at(NOW - 60) })
schedule.call("schedule_installment: new customers only post, first schedule", cutoff_reference_time: reference, installment_seed: { flags: installment_flags(:send_emails, :is_for_new_customers_of_workflow) })
schedule.call("schedule_installment: with an intent", cutoff_reference_time: reference, minimum_rule_version: 4, schedule_intent_token: "tok-1", schedule_intent_fanout_token: "fanout-1")
schedule.call("schedule_installment: with an intent token only", cutoff_reference_time: reference, schedule_intent_token: "tok-1")
schedule.call("schedule_installment: with a minimum rule version only", cutoff_reference_time: reference, minimum_rule_version: 4)
schedule.call("schedule_installment: abandoned cart", cutoff_reference_time: reference, installment_seed: { installment_type: "abandoned_cart" })
schedule.call("schedule_installment: deleted workflow", cutoff_reference_time: reference, workflow_seed: { deleted_at: SEEDED_AT })
schedule.call("schedule_installment: unpublished installment", cutoff_reference_time: reference, installment_seed: { published_at: nil })
schedule.call("schedule_installment: member cancellation, nothing to send", cutoff_reference_time: reference, workflow_seed: { trigger: "member_cancellation" })
schedule.call("schedule_installment: member cancellation for past customers", cutoff_reference_time: reference, workflow_seed: { trigger: "member_cancellation", flags: 1 })
schedule.call("schedule_installment: member cancellation for past customers with an intent", cutoff_reference_time: reference, minimum_rule_version: 3, schedule_intent_token: "tok-1", schedule_intent_fanout_token: "fanout-1", workflow_seed: { trigger: "member_cancellation", flags: 1 })
schedule.call("schedule_installment: member cancellation delay edit", old_delayed_delivery_time: 1800, cutoff_reference_time: reference, reschedule_on_stale: true, workflow_seed: { trigger: "member_cancellation", flags: 1 })
schedule.call("schedule_installment: member cancellation delay edit with an intent", old_delayed_delivery_time: 1800, cutoff_reference_time: reference, reschedule_on_stale: true, minimum_rule_version: 3, schedule_intent_token: "tok-1", workflow_seed: { trigger: "member_cancellation" })
schedule.call("schedule_installment: member cancellation delay edit with a fanout token", old_delayed_delivery_time: 1800, cutoff_reference_time: reference, reschedule_on_stale: true, schedule_intent_fanout_token: "fanout-1", workflow_seed: { trigger: "member_cancellation" })

enqueue_params = { "rule_version" => 3, "old_delayed_delivery_time" => 1800, "cutoff_reference_time" => (NOW - HOUR).iso8601(3), "expected_published_at" => PUBLISHED_AT }
cases << direct("enqueue!: inside a transaction", "enqueue!", enqueue_params) do
  WorkflowInstallmentScheduleIntent.transaction do
    WorkflowInstallmentScheduleIntent.enqueue!(installment: Installment.find(10), rule_version: 3, old_delayed_delivery_time: 1800, cutoff_reference_time: NOW - HOUR, expected_published_at: Time.utc(2025, 10, 30, 9))
  end
end
cases << direct("enqueue!: without optional times", "enqueue!", enqueue_params.merge("old_delayed_delivery_time" => nil, "expected_published_at" => nil)) do
  WorkflowInstallmentScheduleIntent.transaction do
    WorkflowInstallmentScheduleIntent.enqueue!(installment: Installment.find(10), rule_version: 3, old_delayed_delivery_time: nil, cutoff_reference_time: NOW - HOUR)
  end
end
cases << direct("enqueue!: outside a transaction", "enqueue!", enqueue_params.merge("expected_published_at" => nil)) do
  WorkflowInstallmentScheduleIntent.enqueue!(installment: Installment.find(10), rule_version: 3, old_delayed_delivery_time: 1800, cutoff_reference_time: NOW - HOUR)
end
cases << direct("enqueue!: the transaction rolls back", "enqueue!", enqueue_params.merge("expected_published_at" => nil)) do
  WorkflowInstallmentScheduleIntent.transaction do
    WorkflowInstallmentScheduleIntent.enqueue!(installment: Installment.find(10), rule_version: 3, old_delayed_delivery_time: 1800, cutoff_reference_time: NOW - HOUR)
    raise ActiveRecord::Rollback
  end
end

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
