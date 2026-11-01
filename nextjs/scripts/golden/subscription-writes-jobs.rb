# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/subscription-writes-jobs.golden.json: the jobs that
# write a subscription (EndSubscriptionWorker, UnsubscribeAndFailWorker,
# SetSubscriptionAsDeactivatedWorker), run by the real app against a scratch database, each case as
# a Sidekiq job (support/sidekiq_executor.rb). Run it like subscription-reminder-jobs.rb:
#
#   RAILS_ENV=test DATABASE_NAME=gumroad_ws47 TEST_DATABASE_NAME=gumroad_ws47 DISABLE_TEST_REDIS_ISOLATION=1 \
#     USE_DB_WORKER_REPLICAS=true REDIS_HOST=127.0.0.1:6379/6 SIDEKIQ_REDIS_HOST=127.0.0.1:6379/6 \
#     RPUSH_REDIS_HOST=127.0.0.1:6379/6 RACK_ATTACK_REDIS_HOST=127.0.0.1:6379/6 \
#     bundle exec rails runner nextjs/scripts/golden/subscription-writes-jobs.rb
#
# Purchases and subscriptions are plain INSERTs (the purchase factory charges Stripe). Elasticsearch
# is captured, never reached. Each case runs at the frozen time recorded as `now`.
require_relative "support/rails_cases"
include RailsCases
capture_elasticsearch!

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/subscription-writes-jobs.golden.json")
NOW = Time.utc(2025, 11, 1, 12, 30, 45, 123_000)
SEEDED_AT = "2025-01-01 00:00:00"
ORIGINAL_AT = "2020-01-01 00:00:00"
TABLES = %w[users links subscriptions subscription_events payment_options prices purchases base_variants base_variants_purchases
            merchant_accounts sent_email_infos versions workflows installments installment_rules credit_cards].freeze

Stripe.api_base = "http://127.0.0.1:9"
Stripe.max_network_retries = 0

$uuid_seq = 0
SecureRandom.singleton_class.prepend(Module.new do
  def uuid
    $uuid_seq += 1
    format("00000000-0000-4000-8000-%012d", $uuid_seq)
  end
end)
ActiveJob::Base.queue_adapter = :sidekiq
ActiveJob::Base.logger = Logger.new(nil)
ActionMailer::Base.deliver_later_queue_name = :default
Rails.logger = ActiveSupport::Logger.new(nil)

IS_TEST_SUBSCRIPTION = 1
RENEWAL_DISABLED_INDIAN_MANDATE = 1 << 7
INDIAN_MANDATE_HOLD_PENDING = 1 << 10
ORIGINAL_SUBSCRIPTION_PURCHASE = 1 << 2
USER_ENABLE_PAYMENT_EMAIL = 1 << 15

def at(time) = time.utc.strftime("%Y-%m-%d %H:%M:%S.%6N")

def user_row(id, **overrides)
  {
    id:, email: "user#{id}@example.com", username: "user#{id}", external_id: (1000 + id).to_s, recommendation_type: "own_products",
    user_risk_state: "compliant", flags: 0, json_data: nil, confirmed_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT
  }.merge(overrides)
end

