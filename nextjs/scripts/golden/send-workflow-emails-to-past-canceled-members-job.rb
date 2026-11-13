# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/send-workflow-emails-to-past-canceled-members-job.golden.json:
# SendWorkflowEmailsToPastCanceledMembersJob run by the real app against a scratch database as a Sidekiq job
# (support/sidekiq_executor.rb), without schedule intent tokens. The fanout is SendWorkflowInstallmentWorker and
# SendWorkflowInstallmentRescheduleJob pushes, visible in the scratch Redis next to the rule version the job caches.
# Purchases are plain INSERTs (the purchase factory charges Stripe). Run it like schedule-affiliate-workflows.rb, with a
# single scratch Redis database for REDIS_HOST, SIDEKIQ_REDIS_HOST and the other Redis settings:
#
#   RAILS_ENV=test DATABASE_NAME=gumroad_test_c28 TEST_DATABASE_NAME=gumroad_test_c28 DISABLE_TEST_REDIS_ISOLATION=1 \
#     USE_DB_WORKER_REPLICAS=true REDIS_HOST=redis:6379/24 SIDEKIQ_REDIS_HOST=redis:6379/24 \
#     RPUSH_REDIS_HOST=redis:6379/24 RACK_ATTACK_REDIS_HOST=redis:6379/24 \
#     OBFUSCATE_IDS_CIPHER_KEY=ws63-golden-obfuscate-key OBFUSCATE_IDS_NUMERIC_CIPHER_KEY=123456789 \
#     bundle exec rails runner nextjs/scripts/golden/send-workflow-emails-to-past-canceled-members-job.rb
require_relative "support/rails_cases"
include RailsCases
capture_elasticsearch!

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/send-workflow-emails-to-past-canceled-members-job.golden.json")
NOW = Time.utc(2025, 11, 1, 12, 30, 45, 123_000)
SEEDED_AT = "2025-01-01 00:00:00"
TABLES = %w[users links purchases subscriptions workflows installments installment_rules base_variants
            base_variants_purchases licenses versions].freeze

Stripe.api_base = "http://127.0.0.1:9"
Stripe.max_network_retries = 0
ActiveJob::Base.queue_adapter = :sidekiq
ActiveJob::Base.logger = Logger.new(nil)
Rails.logger = ActiveSupport::Logger.new(nil)

HOUR = 3600
SEND_TO_PAST_CUSTOMERS = 1
ORIGINAL_SUBSCRIPTION_PURCHASE = 1 << 2
ARCHIVED_ORIGINAL_SUBSCRIPTION_PURCHASE = 1 << 17
IS_FOR_NEW_CUSTOMERS_OF_WORKFLOW = 1 << 5
SEND_EMAILS = 1 << 8
TRIGGER = { workflow_trigger: "member_cancellation" }.freeze

