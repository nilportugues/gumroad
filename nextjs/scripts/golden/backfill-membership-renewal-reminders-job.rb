# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/backfill-membership-renewal-reminders-job.golden.json: BackfillMembershipRenewalRemindersJob
# run by the real app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). The job claims a Redis key and keeps a
# cursor there, so each case records the Redis it started from (`redis_before`) and the one it left. Kernel#rand is fixed at
# RAND_VALUE so the spread of a reminder that is already due is reproducible. Run it like publish-scheduled-post.rb (env as there):
#
#   bundle exec rails runner nextjs/scripts/golden/backfill-membership-renewal-reminders-job.rb
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/backfill-membership-renewal-reminders-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[users links subscriptions payment_options prices purchases merchant_accounts installment_plan_snapshots product_installment_plans
            orders order_purchases user_compliance_info].freeze
DAY = 86_400
RAND_VALUE = 0.5
CURSOR_KEY = Onetime::BackfillMembershipRenewalReminders::CURSOR_KEY
RUNNING_KEY = Onetime::BackfillMembershipRenewalReminders::RUNNING_KEY

IS_TEST_SUBSCRIPTION = 1
RENEWAL_DISABLED_INDIAN_MANDATE = 1 << 7
ORIGINAL_SUBSCRIPTION_PURCHASE = 1 << 2
FREE_TRIAL_PURCHASE = 1 << 18

Rails.logger = ActiveSupport::Logger.new(nil)
ActiveJob::Base.logger = Logger.new(nil)
Stripe.api_base = "http://127.0.0.1:9"
Stripe.max_network_retries = 0

Onetime::BackfillMembershipRenewalReminders.prepend(Module.new do
  def rand(*) = RAND_VALUE
end)

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