def link_row(id = 1, **overrides)
  { id:, name: "Product #{id}", user_id: 1, unique_permalink: "p#{id}", price_currency_type: "usd", flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def purchase_row(id, **overrides)
  { id:, link_id: 1, seller_id: 1, email: "buyer@example.com", purchase_state: "successful", price_cents: 500, displayed_price_cents: 500, quantity: 1, flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def price_row(id, recurrence, **overrides)
  { id:, link_id: 1, price_cents: 500, currency: "usd", recurrence:, flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def merchant_account_row(id, **overrides)
  { id:, charge_processor_id: "stripe", charge_processor_merchant_id: "acct_#{id}", country: "US", currency: "usd", charge_processor_alive_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

# One membership: a price, a payment option, the subscription, its original purchase and the
# purchases that paid for it (`paid_at` is each successful purchase's created_at and succeeded_at).
def membership(id = 1, recurrence: "monthly", paid_at: [], original: {}, extra_purchases: [], payment_option: {}, **subscription)
  purchases = [purchase_row(id * 100, subscription_id: id, flags: ORIGINAL_SUBSCRIPTION_PURCHASE, created_at: ORIGINAL_AT, succeeded_at: ORIGINAL_AT, **original)]
  paid_at.each_with_index do |time, i|
    purchases << purchase_row(id * 100 + 1 + i, subscription_id: id, created_at: at(time), succeeded_at: at(time))
  end
  {
    subscriptions: [{ id:, link_id: 1, user_id: 2, seller_id: 1, flags: 0, last_payment_option_id: id, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(subscription)],
    prices: [price_row(id, recurrence)],
    payment_options: [{ id:, subscription_id: id, price_id: id, flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(payment_option)],
    purchases: purchases + extra_purchases,
  }
end

def merge_seeds(*seeds)
  seeds.each_with_object({}) { |seed, all| seed.each { |table, rows| (all[table] ||= []).concat(rows) } }
end

def base_seed(**extra)
  defaults = { users: [user_row(1), user_row(2)], links: [link_row], merchant_accounts: [merchant_account_row(1), merchant_account_row(2, user_id: 1)] }
  # A case's own rows replace the default ones of the same table.
  defaults.merge(extra.to_h { |table, rows| [table, rows] })
end

def run(name, job, args, seed: {}, features: [], now: NOW, setup: nil)
  $uuid_seq = 0
  result = capture(name, now:, tables: TABLES, seed: base_seed(**seed), setup: lambda {
    features.each { |feature| Feature.activate_user(feature, User.find(1)) }
    setup&.call
  }, sidekiq: true, job:, args:, case_now: now.to_f) { job.constantize.new.perform(*args) }
  result.delete("rows")
  result.delete("seed")
  result
end

cases = []
DAY = 86_400
SELLER_EMAILS = { users: [user_row(1, flags: USER_ENABLE_PAYMENT_EMAIL), user_row(2)] }.freeze

# --- EndSubscriptionWorker ---------------------------------------------------------------------------
ES = "EndSubscriptionWorker"
fixed = { charge_occurrence_count: 1 }
cases << run("end: subscription does not exist", ES, [1])
cases << run("end: test subscription", ES, [1], seed: membership(flags: IS_TEST_SUBSCRIPTION, **fixed))
cases << run("end: failed subscription", ES, [1], seed: membership(failed_at: SEEDED_AT, **fixed))
cases << run("end: cancelled subscription", ES, [1], seed: membership(cancelled_at: at(NOW - DAY), **fixed))
cases << run("end: cancellation pending", ES, [1], seed: membership(cancelled_at: at(NOW + DAY), **fixed))
cases << run("end: not a fixed-length subscription", ES, [1], seed: membership(paid_at: [NOW - DAY]))
cases << run("end: charges remaining", ES, [1], seed: membership(paid_at: [NOW - DAY], charge_occurrence_count: 3))
cases << run("end: charges completed", ES, [1], seed: merge_seeds(membership(**fixed), SELLER_EMAILS))
cases << run("end: charges completed, seller payment emails off", ES, [1], seed: membership(**fixed))
cases << run("end: id as a string", ES, ["1"], seed: merge_seeds(membership(**fixed), SELLER_EMAILS))
cases << run("end: already deactivated", ES, [1], seed: merge_seeds(membership(deactivated_at: SEEDED_AT, **fixed), SELLER_EMAILS))
cases << run("end: latest event is already a deactivation", ES, [1], seed: merge_seeds(membership(**fixed), SELLER_EMAILS,
  { subscription_events: [{ id: 1, subscription_id: 1, seller_id: 1, event_type: 0, occurred_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT }] }))
cases << run("end: latest event is a restart", ES, [1], seed: merge_seeds(membership(**fixed), SELLER_EMAILS,
  { subscription_events: [{ id: 1, subscription_id: 1, seller_id: 1, event_type: 0, occurred_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT },
                          { id: 2, subscription_id: 1, seller_id: 1, event_type: 1, occurred_at: at(NOW - 5 * DAY), created_at: SEEDED_AT, updated_at: SEEDED_AT }] }))
cases << run("end: purchases with variants counted towards inventory", ES, [1], seed: merge_seeds(membership(paid_at: [NOW - DAY], charge_occurrence_count: 2), SELLER_EMAILS,
  { base_variants: [{ id: 1, link_id: 1, name: "Tier", type: "Variant", flags: 0, sales_count_for_inventory_cache: 5 }],
    base_variants_purchases: [{ id: 1, purchase_id: 100, base_variant_id: 1 }, { id: 2, purchase_id: 101, base_variant_id: 1 }] }))
cases << run("end: several purchases to reindex", ES, [1], seed: merge_seeds(membership(paid_at: [NOW - DAY, NOW - 2 * DAY], charge_occurrence_count: 3), SELLER_EMAILS))
cases << run("end: no payment option", ES, [1], seed: merge_seeds(membership(**fixed), SELLER_EMAILS).merge(payment_options: []))

# --- UnsubscribeAndFailWorker ------------------------------------------------------------------------
UF = "UnsubscribeAndFailWorker"
overdue = [NOW - 33 * DAY]
notice_key = ->(*extra) { SentEmailInfo.mailer_key_digest("ContactingCreatorMailer", "subscription_autocancelled", 1, *extra) }
notice = ->(id, created_at, key = notice_key.call) { { sent_email_infos: [{ id:, key:, created_at: at(created_at), updated_at: at(created_at) }] } }
cases << run("unsubscribe: subscription does not exist", UF, [1])
cases << run("unsubscribe: failed subscription", UF, [1], seed: membership(paid_at: overdue, failed_at: SEEDED_AT))
cases << run("unsubscribe: cancellation pending", UF, [1], seed: membership(paid_at: overdue, cancelled_at: at(NOW + DAY)))
cases << run("unsubscribe: test subscription", UF, [1], seed: membership(paid_at: overdue, flags: IS_TEST_SUBSCRIPTION))
cases << run("unsubscribe: not overdue", UF, [1], seed: membership(paid_at: [NOW - 3 * DAY]))
cases << run("unsubscribe: overdue", UF, [1], seed: merge_seeds(membership(paid_at: overdue), SELLER_EMAILS))
cases << run("unsubscribe: overdue, seller payment emails off", UF, [1], seed: membership(paid_at: overdue))
cases << run("unsubscribe: id as a string", UF, ["1"], seed: merge_seeds(membership(paid_at: overdue), SELLER_EMAILS))
cases << run("unsubscribe: creator notified less than a week ago", UF, [1], seed: merge_seeds(membership(paid_at: overdue), SELLER_EMAILS, notice.call(1, NOW - 2 * DAY)))
cases << run("unsubscribe: creator notified more than a week ago", UF, [1], seed: merge_seeds(membership(paid_at: overdue), SELLER_EMAILS, notice.call(1, NOW - 9 * DAY)))
cases << run("unsubscribe: overdue with an earlier deactivation event", UF, [1], seed: merge_seeds(membership(paid_at: overdue, deactivated_at: SEEDED_AT), SELLER_EMAILS,
  { subscription_events: [{ id: 1, subscription_id: 1, seller_id: 1, event_type: 0, occurred_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT }] }))
cases << run("unsubscribe: mandate reliability on, renewals enabled, no card", UF, [1], features: [:india_card_mandate_reliability], seed: merge_seeds(membership(paid_at: overdue), SELLER_EMAILS))
cases << run("unsubscribe: mandate reliability on, renewals disabled", UF, [1], features: [:india_card_mandate_reliability], seed: merge_seeds(membership(paid_at: overdue, flags: RENEWAL_DISABLED_INDIAN_MANDATE), SELLER_EMAILS))
cards = { credit_cards: [{ id: 1, card_type: "visa", created_at: SEEDED_AT, updated_at: SEEDED_AT }] }
cases << run("unsubscribe: mandate reliability on, card without a failed charge", UF, [1], features: [:india_card_mandate_reliability],
  seed: merge_seeds(membership(paid_at: overdue, credit_card_id: 1), SELLER_EMAILS, cards))
cases << run("unsubscribe: mandate reliability on, card with a failed charge", UF, [1], features: [:india_card_mandate_reliability],
  seed: merge_seeds(membership(paid_at: overdue, credit_card_id: 1, extra_purchases: [purchase_row(190, subscription_id: 1, purchase_state: "failed", credit_card_id: 1, error_code: "india_card_mandate_inactive", created_at: at(NOW - 2 * DAY))]), SELLER_EMAILS, cards))
cases << run("unsubscribe: mandate reliability on, buyer's own card", UF, [1], features: [:india_card_mandate_reliability],
  seed: merge_seeds(membership(paid_at: overdue), { users: [user_row(1, flags: USER_ENABLE_PAYMENT_EMAIL), user_row(2, credit_card_id: 1)] }, cards))

# --- SetSubscriptionAsDeactivatedWorker -----------------------------------------------------------------
SD = "SetSubscriptionAsDeactivatedWorker"
workflow = ->(**fields) { { workflows: [{ id: 1, seller_id: 1, workflow_type: "seller", created_at: SEEDED_AT, updated_at: SEEDED_AT, **fields }] } }
cases << run("deactivated: subscription does not exist", SD, [1])
cases << run("deactivated: alive subscription", SD, [1], seed: membership(paid_at: [NOW - DAY]))
cases << run("deactivated: cancellation pending", SD, [1], seed: membership(paid_at: [NOW - DAY], cancelled_at: at(NOW + DAY)))
cases << run("deactivated: failed", SD, [1], seed: membership(paid_at: [NOW - DAY], failed_at: at(NOW - DAY)))
cases << run("deactivated: ended", SD, [1], seed: membership(paid_at: [NOW - DAY], ended_at: at(NOW - DAY)))
cases << run("deactivated: cancelled", SD, [1], seed: membership(paid_at: [NOW - DAY], cancelled_at: at(NOW - DAY)))
cases << run("deactivated: cancelled, id as a string", SD, ["1"], seed: membership(paid_at: [NOW - DAY], cancelled_at: at(NOW - DAY)))
cases << run("deactivated: cancelled by the buyer", SD, [1], seed: membership(paid_at: [NOW - DAY], cancelled_at: at(NOW - DAY), flags: 2))
cases << run("deactivated: cancelled, seller has a workflow without a trigger", SD, [1], seed: merge_seeds(membership(paid_at: [NOW - DAY], cancelled_at: at(NOW - DAY)), workflow.call))
cases << run("deactivated: cancelled, seller has a member cancellation workflow", SD, [1],
  seed: merge_seeds(membership(paid_at: [NOW - DAY], cancelled_at: at(NOW - DAY)), workflow.call(json_data: { workflow_trigger: "member_cancellation" }.to_json)))
cases << run("deactivated: failed, seller has a member cancellation workflow", SD, [1],
  seed: merge_seeds(membership(paid_at: [NOW - DAY], failed_at: at(NOW - DAY)), workflow.call(json_data: { workflow_trigger: "member_cancellation" }.to_json)))
cases << run("deactivated: cancelled, deleted and product workflows", SD, [1],
  seed: merge_seeds(membership(paid_at: [NOW - DAY], cancelled_at: at(NOW - DAY)),
                    { workflows: [{ id: 1, seller_id: 1, workflow_type: "seller", deleted_at: SEEDED_AT, json_data: { workflow_trigger: "member_cancellation" }.to_json, created_at: SEEDED_AT, updated_at: SEEDED_AT },
                                  { id: 2, seller_id: 1, link_id: 1, workflow_type: "product", created_at: SEEDED_AT, updated_at: SEEDED_AT },
                                  { id: 3, seller_id: 1, workflow_type: "audience", created_at: SEEDED_AT, updated_at: SEEDED_AT }] }))
cases << run("deactivated: cancelled, already deactivated", SD, [1], seed: membership(paid_at: [NOW - DAY], cancelled_at: at(NOW - 3 * DAY), deactivated_at: at(NOW - 2 * DAY)))
cases << run("deactivated: cancelled test subscription", SD, [1], seed: membership(paid_at: [NOW - DAY], cancelled_at: at(NOW - DAY), flags: IS_TEST_SUBSCRIPTION))
cases << run("deactivated: cancelled, indian mandate hold pending", SD, [1], seed: membership(paid_at: [NOW - DAY], cancelled_at: at(NOW - DAY), flags: INDIAN_MANDATE_HOLD_PENDING))
cases << run("deactivated: cancelled, indian mandate held", SD, [1], seed: membership(paid_at: [NOW - DAY], cancelled_at: at(NOW - DAY), flags: INDIAN_MANDATE_HOLD_PENDING | RENEWAL_DISABLED_INDIAN_MANDATE, stripe_mandate_id: "mandate_1"))
cases << run("deactivated: cancelled, no original purchase", SD, [1], seed: membership(cancelled_at: at(NOW - DAY)).merge(purchases: []))
cases << run("deactivated: cancelled, no payment option", SD, [1], seed: membership(paid_at: [NOW - DAY], cancelled_at: at(NOW - DAY)).merge(payment_options: []))

File.write(OUT,JSON.pretty_generate({ "now" => travel_to(NOW, with_usec: true) { Time.now.to_f }, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
