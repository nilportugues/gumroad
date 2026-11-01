# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/subscription-reminder-jobs.golden.json: the
# subscription reminder jobs (and the SentEmailInfo markers they write), run by the real app against
# a scratch database, each case as a Sidekiq job (support/sidekiq_executor.rb). Run it like
# purchase-reads-jobs.rb:
#
#   RAILS_ENV=test DATABASE_NAME=gumroad_ws46 TEST_DATABASE_NAME=gumroad_ws46 DISABLE_TEST_REDIS_ISOLATION=1 \
#     USE_DB_WORKER_REPLICAS=true REDIS_HOST=127.0.0.1:6379/12 SIDEKIQ_REDIS_HOST=127.0.0.1:6379/12 \
#     RPUSH_REDIS_HOST=127.0.0.1:6379/12 RACK_ATTACK_REDIS_HOST=127.0.0.1:6379/12 \
#     bundle exec rails runner nextjs/scripts/golden/subscription-reminder-jobs.rb
#
# Purchases and subscriptions are plain INSERTs (the purchase factory charges Stripe). Each case may
# run at its own frozen time; the golden records it as `now`. Also writes
# src/server/models/subscription-data.generated.json (the countries Country#can_accept_stripe_charges? refuses).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/subscription-reminder-jobs.golden.json")
DATA_OUT = Rails.root.join("nextjs/src/server/models/subscription-data.generated.json")
NOW = Time.utc(2025, 11, 1, 12, 30, 45, 123_000)
SEEDED_AT = "2025-01-01 00:00:00"
ORIGINAL_AT = "2020-01-01 00:00:00"
TABLES = %w[users links subscriptions payment_options prices purchases installment_plan_snapshots product_installment_plans
            merchant_accounts sent_email_infos billing_details charges charge_purchases orders order_purchases product_reviews
            offer_codes offer_codes_products purchase_offer_code_discounts].freeze

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
INDIAN_MANDATE_REQUIRES_REAUTH = 1 << 8
INDIAN_MANDATE_HOLD_PENDING = 1 << 10
IS_INSTALLMENT_PLAN = 1 << 6
ORIGINAL_SUBSCRIPTION_PURCHASE = 1 << 2
ARCHIVED_ORIGINAL_SUBSCRIPTION_PURCHASE = 1 << 17
FREE_TRIAL_PURCHASE = 1 << 18
IS_MULTI_BUY = 1 << 4
GIFT_SENDER_PURCHASE = 1 << 6
SHOULD_EXCLUDE_PRODUCT_REVIEW = 1 << 22
ACCESS_REVOKED = 1 << 24
COMMISSION_COMPLETION = 1 << 29
BUNDLE_PRODUCT_PURCHASE = 1 << 26
CHARGEBACK_REVERSED = 1 << 9
USER_CHECK_MERCHANT_ACCOUNT_IS_LINKED = 1 << 24
USER_OPTED_OUT_OF_REVIEW_REMINDERS = 1 << 41
USER_DISABLE_REVIEW_REMINDERS = 1 << 53

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
  { id:, link_id: 1, seller_id: 1, purchase_state: "successful", price_cents: 500, displayed_price_cents: 500, flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def price_row(id, recurrence, **overrides)
  { id:, link_id: 1, price_cents: 500, currency: "usd", recurrence:, flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def merchant_account_row(id, **overrides)
  { id:, charge_processor_id: "stripe", charge_processor_merchant_id: "acct_#{id}", country: "US", currency: "usd", charge_processor_alive_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

# One membership: a price, a payment option, the subscription, its original purchase and the
# purchases that paid for it (`paid_at` is each successful purchase's created_at and succeeded_at).
def membership(id = 1, recurrence: "monthly", paid_at: [], free_trial_ends_at: nil, original: {}, extra_purchases: [], payment_option: {}, **subscription)
  price_id = id
  option_id = id
  # The original purchase is the oldest one, so `paid_at` times decide the last paid period.
  purchases = [purchase_row(id * 100, subscription_id: id, flags: ORIGINAL_SUBSCRIPTION_PURCHASE, created_at: ORIGINAL_AT, succeeded_at: ORIGINAL_AT, **original)]
  paid_at.each_with_index do |time, i|
    purchases << purchase_row(id * 100 + 1 + i, subscription_id: id, created_at: at(time), succeeded_at: at(time))
  end
  {
    subscriptions: [{ id:, link_id: 1, user_id: 2, seller_id: 1, flags: 0, last_payment_option_id: option_id, free_trial_ends_at: free_trial_ends_at && at(free_trial_ends_at),
                      created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(subscription)],
    prices: [price_row(price_id, recurrence)],
    payment_options: [{ id: option_id, subscription_id: id, price_id:, flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(payment_option)],
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

# The number of statements recorded when AutoInvoiceEligibility finishes: Node hands the job back to
# Rails there when the buyer is eligible, because CustomerMailer.auto_invoice is not ported.
module EligibilityCount
  def eligible?(...)
    super.tap { $eligibility_statements = RailsRecorder.log&.size }
  end
end
AutoInvoiceEligibility.singleton_class.prepend(EligibilityCount)

def run(name, job, args, seed: {}, features: [], now: NOW, setup: nil)
  $uuid_seq = 0
  $eligibility_statements = nil
  result = capture(name, now:, tables: TABLES, seed: base_seed(**seed), setup: lambda {
    features.each { |feature| Feature.activate_user(feature, User.find(1)) }
    setup&.call
  }, sidekiq: true, job:, args:, case_now: now.to_f) { job.constantize.new.perform(*args) }
  result["eligibility_statements"] = $eligibility_statements if $eligibility_statements
  # Cases replay against recorded answers, not a database, so the seed and the final rows stay out.
  result.delete("rows")
  result.delete("seed")
  result
end

cases = []
DAY = 86_400
t = ->(string) { Time.utc(*string.split(/[-: ]/).map(&:to_i)) }

# SentEmailInfo.mailer_key_digest, as the reminder jobs build it.
digests = [
  ["CustomerLowPriorityMailer", "free_trial_expiring_soon", 1],
  ["CustomerLowPriorityMailer", "subscription_renewal_reminder", 1, "advance", 1_764_590_445],
  ["CustomerLowPriorityMailer", "review_reminder", 12_345],
  ["CustomerLowPriorityMailer", "subscription_renewal_reminder", 10_000_000_000, "advance", 0],
  ["CustomerLowPriorityMailer", "subscription_renewal_reminder", 1, "advance", -1],
].map { |args| [args, SentEmailInfo.mailer_key_digest(*args)] }

# --- FreeTrialExpiringReminderWorker ------------------------------------------------------------------
FT = "FreeTrialExpiringReminderWorker"
trial_end = NOW + 2 * DAY
cases << run("free trial: subscription does not exist", FT, [1])
cases << run("free trial: queues the reminder and records the marker", FT, [1], seed: membership(free_trial_ends_at: trial_end))
cases << run("free trial: marker already recorded", FT, [1], seed: merge_seeds(membership(free_trial_ends_at: trial_end),
  { sent_email_infos: [{ id: 1, key: SentEmailInfo.mailer_key_digest("CustomerLowPriorityMailer", "free_trial_expiring_soon", 1), created_at: SEEDED_AT, updated_at: SEEDED_AT }] }))
cases << run("free trial: trial already over", FT, [1], seed: membership(free_trial_ends_at: NOW - 1))
cases << run("free trial: trial ends this very second", FT, [1], seed: membership(free_trial_ends_at: NOW))
cases << run("free trial: no trial", FT, [1], seed: membership)
cases << run("free trial: failed subscription", FT, [1], seed: membership(free_trial_ends_at: trial_end, failed_at: SEEDED_AT))
cases << run("free trial: ended subscription", FT, [1], seed: membership(free_trial_ends_at: trial_end, ended_at: SEEDED_AT))
cases << run("free trial: cancellation pending", FT, [1], seed: membership(free_trial_ends_at: trial_end, cancelled_at: at(NOW + DAY)))
cases << run("free trial: cancelled", FT, [1], seed: membership(free_trial_ends_at: trial_end, cancelled_at: at(NOW - DAY)))
cases << run("free trial: test subscription", FT, [1], seed: membership(free_trial_ends_at: trial_end, flags: IS_TEST_SUBSCRIPTION))
cases << run("free trial: id as a string", FT, ["1"], seed: membership(free_trial_ends_at: trial_end))
cases << run("free trial: mandate renewals disabled, reliability off", FT, [1], seed: membership(free_trial_ends_at: trial_end, flags: RENEWAL_DISABLED_INDIAN_MANDATE))
cases << run("free trial: mandate renewals disabled, reliability on", FT, [1], features: [:india_card_mandate_reliability],
  seed: membership(free_trial_ends_at: trial_end, flags: RENEWAL_DISABLED_INDIAN_MANDATE))
cases << run("free trial: reliability on, renewals enabled", FT, [1], features: [:india_card_mandate_reliability], seed: membership(free_trial_ends_at: trial_end))
cases << run("free trial: reliability on, multi-buy original purchase", FT, [1], features: [:india_card_mandate_reliability],
  seed: membership(free_trial_ends_at: trial_end, flags: RENEWAL_DISABLED_INDIAN_MANDATE, original: { flags: ORIGINAL_SUBSCRIPTION_PURCHASE | IS_MULTI_BUY }))
cases << run("free trial: reliability on, seller on a Connect account", FT, [1], features: [:india_card_mandate_reliability],
  seed: membership(free_trial_ends_at: trial_end, flags: RENEWAL_DISABLED_INDIAN_MANDATE)
    .merge(merchant_accounts: [merchant_account_row(1), merchant_account_row(2, user_id: 1, json_data: { meta: { stripe_connect: "true" } }.to_json)]),
  setup: -> { User.where(id: 1).update_all(flags: USER_CHECK_MERCHANT_ACCOUNT_IS_LINKED) })
cases << run("free trial: reliability on, seller in a cross-border country", FT, [1], features: [:india_card_mandate_reliability],
  seed: membership(free_trial_ends_at: trial_end, flags: RENEWAL_DISABLED_INDIAN_MANDATE).merge(merchant_accounts: [merchant_account_row(1), merchant_account_row(2, user_id: 1, country: "TH")]))
cases << run("free trial: reliability on, no seller account falls back to Gumroad's", FT, [1], features: [:india_card_mandate_reliability],
  seed: membership(free_trial_ends_at: trial_end, flags: RENEWAL_DISABLED_INDIAN_MANDATE).merge(merchant_accounts: [merchant_account_row(1)]))
cases << run("free trial: reliability on, no merchant account at all", FT, [1], features: [:india_card_mandate_reliability],
  seed: membership(free_trial_ends_at: trial_end, flags: RENEWAL_DISABLED_INDIAN_MANDATE).merge(merchant_accounts: []))
cases << run("free trial: merchant_migration feature on", FT, [1], features: [:merchant_migration, :india_card_mandate_reliability],
  seed: membership(free_trial_ends_at: trial_end, flags: RENEWAL_DISABLED_INDIAN_MANDATE))
cases << run("free trial: reliability on, original purchase in an order of two", FT, [1], features: [:india_card_mandate_reliability],
  seed: merge_seeds(membership(free_trial_ends_at: trial_end, flags: RENEWAL_DISABLED_INDIAN_MANDATE, extra_purchases: [purchase_row(900)]),
                    { orders: [{ id: 1, created_at: SEEDED_AT, updated_at: SEEDED_AT }],
                      order_purchases: [{ id: 1, order_id: 1, purchase_id: 100, created_at: SEEDED_AT, updated_at: SEEDED_AT }, { id: 2, order_id: 1, purchase_id: 900, created_at: SEEDED_AT, updated_at: SEEDED_AT }] }))

# --- ChargeDeclinedReminderWorker ----------------------------------------------------------------------
CD = "ChargeDeclinedReminderWorker"
paid_a_month_ago = [NOW - 33 * DAY]
cases << run("declined: subscription does not exist", CD, [1])
cases << run("declined: overdue membership", CD, [1], seed: membership(paid_at: paid_a_month_ago))
cases << run("declined: paid recently", CD, [1], seed: membership(paid_at: [NOW - 3 * DAY]))
cases << run("declined: renews this very second", CD, [1], seed: membership(paid_at: [Time.utc(2025, 10, 1, 12, 30, 45, 123_000)]))
cases << run("declined: renews one microsecond from now", CD, [1], seed: membership(paid_at: [Time.utc(2025, 10, 1, 12, 30, 45, 123_001)]))
cases << run("declined: failed", CD, [1], seed: membership(paid_at: paid_a_month_ago, failed_at: SEEDED_AT))
cases << run("declined: cancellation pending", CD, [1], seed: membership(paid_at: paid_a_month_ago, cancelled_at: at(NOW + DAY)))
cases << run("declined: test subscription", CD, [1], seed: membership(paid_at: paid_a_month_ago, flags: IS_TEST_SUBSCRIPTION))
cases << run("declined: yearly membership overdue", CD, [1], seed: membership(recurrence: "yearly", paid_at: [NOW - 400 * DAY]))
cases << run("declined: yearly membership not overdue", CD, [1], seed: membership(recurrence: "yearly", paid_at: [NOW - 300 * DAY]))
cases << run("declined: mandate renewals disabled, reliability on", CD, [1], features: [:india_card_mandate_reliability],
  seed: membership(paid_at: paid_a_month_ago, flags: RENEWAL_DISABLED_INDIAN_MANDATE))
cases << run("declined: reliability on, renewals enabled", CD, [1], features: [:india_card_mandate_reliability], seed: membership(paid_at: paid_a_month_ago))
cases << run("declined: free trial running", CD, [1], seed: membership(free_trial_ends_at: NOW + 5 * DAY, extra_purchases: [purchase_row(150, subscription_id: 1, purchase_state: "not_charged", flags: FREE_TRIAL_PURCHASE, created_at: at(NOW - 2 * DAY))]))
cases << run("declined: free trial over, never charged", CD, [1], seed: membership(free_trial_ends_at: NOW - DAY, extra_purchases: [purchase_row(150, subscription_id: 1, purchase_state: "not_charged", flags: FREE_TRIAL_PURCHASE, created_at: at(NOW - 12 * DAY))]))
cases << run("declined: no successful purchase and no trial", CD, [1], seed: membership.merge(purchases: [purchase_row(100, subscription_id: 1, flags: ORIGINAL_SUBSCRIPTION_PURCHASE, purchase_state: "failed")]))
cases << run("declined: last charge charged back", CD, [1], seed: membership(paid_at: paid_a_month_ago, extra_purchases: [purchase_row(190, subscription_id: 1, created_at: at(NOW - 2 * DAY), succeeded_at: at(NOW - 2 * DAY), chargeback_date: at(NOW - DAY))]))
cases << run("declined: charge charged back and reversed", CD, [1], seed: membership(paid_at: paid_a_month_ago, extra_purchases: [purchase_row(190, subscription_id: 1, flags: CHARGEBACK_REVERSED, created_at: at(NOW - 2 * DAY), succeeded_at: at(NOW - 2 * DAY), chargeback_date: at(NOW - DAY))]))
cases << run("declined: last charge refunded", CD, [1], seed: membership(paid_at: paid_a_month_ago, extra_purchases: [purchase_row(190, subscription_id: 1, created_at: at(NOW - 2 * DAY), succeeded_at: at(NOW - 2 * DAY), stripe_refunded: true)]))
cases << run("declined: installment plan", CD, [1], seed: membership(paid_at: paid_a_month_ago, flags: IS_INSTALLMENT_PLAN)
  .merge(product_installment_plans: [{ id: 1, link_id: 1, number_of_installments: 3, recurrence: "monthly", created_at: SEEDED_AT, updated_at: SEEDED_AT }],
         payment_options: [{ id: 1, subscription_id: 1, price_id: 1, product_installment_plan_id: 1, flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }]))
cases << run("declined: installment plan with a snapshot", CD, [1], seed: membership(paid_at: paid_a_month_ago, flags: IS_INSTALLMENT_PLAN)
  .merge(product_installment_plans: [{ id: 1, link_id: 1, number_of_installments: 3, recurrence: "monthly", created_at: SEEDED_AT, updated_at: SEEDED_AT }],
         payment_options: [{ id: 1, subscription_id: 1, price_id: 1, product_installment_plan_id: 1, flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }],
         installment_plan_snapshots: [{ id: 1, payment_option_id: 1, number_of_installments: 3, recurrence: "monthly", total_price_cents: 3000, created_at: SEEDED_AT, updated_at: SEEDED_AT }]))
cases << run("declined: no last payment option, falls back to the latest alive one", CD, [1],
  seed: membership(paid_at: paid_a_month_ago, last_payment_option_id: nil))
cases << run("declined: the payment option was deleted", CD, [1], seed: membership(paid_at: paid_a_month_ago, payment_option: { deleted_at: SEEDED_AT }))
cases << run("declined: month end, 31 January plus a month", CD, [1], now: Time.utc(2025, 2, 28, 0, 0, 0), seed: membership(paid_at: [Time.utc(2025, 1, 31, 0, 0, 0)]))
cases << run("declined: month end, a second before 28 February", CD, [1], now: Time.utc(2025, 2, 27, 23, 59, 59), seed: membership(paid_at: [Time.utc(2025, 1, 31, 0, 0, 0)]))
cases << run("declined: leap day yearly", CD, [1], now: Time.utc(2025, 2, 28, 0, 0, 0), seed: membership(recurrence: "yearly", paid_at: [Time.utc(2024, 2, 29, 0, 0, 0)]))
cases << run("declined: leap day yearly, a second early", CD, [1], now: Time.utc(2025, 2, 27, 23, 59, 59), seed: membership(recurrence: "yearly", paid_at: [Time.utc(2024, 2, 29, 0, 0, 0)]))
cases << run("declined: quarterly across 30 November", CD, [1], now: Time.utc(2026, 2, 28, 0, 0, 0), seed: membership(recurrence: "quarterly", paid_at: [Time.utc(2025, 11, 30, 0, 0, 0)]))
cases << run("declined: every two years from a leap day", CD, [1], now: Time.utc(2026, 2, 28, 0, 0, 0), seed: membership(recurrence: "every_two_years", paid_at: [Time.utc(2024, 2, 29, 0, 0, 0)]))
cases << run("declined: biannually", CD, [1], now: Time.utc(2025, 8, 31, 0, 0, 0), seed: membership(recurrence: "biannually", paid_at: [Time.utc(2025, 2, 28, 0, 0, 0)]))
cases << run("declined: the newest of several successful charges counts", CD, [1], seed: membership(paid_at: [NOW - 70 * DAY, NOW - 3 * DAY, NOW - 40 * DAY]))
cases << run("declined: free trial purchase and a later charge", CD, [1], seed: membership(paid_at: [NOW - 3 * DAY], free_trial_ends_at: NOW - 20 * DAY, extra_purchases: [purchase_row(150, subscription_id: 1, purchase_state: "not_charged", flags: FREE_TRIAL_PURCHASE, created_at: at(NOW - 40 * DAY))]))
cases << run("declined: only a free trial purchase", CD, [1], seed: membership(free_trial_ends_at: NOW + 5 * DAY).merge(purchases: [
  purchase_row(100, subscription_id: 1, flags: ORIGINAL_SUBSCRIPTION_PURCHASE, purchase_state: "failed"),
  purchase_row(150, subscription_id: 1, purchase_state: "not_charged", flags: FREE_TRIAL_PURCHASE, created_at: at(NOW - 2 * DAY)),
]))
cases << run("declined: free trial purchase only, trial over", CD, [1], seed: membership(free_trial_ends_at: NOW - DAY).merge(purchases: [
  purchase_row(100, subscription_id: 1, flags: ORIGINAL_SUBSCRIPTION_PURCHASE, purchase_state: "failed"),
  purchase_row(150, subscription_id: 1, purchase_state: "not_charged", flags: FREE_TRIAL_PURCHASE, created_at: at(NOW - 12 * DAY)),
]))
cases << run("declined: a failed purchase after the last success", CD, [1], seed: membership(paid_at: paid_a_month_ago, extra_purchases: [purchase_row(190, subscription_id: 1, purchase_state: "failed", created_at: at(NOW - DAY))]))

# --- RecurringChargeReminderWorker ---------------------------------------------------------------------
RC = "RecurringChargeReminderWorker"
reminders = [:membership_renewal_reminders]
cases << run("reminder: subscription does not exist", RC, [1])
cases << run("reminder: renewal reminders off", RC, [1], seed: membership(paid_at: [NOW - 28 * DAY]))
cases << run("reminder: final reminder", RC, [1], features: reminders, seed: membership(paid_at: [NOW - 28 * DAY]))
cases << run("reminder: final reminder with the kind spelled out as nil", RC, [1, nil], features: reminders, seed: membership(paid_at: [NOW - 28 * DAY]))
cases << run("reminder: final reminder for an unknown kind", RC, [1, "other"], features: reminders, seed: membership(paid_at: [NOW - 28 * DAY]))
cases << run("reminder: in a free trial", RC, [1], features: reminders, seed: membership(free_trial_ends_at: NOW + 5 * DAY))
cases << run("reminder: fixed length, all charges made", RC, [1], features: reminders, seed: membership(paid_at: [NOW - 28 * DAY], charge_occurrence_count: 1))
cases << run("reminder: fixed length, charges left", RC, [1], features: reminders, seed: membership(paid_at: [NOW - 28 * DAY], charge_occurrence_count: 3))
cases << run("reminder: fixed length of a test subscription", RC, [1], features: reminders, seed: membership(paid_at: [NOW - 28 * DAY], charge_occurrence_count: 1, flags: IS_TEST_SUBSCRIPTION))
cases << run("reminder: failed", RC, [1], features: reminders, seed: membership(paid_at: [NOW - 28 * DAY], failed_at: SEEDED_AT))
cases << run("reminder: mandate renewals disabled, reliability on", RC, [1], features: reminders + [:india_card_mandate_reliability],
  seed: membership(paid_at: [NOW - 28 * DAY], flags: RENEWAL_DISABLED_INDIAN_MANDATE))
cases << run("reminder: mandate renewals disabled, reliability off", RC, [1], features: reminders,
  seed: membership(paid_at: [NOW - 28 * DAY], flags: RENEWAL_DISABLED_INDIAN_MANDATE))
cases << run("reminder: advance notice due on a yearly membership", RC, [1, "advance"], features: reminders, seed: membership(recurrence: "yearly", paid_at: [NOW - 340 * DAY]))
cases << run("reminder: advance notice already sent", RC, [1, "advance"], features: reminders, seed: merge_seeds(
  membership(recurrence: "yearly", paid_at: [NOW - 340 * DAY]),
  { sent_email_infos: [{ id: 1, key: SentEmailInfo.mailer_key_digest("CustomerLowPriorityMailer", "subscription_renewal_reminder", 1, "advance", (NOW - 340 * DAY + 12.months).to_i), created_at: SEEDED_AT, updated_at: SEEDED_AT }] }))
cases << run("reminder: advance notice, lead time not reached", RC, [1, "advance"], features: reminders, seed: membership(recurrence: "yearly", paid_at: [NOW - 300 * DAY]))
cases << run("reminder: advance notice, final reminder already due", RC, [1, "advance"], features: reminders, seed: membership(recurrence: "yearly", paid_at: [NOW - 360 * DAY]))
cases << run("reminder: advance notice on a monthly membership", RC, [1, "advance"], features: reminders, seed: membership(paid_at: [NOW - 28 * DAY]))
cases << run("reminder: advance notice, exactly at the lead time", RC, [1, "advance"], features: reminders, seed: membership(recurrence: "yearly", paid_at: [Time.utc(2025, 11, 1, 12, 30, 45, 123_000) - 335 * DAY]))
cases << run("reminder: advance notice for every two years", RC, [1, "advance"], features: reminders, seed: membership(recurrence: "every_two_years", paid_at: [NOW - 700 * DAY]))
cases << run("reminder: advance notice during a free trial", RC, [1, "advance"], features: reminders, seed: membership(recurrence: "yearly", free_trial_ends_at: NOW + 20 * DAY))
cases << run("reminder: advance notice, leap day", RC, [1, "advance"], features: reminders, now: Time.utc(2025, 1, 29, 0, 0, 0),
  seed: membership(recurrence: "yearly", paid_at: [Time.utc(2024, 2, 29, 0, 0, 0)]))
cases << run("reminder: advance notice, paid period was refunded", RC, [1, "advance"], features: reminders,
  seed: membership(recurrence: "yearly", paid_at: [NOW - 500 * DAY], extra_purchases: [purchase_row(190, subscription_id: 1, created_at: at(NOW - 340 * DAY), succeeded_at: at(NOW - 340 * DAY), stripe_refunded: true)]))
cases << run("reminder: advance notice, no purchases after a failed one", RC, [1, "advance"], features: reminders,
  seed: membership(recurrence: "yearly").merge(purchases: [purchase_row(100, subscription_id: 1, flags: ORIGINAL_SUBSCRIPTION_PURCHASE, purchase_state: "failed")]))

# --- ReviewReminderJob ---------------------------------------------------------------------------------
RR = "ReviewReminderJob"
cases << run("review: purchase does not exist", RR, [1])
cases << run("review: eligible purchase", RR, [1], seed: { purchases: [purchase_row(1)] })
cases << run("review: marker already recorded", RR, [1], seed: { purchases: [purchase_row(1)],
  sent_email_infos: [{ id: 1, key: SentEmailInfo.mailer_key_digest("CustomerLowPriorityMailer", "review_reminder", 1), created_at: SEEDED_AT, updated_at: SEEDED_AT }] })
cases << run("review: failed purchase", RR, [1], seed: { purchases: [purchase_row(1, purchase_state: "failed")] })
cases << run("review: free trial purchase", RR, [1], seed: { purchases: [purchase_row(1, purchase_state: "not_charged", flags: FREE_TRIAL_PURCHASE)] })
cases << run("review: not charged purchase", RR, [1], seed: { purchases: [purchase_row(1, purchase_state: "not_charged")] })
cases << run("review: gift receiver purchase", RR, [1], seed: { purchases: [purchase_row(1, purchase_state: "gift_receiver_purchase_successful")] })
cases << run("review: gift sender purchase", RR, [1], seed: { purchases: [purchase_row(1, flags: GIFT_SENDER_PURCHASE)] })
cases << run("review: excluded from reviews", RR, [1], seed: { purchases: [purchase_row(1, flags: SHOULD_EXCLUDE_PRODUCT_REVIEW)] })
cases << run("review: refunded", RR, [1], seed: { purchases: [purchase_row(1, stripe_refunded: true)] })
cases << run("review: partly refunded bundle product", RR, [1], seed: { purchases: [purchase_row(1, flags: BUNDLE_PRODUCT_PURCHASE, stripe_partially_refunded: true)] })
cases << run("review: partly refunded", RR, [1], seed: { purchases: [purchase_row(1, stripe_partially_refunded: true)] })
cases << run("review: charged back", RR, [1], seed: { purchases: [purchase_row(1, chargeback_date: SEEDED_AT)] })
cases << run("review: recurring charge of a subscription", RR, [1], seed: membership.merge(purchases: [purchase_row(1, subscription_id: 1)]))
cases << run("review: original purchase of a subscription", RR, [1], seed: membership.merge(purchases: [purchase_row(1, subscription_id: 1, flags: ORIGINAL_SUBSCRIPTION_PURCHASE)]))
cases << run("review: access revoked and free", RR, [1], seed: { purchases: [purchase_row(1, flags: ACCESS_REVOKED, price_cents: 0)] })
cases << run("review: access revoked and paid", RR, [1], seed: { purchases: [purchase_row(1, flags: ACCESS_REVOKED)] })
cases << run("review: commission completion", RR, [1], seed: { purchases: [purchase_row(1, flags: COMMISSION_COMPLETION)] })
cases << run("review: already reviewed", RR, [1], seed: { purchases: [purchase_row(1)], product_reviews: [{ id: 1, purchase_id: 1, rating: 5, link_id: 1, created_at: SEEDED_AT, updated_at: SEEDED_AT }] })
cases << run("review: seller disabled reminders", RR, [1], seed: { purchases: [purchase_row(1)] },
  setup: -> { User.where(id: 1).update_all(flags: USER_DISABLE_REVIEW_REMINDERS) })
cases << run("review: buyer cannot be contacted", RR, [1], seed: { purchases: [purchase_row(1, can_contact: false)] })
cases << run("review: account holder opted out", RR, [1], seed: { purchases: [purchase_row(1, purchaser_id: 2)] },
  setup: -> { User.where(id: 2).update_all(flags: USER_OPTED_OUT_OF_REVIEW_REMINDERS) })
cases << run("review: account holder has not opted out", RR, [1], seed: { purchases: [purchase_row(1, purchaser_id: 2)] })
cases << run("review: purchaser account is gone", RR, [1], seed: { purchases: [purchase_row(1, purchaser_id: 99)] })
cases << run("review: id as a string", RR, ["1"], seed: { purchases: [purchase_row(1)] })

# --- SendAutoInvoiceEmailJob ---------------------------------------------------------------------------
AI = "SendAutoInvoiceEmailJob"
billing = ->(enabled) { { billing_details: [{ id: 1, purchaser_id: 2, full_name: "Buyer", street_address: "1 Road", city: "Town", zip_code: "1", country_code: "US", auto_email_invoice_enabled: enabled, created_at: SEEDED_AT, updated_at: SEEDED_AT }] } }
cases << run("invoice: neither purchase nor charge exists", AI, [1, nil])
cases << run("invoice: purchase and charge both given", AI, [1, 1], seed: { purchases: [purchase_row(1, purchaser_id: 2)], charges: [{ id: 1, order_id: 1, seller_id: 1, created_at: SEEDED_AT, updated_at: SEEDED_AT }] })
cases << run("invoice: purchase without a purchaser", AI, [1, nil], seed: { purchases: [purchase_row(1)] })
cases << run("invoice: purchaser without billing details", AI, [1, nil], seed: { purchases: [purchase_row(1, purchaser_id: 2)] })
cases << run("invoice: auto invoices off", AI, [1, nil], seed: merge_seeds({ purchases: [purchase_row(1, purchaser_id: 2)] }, billing.(false)))
cases << run("invoice: free purchase", AI, [1, nil], seed: merge_seeds({ purchases: [purchase_row(1, purchaser_id: 2, price_cents: 0)] }, billing.(true)))
cases << run("invoice: free purchase with shipping", AI, [1, nil], seed: merge_seeds({ purchases: [purchase_row(1, purchaser_id: 2, price_cents: 0, shipping_cents: 100)] }, billing.(true)))
cases << run("invoice: eligible purchase", AI, [1, nil], seed: merge_seeds({ purchases: [purchase_row(1, purchaser_id: 2)] }, billing.(true)))
cases << run("invoice: eligible purchase of a subscription", AI, [1, nil], seed: merge_seeds(membership(paid_at: [NOW - DAY]).merge(purchases: [purchase_row(1, purchaser_id: 2, subscription_id: 1)]), billing.(true)))
cases << run("invoice: free trial purchase", AI, [1, nil], seed: merge_seeds(membership(paid_at: [NOW - DAY]).merge(purchases: [purchase_row(1, purchaser_id: 2, subscription_id: 1, flags: FREE_TRIAL_PURCHASE, purchase_state: "not_charged")]), billing.(true)))
order_seed = { orders: [{ id: 1, purchaser_id: 2, created_at: SEEDED_AT, updated_at: SEEDED_AT }],
               order_purchases: [{ id: 1, order_id: 1, purchase_id: 1, created_at: SEEDED_AT, updated_at: SEEDED_AT }],
               charges: [{ id: 1, order_id: 1, seller_id: 1, created_at: SEEDED_AT, updated_at: SEEDED_AT }],
               charge_purchases: [{ id: 1, charge_id: 1, purchase_id: 1, created_at: SEEDED_AT, updated_at: SEEDED_AT }] }
cases << run("invoice: purchase in a charge, sent as the charge receipt", AI, [1, nil], seed: merge_seeds({ purchases: [purchase_row(1, purchaser_id: 2)] }, order_seed, billing.(true)))
cases << run("invoice: charge, eligible", AI, [nil, 1], seed: merge_seeds({ purchases: [purchase_row(1, purchaser_id: 2)] }, order_seed, billing.(true)))
cases << run("invoice: charge whose purchases are free", AI, [nil, 1], seed: merge_seeds({ purchases: [purchase_row(1, purchaser_id: 2, price_cents: 0)] }, order_seed, billing.(true)))
cases << run("invoice: charge, auto invoices off", AI, [nil, 1], seed: merge_seeds({ purchases: [purchase_row(1, purchaser_id: 2)] }, order_seed, billing.(false)))
cases << run("invoice: charge without an order buyer", AI, [nil, 1], seed: merge_seeds({ purchases: [purchase_row(1)] }, order_seed.merge(orders: [{ id: 1, created_at: SEEDED_AT, updated_at: SEEDED_AT }]), billing.(true)))

# --- FindSubscriptionsWithMissingChargeWorker ----------------------------------------------------------
FM = "FindSubscriptionsWithMissingChargeWorker"
cases << run("missing charge: fans out ten batches", FM, [])
cases << run("missing charge: nothing to find", FM, [0])
overdue = [NOW - 33 * DAY]
sub_ids = ->(n) { membership(n, paid_at: overdue) }
cases << run("missing charge: an overdue membership", FM, [1], seed: membership(paid_at: overdue))
cases << run("missing charge: overdue by less than 75 minutes", FM, [1], seed: membership(paid_at: [NOW - 31 * DAY - 60 * 60]))
cases << run("missing charge: overdue by more than 75 minutes", FM, [1], seed: membership(paid_at: [Time.utc(2025, 10, 1, 11, 0, 0)]))
cases << run("missing charge: not overdue", FM, [1], seed: membership(paid_at: [NOW - 3 * DAY]))
cases << run("missing charge: other batch", FM, [3], seed: membership(paid_at: overdue))
cases << run("missing charge: a charge in progress", FM, [1], seed: membership(paid_at: overdue, extra_purchases: [purchase_row(190, subscription_id: 1, purchase_state: "in_progress", created_at: at(NOW - 60))]))
cases << run("missing charge: suspended seller", FM, [1], seed: membership(paid_at: overdue), setup: -> { User.where(id: 1).update_all(user_risk_state: "suspended_for_fraud") })
cases << run("missing charge: test, ended and deactivated subscriptions", FM, [1, 2, 3, 4].first(1), seed: merge_seeds(
  membership(1, paid_at: overdue, flags: IS_TEST_SUBSCRIPTION), membership(11, paid_at: overdue, deactivated_at: SEEDED_AT)))
cases << run("missing charge: zero price", FM, [1], seed: membership(paid_at: overdue, original: { displayed_price_cents: 0 }))
cases << run("missing charge: free trial subscription with no paid charge", FM, [1], seed: membership(free_trial_ends_at: NOW - 5 * DAY))
cases << run("missing charge: mandate hold with no paid period", FM, [1], seed: membership.merge(purchases: [purchase_row(100, subscription_id: 1, flags: ORIGINAL_SUBSCRIPTION_PURCHASE, purchase_state: "failed")]),
  setup: -> { Subscription.where(id: 1).update_all(flags: RENEWAL_DISABLED_INDIAN_MANDATE | INDIAN_MANDATE_HOLD_PENDING, stripe_mandate_id: "mandate_1") })
cases << run("missing charge: a membership with an offer code", FM, [1], seed: merge_seeds(membership(paid_at: overdue, original: { offer_code_id: 1 }),
  { offer_codes: [{ id: 1, user_id: 1, code: "SAVE", amount_percentage: 10, created_at: SEEDED_AT, updated_at: SEEDED_AT }] }))
installment_plan = {
  product_installment_plans: [{ id: 1, link_id: 1, number_of_installments: 3, recurrence: "monthly", created_at: SEEDED_AT, updated_at: SEEDED_AT }],
  payment_options: [{ id: 1, subscription_id: 1, price_id: 1, product_installment_plan_id: 1, flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }],
}
cases << run("missing charge: an installment plan", FM, [1], seed: membership(paid_at: overdue, flags: IS_INSTALLMENT_PLAN).merge(installment_plan))
cases << run("missing charge: three subscriptions in one batch", FM, [1], seed: merge_seeds(*(1..21).step(10).map { |n| membership(n, paid_at: overdue) }))
cases << run("missing charge: subscriptions of two products and sellers", FM, [1], seed: merge_seeds(
  membership(1, paid_at: overdue), membership(11, paid_at: [NOW - 5 * DAY]), membership(21, paid_at: overdue, user_id: 3, seller_id: 3, link_id: 2),
  { users: [user_row(1), user_row(2), user_row(3)], links: [link_row(1), link_row(2, user_id: 3)] }))
cases << run("missing charge: more than one batch", FM, [1], seed: { subscriptions: [] },
  setup: lambda {
    User.where(id: 1).update_all(user_risk_state: "suspended_for_fraud")
    c = ActiveRecord::Base.connection
    rows = Array.new(1001) { |i| "(#{1 + i * 10}, 1, 2, 1, 0, '#{SEEDED_AT}', '#{SEEDED_AT}')" }
    c.execute("INSERT INTO subscriptions (id, link_id, user_id, seller_id, flags, created_at, updated_at) VALUES #{rows.join(", ")}")
  })
cases << run("missing charge: a universal offer code exists", FM, [1], seed: merge_seeds(membership(paid_at: overdue),
  { offer_codes: [{ id: 1, user_id: 1, code: "ALL", universal: true, amount_percentage: 10, existing_customers_only: true, created_at: SEEDED_AT, updated_at: SEEDED_AT }] }))

File.write(DATA_OUT, JSON.pretty_generate({ "cross_border_payouts_countries" => Country.const_get(:CROSS_BORDER_PAYOUTS_COUNTRIES).map(&:alpha2).sort }) + "\n")
now_f = travel_to(NOW, with_usec: true) { Time.now.to_f }
File.write(OUT, JSON.pretty_generate({ "now" => now_f, "digests" => digests, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