def user_row(id, **overrides)
  { id:, email: "user#{id}@example.com", username: "user#{id}", external_id: (1000 + id).to_s, recommendation_type: "own_products",
    user_risk_state: "compliant", flags: 0, json_data: nil, confirmed_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def link_row(id = 1, **overrides)
  { id:, name: "Product #{id}", user_id: 1, unique_permalink: "p#{id}", price_currency_type: "usd", flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def purchase_row(id = 1, subscription: id, **overrides)
  { id:, link_id: 1, seller_id: 1, subscription_id: subscription, email: "buyer#{id}@example.com", purchase_state: "successful", price_cents: 500, displayed_price_cents: 500,
    quantity: 1, flags: ORIGINAL_SUBSCRIPTION_PURCHASE, country: "United States", ip_country: "United States", created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def subscription_row(id = 1, **overrides)
  { id:, link_id: 1, seller_id: 1, user_id: 2, flags: 0, cancelled_at: "2025-10-30 09:00:00", deactivated_at: "2025-10-30 09:00:00", created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def workflow_row(id = 1, type: "product", trigger: TRIGGER, filters: {}, **overrides)
  json = trigger.merge(filters)
  { id:, seller_id: 1, link_id: type == "product" || type == "variant" ? 1 : nil, workflow_type: type, published_at: SEEDED_AT, json_data: json.empty? ? nil : json.to_json,
    flags: SEND_TO_PAST_CUSTOMERS, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def installment_row(id = 10, workflow_id: 1, **overrides)
  { id:, link_id: 1, seller_id: 1, workflow_id:, installment_type: "product", name: "Post #{id}", published_at: SEEDED_AT, flags: SEND_EMAILS,
    created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def rule_row(installment_id = 10, **overrides)
  { id: installment_id, installment_id:, delayed_delivery_time: HOUR, version: 3, time_period: "hour", created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def variant_rows
  { base_variants: [{ id: 1, variant_category_id: 1, name: "V", link_id: 1, type: "Variant", flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }] }
end

def base_seed(**extra)
  { users: [user_row(1), user_row(2)], links: [link_row, link_row(2)], workflows: [workflow_row], installments: [installment_row], installment_rules: [rule_row],
    subscriptions: [subscription_row], purchases: [purchase_row] }.merge(extra)
end

JOB = "SendWorkflowEmailsToPastCanceledMembersJob"
cases = []
run = lambda do |name, args = [10], now: NOW, setup: nil, **seed|
  result = capture(name, now:, tables: TABLES, seed: base_seed(**seed), setup:, sidekiq: true, job: JOB, args:, case_now: now.to_f) { JOB.constantize.new.perform(*args) }
  result.delete("rows")
  result.delete("seed")
  cases << result
end

CUTOFF = "2025-10-31T00:00:00Z"
OLD_DELAY = 2 * HOUR

run.call("a member cancelled before the post was scheduled")
run.call("an unknown installment", [99])
run.call("the installment id as a string", ["10"])
run.call("a deleted workflow", workflows: [workflow_row(deleted_at: SEEDED_AT)])
run.call("a deleted installment", installments: [installment_row(deleted_at: SEEDED_AT)])
run.call("an unpublished installment", installments: [installment_row(published_at: nil)])
run.call("an installment without a workflow", installments: [installment_row(workflow_id: nil)])
run.call("a workflow without the member cancellation trigger", workflows: [workflow_row(trigger: {})])
run.call("a workflow with another trigger", workflows: [workflow_row(trigger: { workflow_trigger: "new_customer" })])
run.call("a workflow that does not send to past customers", workflows: [workflow_row(flags: 0)])
run.call("an audience workflow", workflows: [workflow_row(type: "audience")])
run.call("an abandoned cart workflow", workflows: [workflow_row(type: "abandoned_cart")])
run.call("an affiliate workflow", workflows: [workflow_row(type: "affiliate")])
run.call("an installment without a rule", installment_rules: [])
run.call("no subscriptions", subscriptions: [], purchases: [])
run.call("a subscription that was never deactivated", subscriptions: [subscription_row(deactivated_at: nil)])
run.call("a subscription that was never cancelled", subscriptions: [subscription_row(cancelled_at: nil)])
run.call("a subscription of another product", subscriptions: [subscription_row(link_id: 2)])
run.call("a subscription of another seller", subscriptions: [subscription_row(seller_id: 2)])
run.call("a cancellation that has not taken effect yet", subscriptions: [subscription_row(cancelled_at: "2025-11-15 00:00:00")])
run.call("a subscription that failed", subscriptions: [subscription_row(failed_at: "2025-10-30 09:00:00")])
run.call("a subscription that ended", subscriptions: [subscription_row(ended_at: "2025-10-30 09:00:00")])
run.call("a subscription without an original purchase", purchases: [])
run.call("a subscription whose original purchase is archived", purchases: [purchase_row(flags: ORIGINAL_SUBSCRIPTION_PURCHASE | ARCHIVED_ORIGINAL_SUBSCRIPTION_PURCHASE)])
run.call("a subscription whose only purchase is a renewal", purchases: [purchase_row(flags: 0)])
run.call("a product workflow and a purchase of another product", purchases: [purchase_row(link_id: 2)])
run.call("a seller workflow covers every product of the seller", workflows: [workflow_row(type: "seller")],
                                                                 subscriptions: [subscription_row, subscription_row(2, link_id: 2, deactivated_at: "2025-10-31 10:00:00")], purchases: [purchase_row, purchase_row(2, link_id: 2)])
run.call("a seller workflow leaves out another seller", workflows: [workflow_row(type: "seller")], subscriptions: [subscription_row, subscription_row(2, seller_id: 2)], purchases: [purchase_row, purchase_row(2)])
run.call("a product workflow without a product", workflows: [workflow_row(link_id: nil)], subscriptions: [subscription_row(link_id: nil), subscription_row(2)], purchases: [purchase_row(link_id: nil), purchase_row(2)])
run.call("a seller workflow without a seller", workflows: [workflow_row(type: "seller", seller_id: nil)], subscriptions: [subscription_row(seller_id: nil), subscription_row(2)], purchases: [purchase_row(seller_id: nil), purchase_row(2)])
run.call("subscriptions in the order of their ids", subscriptions: [subscription_row(3, deactivated_at: "2025-10-01 00:00:00"), subscription_row(1), subscription_row(2, deactivated_at: "2025-10-20 00:00:00")],
                                                    purchases: [purchase_row(3), purchase_row(1), purchase_row(2)])
run.call("a deactivation with a fraction of a second", subscriptions: [subscription_row(deactivated_at: "2025-10-30 09:00:00.250000")])
run.call("a variant workflow and a purchase of the variant", workflows: [workflow_row(type: "variant", base_variant_id: 1)], **variant_rows, base_variants_purchases: [{ base_variant_id: 1, purchase_id: 1 }])
run.call("a variant workflow and a purchase of no variant", workflows: [workflow_row(type: "variant", base_variant_id: 1)], **variant_rows)
run.call("a workflow that needs a larger purchase, met", workflows: [workflow_row(filters: { paid_more_than_cents: 100 })])
run.call("a workflow that needs a larger purchase, not met", workflows: [workflow_row(filters: { paid_more_than_cents: 900 })])
run.call("a workflow limited to a country, met", workflows: [workflow_row(filters: { bought_from: "United States" })])
run.call("a workflow limited to a country, not met", workflows: [workflow_row(filters: { bought_from: "France" })])
run.call("a workflow limited to purchases made after a date", workflows: [workflow_row(filters: { created_after: "2025-06-01T00:00:00.000-07:00" })])
run.call("a rule without a delay", installment_rules: [rule_row(delayed_delivery_time: nil)])
run.call("a rule without a delay and no member to send to", installment_rules: [rule_row(delayed_delivery_time: nil)], subscriptions: [], purchases: [])
run.call("a rule with a zero delay", installment_rules: [rule_row(delayed_delivery_time: 0)])
run.call("a rule version above the minimum", [10, nil, nil, 2])
run.call("a rule version at the minimum", [10, nil, nil, 3])
run.call("a rule version below the minimum", [10, nil, nil, 4])
run.call("a minimum rule version of zero", [10, nil, nil, 0])
run.call("a rule version already cached higher", setup: -> { $redis.set(RedisKey.workflow_installment_rule_version(10), 5) })
run.call("a rule version already cached lower", setup: -> { $redis.set(RedisKey.workflow_installment_rule_version(10), 1) })
run.call("a rule version with a pending write", setup: -> { $redis.set("workflow_installment_rule:10:pending_token", "someone") })
run.call("a rule version cached and pending", setup: lambda {
  $redis.set(RedisKey.workflow_installment_rule_version(10), 2)
  $redis.set("workflow_installment_rule:10:pending_token", "someone")
})

RECENT = "2025-11-01 12:00:00"
run.call("a member cancelled half an hour ago is scheduled for later", subscriptions: [subscription_row(deactivated_at: RECENT)])
run.call("a member cancelled half an hour ago with a fraction of a second", subscriptions: [subscription_row(deactivated_at: "2025-11-01 12:00:00.250000")])
run.call("a member cancelled half an hour ago and one long ago", subscriptions: [subscription_row(1, deactivated_at: RECENT), subscription_row(2)], purchases: [purchase_row(1), purchase_row(2)])
run.call("a member cancelled just now with a zero delay", installment_rules: [rule_row(delayed_delivery_time: 0)], subscriptions: [subscription_row(deactivated_at: RECENT)])
run.call("a member cancelled just now with a negative delay", installment_rules: [rule_row(delayed_delivery_time: -HOUR)], subscriptions: [subscription_row(deactivated_at: RECENT)])
run.call("a member cancelled half an hour ago with a delay of a month", installment_rules: [rule_row(delayed_delivery_time: 2_629_746, time_period: "month")], subscriptions: [subscription_row(deactivated_at: RECENT)])

RESCHEDULE = [10, OLD_DELAY, CUTOFF].freeze
run.call("a reschedule of a member deactivated after the cutoff window", RESCHEDULE, subscriptions: [subscription_row(deactivated_at: "2025-10-30 23:00:00")])
run.call("a reschedule of a member cancelled half an hour ago", RESCHEDULE, subscriptions: [subscription_row(deactivated_at: RECENT)])
run.call("a reschedule of a member cancelled half an hour ago with a fraction of a second", RESCHEDULE, subscriptions: [subscription_row(deactivated_at: "2025-11-01 12:00:00.600000")])
run.call("a reschedule of a member deactivated before the cutoff window", RESCHEDULE, subscriptions: [subscription_row(deactivated_at: "2025-10-30 21:59:59")])
run.call("a reschedule of a member deactivated at the start of the cutoff window", RESCHEDULE, subscriptions: [subscription_row(deactivated_at: "2025-10-30 22:00:00")])
run.call("a reschedule of a member whose old send time is the cutoff", RESCHEDULE, subscriptions: [subscription_row(deactivated_at: "2025-10-30 22:00:01")])
run.call("a reschedule of a member deactivated half a second into the cutoff window", RESCHEDULE, subscriptions: [subscription_row(deactivated_at: "2025-10-30 22:00:00.500000")])
run.call("a reschedule of a member deactivated half a second after the whole second of the cutoff", RESCHEDULE, subscriptions: [subscription_row(deactivated_at: "2025-10-30 22:00:01.500000")])
run.call("a reschedule of a member deactivated after the cutoff", RESCHEDULE, subscriptions: [subscription_row(deactivated_at: "2025-10-31 08:00:00")])
run.call("a reschedule ignores the send to past customers flag", RESCHEDULE, workflows: [workflow_row(flags: 0)], subscriptions: [subscription_row(deactivated_at: "2025-10-30 23:00:00")])
run.call("a reschedule of a deactivation with a fraction of a second", RESCHEDULE, subscriptions: [subscription_row(deactivated_at: "2025-10-30 23:00:00.750000")])
run.call("a reschedule of a post for new customers of the workflow, member before publication", RESCHEDULE,
         installments: [installment_row(flags: SEND_EMAILS | IS_FOR_NEW_CUSTOMERS_OF_WORKFLOW, published_at: "2025-10-31 00:00:00")], subscriptions: [subscription_row(deactivated_at: "2025-10-30 23:00:00")])
run.call("a reschedule of a post for new customers of the workflow, member after publication", RESCHEDULE,
         installments: [installment_row(flags: SEND_EMAILS | IS_FOR_NEW_CUSTOMERS_OF_WORKFLOW, published_at: "2025-10-30 12:00:00")], subscriptions: [subscription_row(deactivated_at: "2025-10-30 23:00:00")])
run.call("a reschedule of a post for new customers, member in the second of publication", RESCHEDULE,
         installments: [installment_row(flags: SEND_EMAILS | IS_FOR_NEW_CUSTOMERS_OF_WORKFLOW, published_at: "2025-10-30 23:00:00")], subscriptions: [subscription_row(deactivated_at: "2025-10-30 23:00:00")])
run.call("a reschedule with several members", RESCHEDULE,
         subscriptions: [subscription_row(1, deactivated_at: "2025-10-30 23:00:00"), subscription_row(2, deactivated_at: "2025-10-30 12:00:00"), subscription_row(3, deactivated_at: "2025-10-31 06:00:00")],
         purchases: [purchase_row(1), purchase_row(2), purchase_row(3)])
run.call("a reschedule with a rule version and a workflow that no longer applies", RESCHEDULE, workflows: [workflow_row(filters: { bought_from: "France" })], subscriptions: [subscription_row(deactivated_at: "2025-10-30 23:00:00")])
run.call("a reschedule of a rule without a delay", RESCHEDULE, installment_rules: [rule_row(delayed_delivery_time: nil)], subscriptions: [subscription_row(deactivated_at: "2025-10-30 23:00:00")])
run.call("a reschedule with a zero old delay", [10, 0, CUTOFF], subscriptions: [subscription_row(deactivated_at: "2025-10-30 23:00:00"), subscription_row(2, deactivated_at: "2025-11-01 00:00:00")], purchases: [purchase_row, purchase_row(2)])
run.call("a reschedule with a negative old delay", [10, -HOUR, CUTOFF], subscriptions: [subscription_row(deactivated_at: "2025-10-30 23:00:00"), subscription_row(2, deactivated_at: "2025-11-01 00:00:00")], purchases: [purchase_row, purchase_row(2)])
run.call("a reschedule with an old delay and no cutoff", [10, OLD_DELAY, nil])
run.call("a reschedule with an old delay and a blank cutoff", [10, OLD_DELAY, "  "])
run.call("a reschedule with a cutoff and no old delay", [10, nil, CUTOFF])
run.call("a reschedule of an installment that was deleted", RESCHEDULE, installments: [installment_row(deleted_at: SEEDED_AT)])
run.call("a reschedule of an unknown installment", [99, OLD_DELAY, CUTOFF])
run.call("a reschedule with a minimum rule version", [10, OLD_DELAY, CUTOFF, 3], subscriptions: [subscription_row(deactivated_at: "2025-10-30 23:00:00")])
run.call("a reschedule with a minimum rule version above the rule", [10, OLD_DELAY, CUTOFF, 9], subscriptions: [subscription_row(deactivated_at: "2025-10-30 23:00:00")])

[
  ["a cutoff with an offset", "2025-10-31T02:00:00+02:00"],
  ["a cutoff with a fraction", "2025-10-31T00:00:00.500Z"],
  ["a cutoff without a zone", "2025-10-31T00:00:00"],
  ["a cutoff that is a date only", "2025-10-31"],
  ["a cutoff that is not a time", "tomorrow"],
  ["a cutoff past the end of the month", "2025-02-30T00:00:00Z"],
].each do |label, cutoff|
  run.call("a reschedule with #{label}", [10, OLD_DELAY, cutoff], subscriptions: [subscription_row(deactivated_at: "2025-10-30 23:00:00")])
end
run.call("a reschedule with an old delay that is a string", [10, "7200", CUTOFF], subscriptions: [subscription_row(deactivated_at: "2025-10-30 23:00:00")])
run.call("a reschedule with an old delay that is a float", [10, 7200.5, CUTOFF], subscriptions: [subscription_row(deactivated_at: "2025-10-30 23:00:00")])

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
