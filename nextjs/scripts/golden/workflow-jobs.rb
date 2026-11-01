# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/workflow-jobs.golden.json: the workflow and installment
# jobs that read and enqueue (ScheduleWorkflowEmailsWorker, UpdateInstallmentEventsCountCacheWorker,
# FlushInstallmentDeliveredDeltasJob, SendWorkflowInstallmentRescheduleJob) and the member cancellation
# scheduling of SetSubscriptionAsDeactivatedWorker, run by the real app against a scratch database,
# each case as a Sidekiq job (support/sidekiq_executor.rb). Run it like subscription-writes-jobs.rb:
#
#   RAILS_ENV=test DATABASE_NAME=gumroad_ws51 TEST_DATABASE_NAME=gumroad_ws51 DISABLE_TEST_REDIS_ISOLATION=1 \
#     USE_DB_WORKER_REPLICAS=true REDIS_HOST=127.0.0.1:6379/6 SIDEKIQ_REDIS_HOST=127.0.0.1:6379/6 \
#     RPUSH_REDIS_HOST=127.0.0.1:6379/6 RACK_ATTACK_REDIS_HOST=127.0.0.1:6379/6 \
#     OBFUSCATE_IDS_CIPHER_KEY=ws51-golden-obfuscate-key OBFUSCATE_IDS_NUMERIC_CIPHER_KEY=123456789 \
#     bundle exec rails runner nextjs/scripts/golden/workflow-jobs.rb
#
# Purchases are plain INSERTs (the purchase factory charges Stripe). Elasticsearch is captured, never
# reached. Each case runs at the frozen time recorded as `case_now`.
require_relative "support/rails_cases"
include RailsCases
capture_elasticsearch!

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/workflow-jobs.golden.json")
NOW = Time.utc(2025, 11, 1, 12, 30, 45, 123_000)
SEEDED_AT = "2025-01-01 00:00:00"
TABLES = %w[users links purchases subscriptions workflows installments installment_rules installment_events base_variants
            base_variants_purchases licenses payment_options prices versions affiliates affiliates_links].freeze

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

ORIGINAL_SUBSCRIPTION_PURCHASE = 1 << 2
DAY = 86_400
HOUR = 3600

def at(time) = time.utc.strftime("%Y-%m-%d %H:%M:%S.%6N")