# One membership: a price, a payment option, the subscription, its original purchase and the purchases that paid for it.
def membership(id = 1, recurrence: "monthly", paid_at: [], free_trial_ends_at: nil, extra_purchases: [], purchases: nil, price: true, **subscription)
  purchases ||= [purchase_row(id * 100, subscription_id: id, flags: ORIGINAL_SUBSCRIPTION_PURCHASE, created_at: "2020-01-01 00:00:00", succeeded_at: "2020-01-01 00:00:00")] +
                paid_at.each_with_index.map { |time, i| purchase_row(id * 100 + 1 + i, subscription_id: id, created_at: at(time), succeeded_at: at(time)) }
  {
    subscriptions: [{ id:, link_id: 1, user_id: 2, seller_id: 1, flags: 0, last_payment_option_id: price ? id : nil, free_trial_ends_at: free_trial_ends_at && at(free_trial_ends_at),
                      created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(subscription)],
    prices: price ? [price_row(id, recurrence)] : [],
    payment_options: price ? [{ id:, subscription_id: id, price_id: id, flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }] : [],
    purchases: purchases + extra_purchases,
  }
end

def merge_seeds(*seeds)
  seeds.each_with_object({}) { |seed, all| seed.each { |table, rows| (all[table] ||= []).concat(rows) } }
end

def base_seed(seed)
  { users: [user_row(1), user_row(2)], links: [link_row], merchant_accounts: [merchant_account_row(1), merchant_account_row(2, user_id: 1)] }.merge(seed)
end

def run(name, seed: {}, features: [:membership_renewal_reminders], strings: {}, now: NOW)
  setup = lambda do
    features.each { |feature| Feature.activate_user(feature, User.find(1)) }
    strings.each { |key, value| redis.set(key, value) }
  end
  result = capture(name, now:, tables: TABLES, seed: base_seed(seed), setup:, sidekiq: true, job: "BackfillMembershipRenewalRemindersJob", args: [], case_now: now.to_f) do
    BackfillMembershipRenewalRemindersJob.new.perform
  end
  result.delete("rows")
  result.delete("seed")
  result
end

PAID_BEFORE_FLAG = Time.utc(2026, 9, 20, 10, 0, 0)
def paid(id = 1, **options) = membership(id, paid_at: [PAID_BEFORE_FLAG], **options)

cases = []
cases << run("no subscriptions")
cases << run("another run holds the claim", strings: { RUNNING_KEY => "1" })
cases << run("another run holds the claim with a cursor", strings: { RUNNING_KEY => "1", CURSOR_KEY => "5" }, seed: paid)
cases << run("a monthly membership already due", seed: paid)
cases << run("a monthly membership not yet due", seed: membership(paid_at: [Time.utc(2026, 9, 25, 10, 0, 0)]), now: Time.utc(2026, 10, 1, 9, 0, 0))
cases << run("a monthly membership due within the hour", seed: membership(paid_at: [Time.utc(2026, 9, 25, 10, 0, 0)]), now: Time.utc(2026, 10, 24, 10, 30, 0))
cases << run("a monthly membership due after its renewal date", seed: membership(paid_at: [Time.utc(2026, 8, 20, 10, 0, 0)]))
cases << run("a yearly membership not yet due", seed: membership(recurrence: "yearly", paid_at: [PAID_BEFORE_FLAG]))
cases << run("a quarterly membership", seed: membership(recurrence: "quarterly", paid_at: [PAID_BEFORE_FLAG]))
cases << run("a biannual membership", seed: membership(recurrence: "biannually", paid_at: [PAID_BEFORE_FLAG]))
cases << run("an every two years membership", seed: membership(recurrence: "every_two_years", paid_at: [PAID_BEFORE_FLAG]))
cases << run("renewal reminders off for the seller", features: [], seed: paid)
cases << run("a cursor past the only subscription", strings: { CURSOR_KEY => "1" }, seed: paid)
cases << run("a cursor before the only subscription", strings: { CURSOR_KEY => "0" }, seed: paid)
cases << run("a cursor that is not a number", strings: { CURSOR_KEY => "abc" }, seed: paid)
cases << run("a cursor with trailing text", strings: { CURSOR_KEY => "1x" }, seed: merge_seeds(paid, paid(2)))
cases << run("a negative cursor", strings: { CURSOR_KEY => "-3" }, seed: paid)
cases << run("a cursor with underscores", strings: { CURSOR_KEY => "1_0" }, seed: paid)
cases << run("a cancelled subscription", seed: paid(cancelled_at: SEEDED_AT))
cases << run("a subscription that ended", seed: paid(ended_at: SEEDED_AT))
cases << run("a failed subscription", seed: paid(failed_at: SEEDED_AT))
cases << run("a subscription without purchases", seed: paid.merge(purchases: []))
cases << run("a last purchase after the flag moment", seed: membership(paid_at: [Time.utc(2026, 9, 26, 15, 0, 25)]))
cases << run("a last purchase at the flag moment", seed: membership(paid_at: [Time.utc(2026, 9, 26, 15, 0, 24)]))
cases << run("a last purchase just before the flag moment", seed: membership(paid_at: [Time.utc(2026, 9, 26, 15, 0, 23)]))
cases << run("a subscription in a free trial", seed: membership(free_trial_ends_at: NOW + 5 * DAY, purchases: [
  purchase_row(100, subscription_id: 1, flags: ORIGINAL_SUBSCRIPTION_PURCHASE | FREE_TRIAL_PURCHASE, purchase_state: "not_charged", created_at: at(PAID_BEFORE_FLAG)),
]))
cases << run("a subscription whose free trial is over", seed: membership(free_trial_ends_at: NOW - DAY, paid_at: [PAID_BEFORE_FLAG]))
cases << run("a fixed length subscription with all charges made", seed: paid(charge_occurrence_count: 1))
cases << run("a fixed length subscription with charges left", seed: paid(charge_occurrence_count: 3))
cases << run("a fixed length test subscription", seed: paid(charge_occurrence_count: 1, flags: IS_TEST_SUBSCRIPTION))
cases << run("renewals disabled by an Indian mandate with reliability on", features: %i[membership_renewal_reminders india_card_mandate_reliability],
  seed: paid(flags: RENEWAL_DISABLED_INDIAN_MANDATE))
cases << run("renewals disabled by an Indian mandate with reliability off", seed: paid(flags: RENEWAL_DISABLED_INDIAN_MANDATE))
cases << run("renewals disabled by an Indian mandate on a Connect seller", features: %i[membership_renewal_reminders india_card_mandate_reliability],
  seed: merge_seeds(paid(flags: RENEWAL_DISABLED_INDIAN_MANDATE), { merchant_accounts: [merchant_account_row(1), merchant_account_row(2, user_id: 1, json_data: { meta: { stripe_connect: "true" } }.to_json)] }))
cases << run("a subscription without a price", seed: membership(paid_at: [PAID_BEFORE_FLAG], price: false))
cases << run("a subscription without a price followed by a good one", seed: merge_seeds(membership(paid_at: [PAID_BEFORE_FLAG], price: false), paid(2)))
cases << run("a subscription with an unknown recurrence", seed: membership(recurrence: "weekly", paid_at: [PAID_BEFORE_FLAG]))
cases << run("a subscription whose last purchase was charged back", seed: paid.merge(purchases: [
  purchase_row(100, subscription_id: 1, flags: ORIGINAL_SUBSCRIPTION_PURCHASE, created_at: "2020-01-01 00:00:00", succeeded_at: "2020-01-01 00:00:00"),
  purchase_row(101, subscription_id: 1, created_at: at(PAID_BEFORE_FLAG), succeeded_at: at(PAID_BEFORE_FLAG), chargeback_date: at(PAID_BEFORE_FLAG + DAY)),
]))
cases << run("a refunded last period", seed: paid.merge(purchases: [
  purchase_row(100, subscription_id: 1, flags: ORIGINAL_SUBSCRIPTION_PURCHASE, created_at: "2020-01-01 00:00:00", succeeded_at: "2020-01-01 00:00:00"),
  purchase_row(101, subscription_id: 1, created_at: at(PAID_BEFORE_FLAG), succeeded_at: at(PAID_BEFORE_FLAG), stripe_refunded: true),
]))
cases << run("several subscriptions, some skipped", seed: merge_seeds(
  paid, paid(2, flags: IS_TEST_SUBSCRIPTION, charge_occurrence_count: 1), paid(3, recurrence: "yearly"), paid(4, cancelled_at: SEEDED_AT), paid(5, recurrence: "quarterly"),
))
cases << run("subscriptions of another seller", seed: merge_seeds(
  { users: [user_row(1), user_row(2), user_row(3)] },
  paid(seller_id: 3),
))

# 501 live subscriptions the seller's feature flag skips: the second find_each batch is a query of its own.
many = (1..501).map { |id| { id:, link_id: 1, user_id: 2, seller_id: 1, flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT } }
cases << run("a second batch of subscriptions", features: [], seed: { subscriptions: many })

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