def user_row(id, **overrides)
  { id:, email: "user#{id}@example.com", username: "user#{id}", external_id: (1000 + id).to_s, recommendation_type: "own_products",
    user_risk_state: "compliant", flags: 0, json_data: nil, confirmed_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def link_row(id = 1, **overrides)
  { id:, name: "Product #{id}", user_id: 1, unique_permalink: "p#{id}", price_currency_type: "usd", flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def purchase_row(id = 1, **overrides)
  { id:, link_id: 1, seller_id: 1, email: "buyer@example.com", purchase_state: "successful", price_cents: 500, displayed_price_cents: 500,
    quantity: 1, flags: 0, country: "United States", ip_country: "United States", created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def workflow_row(id = 1, trigger: nil, filters: {}, **overrides)
  data = filters.merge(trigger ? { workflow_trigger: trigger } : {})
  { id:, seller_id: 1, link_id: 1, workflow_type: "product", published_at: SEEDED_AT, json_data: data.empty? ? nil : data.to_json,
    flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def installment_row(id = 1, workflow_id: 1, **overrides)
  { id:, link_id: 1, seller_id: 1, workflow_id:, installment_type: "product", name: "Post #{id}", published_at: SEEDED_AT, flags: 0,
    created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def rule_row(id = 1, installment_id: id, delay: HOUR, **overrides)
  { id:, installment_id:, delayed_delivery_time: delay, version: 3, time_period: "hour", created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

# A workflow with `installments` installments, each with a rule delayed by an hour times its position.
def workflow_with_installments(id = 1, count: 1, workflow: {}, trigger: nil, filters: {}, first_installment_id: (id * 10))
  installments = (0...count).map { |i| installment_row(first_installment_id + i, workflow_id: id) }
  rules = installments.each_with_index.map { |installment, i| rule_row(installment[:id], installment_id: installment[:id], delay: HOUR * (i + 1)) }
  { workflows: [workflow_row(id, trigger:, filters:, **workflow)], installments:, installment_rules: rules }
end

def merge_seeds(*seeds)
  seeds.each_with_object({}) { |seed, all| seed.each { |table, rows| (all[table] ||= []).concat(rows) } }
end

def base_seed(**extra)
  { users: [user_row(1), user_row(2)], links: [link_row], purchases: [purchase_row] }.merge(extra.to_h { |table, rows| [table, rows] })
end

def run(name, job, args, seed: {}, now: NOW, setup: nil, features: [])
  $uuid_seq = 0
  result = capture(name, now:, tables: TABLES, seed: base_seed(**seed), setup: lambda {
    features.each { |feature| Feature.activate_user(feature, User.find(1)) }
    setup&.call
  }, sidekiq: true, job:, args:, case_now: now.to_f) { job.constantize.new.perform(*args) }
  result.delete("rows")
  result.delete("seed")
  result
end

variant_id = ->(id) { ObfuscateIds.encrypt(id) }
variants = {
  base_variants: [{ id: 1, link_id: 1, name: "Tier", type: "Variant", flags: 0 }, { id: 2, link_id: 1, name: "Other tier", type: "Variant", flags: 0 }],
}
bought_variant_1 = { base_variants_purchases: [{ id: 1, purchase_id: 1, base_variant_id: 1 }] }

cases = []

# --- ScheduleWorkflowEmailsWorker --------------------------------------------------------------------
SW = "ScheduleWorkflowEmailsWorker"
cases << run("schedule: purchase does not exist", SW, [999])
cases << run("schedule: purchase id as a string", SW, ["1"], seed: workflow_with_installments)
cases << run("schedule: no workflows", SW, [1])
cases << run("schedule: product workflow without installments", SW, [1], seed: { workflows: [workflow_row] })
cases << run("schedule: product workflow, one installment", SW, [1], seed: workflow_with_installments)
cases << run("schedule: product workflow, several installments", SW, [1], seed: workflow_with_installments(count: 3))
cases << run("schedule: installment delayed past the purchase by days", SW, [1], seed: workflow_with_installments.merge(installment_rules: [rule_row(10, delay: 45 * DAY)]))
cases << run("schedule: installment without a rule", SW, [1], seed: workflow_with_installments.merge(installment_rules: []))
cases << run("schedule: rule deleted", SW, [1], seed: workflow_with_installments.merge(installment_rules: [rule_row(10, deleted_at: SEEDED_AT)]))
cases << run("schedule: unpublished installment", SW, [1], seed: workflow_with_installments.merge(installments: [installment_row(10, published_at: nil)]))
cases << run("schedule: deleted installment", SW, [1], seed: workflow_with_installments.merge(installments: [installment_row(10, deleted_at: SEEDED_AT)]))
cases << run("schedule: deleted workflow", SW, [1], seed: workflow_with_installments(workflow: { deleted_at: SEEDED_AT }))
cases << run("schedule: unpublished workflow still schedules its published installments", SW, [1], seed: workflow_with_installments(workflow: { published_at: nil }))
cases << run("schedule: workflow of another product", SW, [1], seed: merge_seeds({ links: [link_row, link_row(2, unique_permalink: "p2")] }, workflow_with_installments(workflow: { link_id: 2 })))
cases << run("schedule: seller workflow", SW, [1], seed: workflow_with_installments(workflow: { workflow_type: "seller", link_id: nil }))
cases << run("schedule: audience workflow", SW, [1], seed: workflow_with_installments(workflow: { workflow_type: "audience", link_id: nil }))
cases << run("schedule: follower workflow is not an all_workflows member", SW, [1], seed: workflow_with_installments(workflow: { workflow_type: "follower", link_id: nil }))
cases << run("schedule: abandoned cart workflow", SW, [1], seed: workflow_with_installments(workflow: { workflow_type: "abandoned_cart" }))
cases << run("schedule: member cancellation workflow", SW, [1], seed: workflow_with_installments(trigger: "member_cancellation"))
cases << run("schedule: product and seller workflows", SW, [1],
  seed: merge_seeds(workflow_with_installments(1, count: 2), workflow_with_installments(2, workflow: { workflow_type: "seller", link_id: nil })))
cases << run("schedule: variant workflow, purchase has the variant", SW, [1],
  seed: merge_seeds(variants, bought_variant_1, workflow_with_installments(workflow: { workflow_type: "variant", base_variant_id: 1 })))
cases << run("schedule: variant workflow, purchase has another variant", SW, [1],
  seed: merge_seeds(variants, { base_variants_purchases: [{ id: 1, purchase_id: 1, base_variant_id: 2 }] }, workflow_with_installments(workflow: { workflow_type: "variant", base_variant_id: 1 })))
cases << run("schedule: variant workflow, purchase has no variant", SW, [1],
  seed: merge_seeds(variants, workflow_with_installments(workflow: { workflow_type: "variant", base_variant_id: 1 })))
cases << run("schedule: variant workflow without a base variant", SW, [1], seed: workflow_with_installments(workflow: { workflow_type: "variant", base_variant_id: nil }))

# Filters
filtered = ->(filters, extra = {}) { merge_seeds(workflow_with_installments(filters:), extra) }
cases << run("schedule: paid more than, met", SW, [1], seed: filtered.call({ paid_more_than_cents: 400 }))
cases << run("schedule: paid more than, not met", SW, [1], seed: filtered.call({ paid_more_than_cents: 600 }))
cases << run("schedule: paid less than, met", SW, [1], seed: filtered.call({ paid_less_than_cents: 600 }))
cases << run("schedule: paid less than, not met", SW, [1], seed: filtered.call({ paid_less_than_cents: 400 }))
cases << run("schedule: paid more than a purchase without a price", SW, [1], seed: filtered.call({ paid_more_than_cents: 400 }, { purchases: [purchase_row(price_cents: nil)] }))
cases << run("schedule: bought products, met", SW, [1], seed: filtered.call({ bought_products: ["p1"] }))
cases << run("schedule: bought products, not met", SW, [1], seed: filtered.call({ bought_products: ["other"] }))
cases << run("schedule: bought variants, met", SW, [1], seed: filtered.call({ bought_variants: [variant_id.call(1)] }, merge_seeds(variants, bought_variant_1)))
cases << run("schedule: bought variants, not met", SW, [1], seed: filtered.call({ bought_variants: [variant_id.call(2)] }, merge_seeds(variants, bought_variant_1)))
cases << run("schedule: bought variants and products, only the product met", SW, [1], seed: filtered.call({ bought_variants: [variant_id.call(2)], bought_products: ["p1"] }, merge_seeds(variants, bought_variant_1)))
cases << run("schedule: bought variants and products, neither met", SW, [1], seed: filtered.call({ bought_variants: [variant_id.call(2)], bought_products: ["x"] }, merge_seeds(variants, bought_variant_1)))
cases << run("schedule: bought from, country matches", SW, [1], seed: filtered.call({ bought_from: "United States" }))
cases << run("schedule: bought from, country differs", SW, [1], seed: filtered.call({ bought_from: "Spain" }))
cases << run("schedule: bought from, no country falls back to ip country", SW, [1], seed: filtered.call({ bought_from: "Spain" }, { purchases: [purchase_row(country: nil, ip_country: "Spain")] }))
cases << run("schedule: active customers only, no subscription", SW, [1], seed: filtered.call({ active_customers_only: true }))
cases << run("schedule: active customers only, cancelled subscription", SW, [1],
  seed: filtered.call({ active_customers_only: true }, { subscriptions: [{ id: 1, link_id: 1, user_id: 2, seller_id: 1, cancelled_at: SEEDED_AT, flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }], purchases: [purchase_row(subscription_id: 1, flags: ORIGINAL_SUBSCRIPTION_PURCHASE)] }))
cases << run("schedule: active customers only, live subscription", SW, [1],
  seed: filtered.call({ active_customers_only: true }, { subscriptions: [{ id: 1, link_id: 1, user_id: 2, seller_id: 1, flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }], purchases: [purchase_row(subscription_id: 1, flags: ORIGINAL_SUBSCRIPTION_PURCHASE)] }))
cases << run("schedule: minimum license uses, no license", SW, [1], seed: filtered.call({ minimum_license_uses: 2 }))
cases << run("schedule: minimum license uses, met", SW, [1], seed: filtered.call({ minimum_license_uses: 2 }, { licenses: [{ id: 1, link_id: 1, purchase_id: 1, serial: "A", uses: 3, flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }] }))
cases << run("schedule: minimum license uses, not met", SW, [1], seed: filtered.call({ minimum_license_uses: 5 }, { licenses: [{ id: 1, link_id: 1, purchase_id: 1, serial: "A", uses: 3, flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }] }))
cases << run("schedule: created after, met", SW, [1], seed: filtered.call({ created_after: "2024-12-31T00:00:00.000-08:00" }))
cases << run("schedule: created after, not met", SW, [1], seed: filtered.call({ created_after: "2025-06-01T00:00:00.000Z" }))
cases << run("schedule: created before, met", SW, [1], seed: filtered.call({ created_before: "2025-06-01T23:59:59.999+02:00" }))
cases << run("schedule: created before, not met", SW, [1], seed: filtered.call({ created_before: "2024-06-01T23:59:59.999Z" }))
cases << run("schedule: not bought products", SW, [1], seed: filtered.call({ not_bought_products: ["p2"] }, { links: [link_row, link_row(2, unique_permalink: "p2")] }))
cases << run("schedule: not bought products, bought", SW, [1], seed: filtered.call({ not_bought_products: ["p2"] }, { links: [link_row, link_row(2, unique_permalink: "p2")], purchases: [purchase_row, purchase_row(2, link_id: 2)] }))
cases << run("schedule: not bought variants", SW, [1], seed: filtered.call({ not_bought_variants: [variant_id.call(2)] }, variants))
cases << run("schedule: not bought variants, two", SW, [1], seed: filtered.call({ not_bought_variants: [variant_id.call(1), variant_id.call(2)] }, variants))
cases << run("schedule: not bought variants, repeated", SW, [1], seed: filtered.call({ not_bought_variants: [variant_id.call(2), variant_id.call(2)] }, variants))
cases << run("schedule: not bought variants, bought", SW, [1], seed: filtered.call({ not_bought_variants: [variant_id.call(1)] }, merge_seeds(variants, bought_variant_1)))
cases << run("schedule: not bought variants that do not exist", SW, [1], seed: filtered.call({ not_bought_variants: [variant_id.call(99)] }))
cases << run("schedule: not bought variants and products", SW, [1], seed: filtered.call({ not_bought_variants: [variant_id.call(2)], not_bought_products: ["p2"] }, merge_seeds(variants, { links: [link_row, link_row(2, unique_permalink: "p2")] })))
cases << run("schedule: not bought variants and products, product bought", SW, [1],
  seed: filtered.call({ not_bought_variants: [variant_id.call(2)], not_bought_products: ["p2"] }, merge_seeds(variants, { links: [link_row, link_row(2, unique_permalink: "p2")], purchases: [purchase_row, purchase_row(2, link_id: 2)] })))
cases << run("schedule: not bought products that do not exist", SW, [1], seed: filtered.call({ not_bought_products: ["nope"] }))
cases << run("schedule: not bought products, two", SW, [1], seed: filtered.call({ not_bought_products: ["p2", "p3"] }, { links: [link_row, link_row(2, unique_permalink: "p2"), link_row(3, unique_permalink: "p3")] }))
cases << run("schedule: not bought products, buyer without an email", SW, [1], seed: filtered.call({ not_bought_products: ["p2"] }, { links: [link_row, link_row(2, unique_permalink: "p2")], purchases: [purchase_row(email: nil)] }))
cases << run("schedule: not bought products, in an archived original subscription purchase", SW, [1],
  seed: filtered.call({ not_bought_products: ["p2"] }, { links: [link_row, link_row(2, unique_permalink: "p2")], purchases: [purchase_row, purchase_row(2, link_id: 2, flags: 1 << 17)] }))
cases << run("schedule: recent purchase, installments in the future", SW, [1], seed: merge_seeds(workflow_with_installments(count: 3), { purchases: [purchase_row(created_at: at(NOW - 1800))] }))
cases << run("schedule: recent purchase, some installments already due", SW, [1], seed: merge_seeds(workflow_with_installments(count: 2).merge(installment_rules: [rule_row(10, delay: 600), rule_row(11, installment_id: 11, delay: 7200)]), { purchases: [purchase_row(created_at: at(NOW - 1800))] }))
cases << run("schedule: blank filters are ignored", SW, [1], seed: filtered.call({ bought_products: [], paid_more_than_cents: "", bought_from: "" }))
cases << run("schedule: filters of a deleted workflow's neighbour", SW, [1],
  seed: merge_seeds(workflow_with_installments(1, filters: { paid_more_than_cents: 900 }), workflow_with_installments(2, filters: { paid_more_than_cents: 100 })))
cases << run("schedule: json_data is not a hash", SW, [1], seed: workflow_with_installments(workflow: { json_data: "[1]" }))

# --- UpdateInstallmentEventsCountCacheWorker -----------------------------------------------------------
UC = "UpdateInstallmentEventsCountCacheWorker"
cases << run("events count: installment does not exist", UC, [999])
cases << run("events count: installment without events", UC, [1], seed: { installments: [installment_row(1, workflow_id: nil, installment_events_count: 4)] })
cases << run("events count: installment with events", UC, [1],
  seed: { installments: [installment_row(1, workflow_id: nil)], installment_events: [{ id: 1, event_id: 1, installment_id: 1 }, { id: 2, event_id: 2, installment_id: 1 }, { id: 3, event_id: 3, installment_id: 2 }] })
cases << run("events count: count already right", UC, [1],
  seed: { installments: [installment_row(1, workflow_id: nil, installment_events_count: 1)], installment_events: [{ id: 1, event_id: 1, installment_id: 1 }] })
cases << run("events count: id as a string", UC, ["1"],
  seed: { installments: [installment_row(1, workflow_id: nil)], installment_events: [{ id: 1, event_id: 1, installment_id: 1 }] })

# --- FlushInstallmentDeliveredDeltasJob --------------------------------------------------------------------
FD = "FlushInstallmentDeliveredDeltasJob"
ids_key = RedisKey.installment_delivered_delta_ids
seed_deltas = ->(deltas) { lambda {
  deltas.each do |id, delta|
    $redis.set(RedisKey.installment_delivered_delta(id), delta, ex: 2 * DAY) unless delta.nil?
    $redis.sadd(ids_key, id)
  end
} }
cases << run("flush: nothing buffered", FD, [])
cases << run("flush: one delta", FD, [], seed: { installments: [installment_row(1, workflow_id: nil, customer_count: 7)] }, setup: seed_deltas.call({ 1 => 3 }))
cases << run("flush: delta on an installment without a customer count", FD, [], seed: { installments: [installment_row(1, workflow_id: nil)] }, setup: seed_deltas.call({ 1 => 2 }))
cases << run("flush: several deltas", FD, [], seed: { installments: [installment_row(1, workflow_id: nil, customer_count: 1), installment_row(2, workflow_id: nil, customer_count: 2)] },
  setup: seed_deltas.call({ 1 => 3, 2 => 5 }))
cases << run("flush: zero delta", FD, [], seed: { installments: [installment_row(1, workflow_id: nil, customer_count: 7)] }, setup: seed_deltas.call({ 1 => 0 }))
cases << run("flush: negative delta", FD, [], seed: { installments: [installment_row(1, workflow_id: nil, customer_count: 7)] }, setup: seed_deltas.call({ 1 => -2 }))
cases << run("flush: id with an expired delta", FD, [], seed: { installments: [installment_row(1, workflow_id: nil, customer_count: 7)] }, setup: seed_deltas.call({ 1 => nil }))
cases << run("flush: delta of an installment that does not exist", FD, [], setup: seed_deltas.call({ 5 => 4 }))

# --- SendWorkflowInstallmentRescheduleJob ---------------------------------------------------------------------
RS = "SendWorkflowInstallmentRescheduleJob"
cases << run("reschedule: no recipient", RS, [1, 3, nil, nil, nil, nil, "2025-01-01T00:00:00Z"])
cases << run("reschedule: one recipient", RS, [1, 3, 5, nil, nil, nil, "2025-01-01T00:00:00Z"])
cases << run("reschedule: two recipients", RS, [1, 3, 1, 2, nil, nil, "2025-01-01T00:00:00Z"])
cases << run("reschedule: blank recipients", RS, [1, 3, nil, "", nil, nil, "2025-01-01T00:00:00Z"])

# --- ScheduleAffiliateWorkflowJobsJob ------------------------------------------------------------------------------
SA = "ScheduleAffiliateWorkflowJobsJob"
affiliate = ->(id = 1, type: "Collaborator") { { id:, seller_id: 1, affiliate_user_id: 2, type:, flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT } }
assignment = ->(id, token, affiliate_id: 1, link_id: id) { { id:, affiliate_id:, link_id:, workflow_schedule_token: token, flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT } }
claimed = ->(ago_seconds, suffix = "abc") { "#{(NOW - ago_seconds).to_i}:#{suffix}" }
cases << run("affiliates: nothing pending", SA, [])
cases << run("affiliates: nothing pending, nil token", SA, [nil])
cases << run("affiliates: rows without a token", SA, [], seed: { affiliates: [affiliate.call], affiliates_links: [assignment.call(1, nil)] })
cases << run("affiliates: a pending token never claimed", SA, [], seed: { affiliates: [affiliate.call], affiliates_links: [assignment.call(1, "tx-token"), assignment.call(2, "tx-token")] })
cases << run("affiliates: a pending token claimed long ago", SA, [], seed: { affiliates: [affiliate.call], affiliates_links: [assignment.call(1, claimed.call(20 * 60))] })
cases << run("affiliates: a pending token claimed just now", SA, [], seed: { affiliates: [affiliate.call], affiliates_links: [assignment.call(1, claimed.call(60))] })
cases << run("affiliates: a pending token claimed exactly at the lease", SA, [], seed: { affiliates: [affiliate.call], affiliates_links: [assignment.call(1, claimed.call(15 * 60))] })
cases << run("affiliates: a pending token with a non-numeric claim time", SA, [], seed: { affiliates: [affiliate.call], affiliates_links: [assignment.call(1, "soon:abc")] })
cases << run("affiliates: several pending tokens", SA, [], seed: { affiliates: [affiliate.call], affiliates_links: [assignment.call(3, "b-token"), assignment.call(1, "a-token"), assignment.call(2, "b-token"), assignment.call(4, claimed.call(60, "live"))] })
cases << run("affiliates: token with no assignments", SA, ["missing"])
cases << run("affiliates: token with an assignment", SA, ["tx-token"], seed: { affiliates: [affiliate.call], affiliates_links: [assignment.call(1, "tx-token")] })

# --- SetSubscriptionAsDeactivatedWorker: member cancellation workflows ---------------------------------------
SD = "SetSubscriptionAsDeactivatedWorker"
DEACTIVATED = NOW - DAY
membership = lambda do |purchase_flags: ORIGINAL_SUBSCRIPTION_PURCHASE, **subscription|
  {
    subscriptions: [{ id: 1, link_id: 1, user_id: 2, seller_id: 1, flags: 0, last_payment_option_id: 1, cancelled_at: at(NOW - DAY), created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(subscription)],
    prices: [{ id: 1, link_id: 1, price_cents: 500, currency: "usd", recurrence: "monthly", flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }],
    payment_options: [{ id: 1, subscription_id: 1, price_id: 1, flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }],
    purchases: [purchase_row(100, subscription_id: 1, flags: purchase_flags, created_at: "2020-01-01 00:00:00", succeeded_at: "2020-01-01 00:00:00")],
  }
end
cancel = { trigger: "member_cancellation" }
sd = ->(name, workflows = {}, **kw) { cases << run("deactivated: #{name}", SD, [1], seed: merge_seeds(membership.call(**kw), workflows), now: NOW) }
sd.call("member cancellation workflow with one installment", workflow_with_installments(workflow: { workflow_type: "seller", link_id: nil }, **cancel))
sd.call("member cancellation workflow with several installments", workflow_with_installments(count: 3, workflow: { workflow_type: "seller", link_id: nil }, **cancel))
sd.call("member cancellation workflow for the product", workflow_with_installments(**cancel))
sd.call("member cancellation workflow for another product", merge_seeds({ links: [link_row, link_row(2, unique_permalink: "p2")] }, workflow_with_installments(workflow: { link_id: 2 }, **cancel)))
sd.call("member cancellation workflow without installments", { workflows: [workflow_row(1, workflow_type: "seller", link_id: nil, trigger: "member_cancellation")] })
sd.call("member cancellation installment without a rule", workflow_with_installments(workflow: { workflow_type: "seller", link_id: nil }, **cancel).merge(installment_rules: []))
sd.call("member cancellation installment deleted", workflow_with_installments(workflow: { workflow_type: "seller", link_id: nil }, **cancel).merge(installments: [installment_row(10, deleted_at: SEEDED_AT)]))
sd.call("member cancellation unpublished installment is still scheduled", workflow_with_installments(workflow: { workflow_type: "seller", link_id: nil }, **cancel).merge(installments: [installment_row(10, published_at: nil)]))
sd.call("member cancellation workflow deleted", workflow_with_installments(workflow: { workflow_type: "seller", link_id: nil, deleted_at: SEEDED_AT }, **cancel))
sd.call("new customer workflow is skipped", workflow_with_installments(workflow: { workflow_type: "seller", link_id: nil }))
sd.call("audience workflow is not read", workflow_with_installments(workflow: { workflow_type: "audience", link_id: nil }, **cancel))
sd.call("member cancellation workflow with a variant", merge_seeds(variants, bought_variant_1, workflow_with_installments(workflow: { workflow_type: "variant", base_variant_id: 1 }, **cancel)))
sd.call("member cancellation workflow with another variant", merge_seeds(variants, { base_variants_purchases: [{ id: 1, purchase_id: 100, base_variant_id: 2 }] }, workflow_with_installments(workflow: { workflow_type: "variant", base_variant_id: 1 }, **cancel)))
sd.call("member cancellation workflow with a variant, in the filters", merge_seeds(variants, { base_variants_purchases: [{ id: 1, purchase_id: 100, base_variant_id: 1 }] },
  workflow_with_installments(filters: { bought_variants: [variant_id.call(1)] }, **cancel)))
sd.call("member cancellation workflow with paid more than, met", workflow_with_installments(filters: { paid_more_than_cents: 400 }, **cancel))
sd.call("member cancellation workflow with paid more than, not met", workflow_with_installments(filters: { paid_more_than_cents: 600 }, **cancel))
sd.call("member cancellation workflow with active customers only", workflow_with_installments(filters: { active_customers_only: true }, **cancel))
sd.call("member cancellation workflow with a license filter", merge_seeds({ licenses: [{ id: 1, link_id: 1, purchase_id: 100, serial: "A", uses: 3, flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }] },
  workflow_with_installments(filters: { minimum_license_uses: 2 }, **cancel)))
sd.call("member cancellation workflow with not bought products", workflow_with_installments(filters: { not_bought_products: ["p2"] }, **cancel))
sd.call("member cancellation workflow with not bought variants", merge_seeds(variants, workflow_with_installments(filters: { not_bought_variants: [variant_id.call(2)] }, **cancel)))
sd.call("two member cancellation workflows", merge_seeds(workflow_with_installments(1, workflow: { workflow_type: "seller", link_id: nil }, **cancel), workflow_with_installments(2, **cancel)))
sd.call("member cancellation workflow, cancelled by the buyer", workflow_with_installments(workflow: { workflow_type: "seller", link_id: nil }, **cancel), flags: 2)
sd.call("member cancellation workflow, subscription failed rather than cancelled", workflow_with_installments(workflow: { workflow_type: "seller", link_id: nil }, **cancel), cancelled_at: nil, failed_at: at(NOW - DAY))
sd.call("member cancellation workflow, no original purchase", workflow_with_installments(workflow: { workflow_type: "seller", link_id: nil }, **cancel).merge(purchases: []))

File.write(OUT, JSON.pretty_generate({ "now" => travel_to(NOW, with_usec: true) { Time.now.to_f }, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
