# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/order-review-reminder-job.golden.json: OrderReviewReminderJob run by the real app
# against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). The reminders are deliver_later pushes (visible in the
# scratch Redis) and the SentEmailInfo rows written after each push come back in the case's `rows`. Purchases are plain INSERTs
# (the purchase factory charges Stripe). Run it like expiring-credit-card-message-worker.rb (env as in publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/order-review-reminder-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[users links purchases orders order_purchases gifts product_reviews sent_email_infos].freeze
GIFT_SENDER_PURCHASE = Purchase.flag_mapping["flags"][:is_gift_sender_purchase]
GIFT_RECEIVER_PURCHASE = Purchase.flag_mapping["flags"][:is_gift_receiver_purchase]
USER_OPTED_OUT_OF_REVIEW_REMINDERS = User.flag_mapping["flags"][:opted_out_of_review_reminders]
USER_DISABLE_REVIEW_REMINDERS = User.flag_mapping["flags"][:disable_review_reminders]
MAILER = "CustomerLowPriorityMailer"

Rails.logger = ActiveSupport::Logger.new(nil)
ActiveJob::Base.queue_adapter = :sidekiq
ActiveJob::Base.logger = Logger.new(nil)
ActionMailer::Base.deliver_later_queue_name = :default
$uuid_seq = 0
SecureRandom.singleton_class.prepend(Module.new do
  def uuid = format("00000000-0000-4000-8000-%012x", ($uuid_seq += 1))
end)

# The nth ActiveJob push of a case fails, as a Sidekiq client outage would.
$enqueues = 0
$fail_enqueue_at = nil
ActiveJob::QueueAdapters::SidekiqAdapter.prepend(Module.new do
  def enqueue(job)
    $enqueues += 1
    raise "push failed" if $fail_enqueue_at == $enqueues

    super
  end
end)

def user_row(id, **overrides) = { id:, email: "user#{id}@example.com", username: "user#{id}", external_id: (1000 + id).to_s, user_risk_state: "compliant", flags: 0, confirmed_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)

def link_row(id = 1) = { id:, name: "Product #{id}", user_id: 1, unique_permalink: "p#{id}", price_currency_type: "usd", flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }

def purchase_row(id, **overrides) = { id:, link_id: 1, seller_id: 1, email: "buyer@example.com", purchase_state: "successful", price_cents: 500, displayed_price_cents: 500, flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)

def order_rows(order_id, *purchase_ids) = { orders: [{ id: order_id, purchaser_id: 2, created_at: SEEDED_AT, updated_at: SEEDED_AT }], order_purchases: purchase_ids.each_with_index.map { |purchase_id, i| { id: order_id * 100 + i, order_id:, purchase_id:, created_at: SEEDED_AT, updated_at: SEEDED_AT } } }

def gift_row(id, sender, receiver, **overrides) = { id:, gifter_purchase_id: sender, giftee_purchase_id: receiver, link_id: 1, state: "successful", flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)

def marker(*args) = { sent_email_infos: [{ id: 9000, key: SentEmailInfo.mailer_key_digest(MAILER, *args), created_at: SEEDED_AT, updated_at: SEEDED_AT }] }

def merge_seeds(*seeds) = seeds.each_with_object({}) { |seed, all| seed.each { |table, rows| (all[table] ||= []).concat(rows) } }

def run(name, args, purchases: [], order: [1], extra: {}, seller_flags: 0, buyer_flags: 0, fail_enqueue_at: nil)
  $enqueues = 0
  $fail_enqueue_at = fail_enqueue_at
  $uuid_seq = 0
  seed = merge_seeds({ users: [user_row(1, flags: seller_flags), user_row(2, flags: buyer_flags)], links: [link_row], purchases: }, order_rows(1, *order), extra)
  result = capture(name, now: NOW, tables: TABLES, seed:, sidekiq: true, job: "OrderReviewReminderJob", args:) { OrderReviewReminderJob.new.perform(*args) }
  result.delete("seed")
  result
end

cases = []
cases << run("an order that does not exist", [99])
cases << run("an order with no purchases", [1], order: [])
cases << run("one eligible purchase", [1], purchases: [purchase_row(1)], order: [1])
cases << run("two eligible purchases sharing an address", [1], purchases: [purchase_row(1), purchase_row(2)], order: [1, 2])
cases << run("two eligible purchases whose addresses differ in case", [1], purchases: [purchase_row(1, email: "Buyer@Example.com"), purchase_row(2, email: "bUYER@example.COM")], order: [1, 2])
cases << run("two eligible purchases with different addresses", [1], purchases: [purchase_row(1), purchase_row(2, email: "other@example.com")], order: [1, 2])
cases << run("two eligible purchases with no address", [1], purchases: [purchase_row(1, email: nil), purchase_row(2, email: nil)], order: [1, 2])
cases << run("two eligible purchases and one has no address", [1], purchases: [purchase_row(1), purchase_row(2, email: nil)], order: [1, 2])
cases << run("two eligible purchases with an empty address", [1], purchases: [purchase_row(1, email: ""), purchase_row(2, email: "")], order: [1, 2])
cases << run("three eligible purchases sharing an address", [1], purchases: [purchase_row(3), purchase_row(1), purchase_row(2)], order: [3, 1, 2])
cases << run("two addresses that differ only by a non ASCII letter case", [1], purchases: [purchase_row(1, email: "Ä@example.com"), purchase_row(2, email: "ä@example.com")], order: [1, 2])
cases << run("an order reminder already recorded", [1], purchases: [purchase_row(1), purchase_row(2)], order: [1, 2], extra: marker("order_review_reminder", 1))
cases << run("one purchase reminder already recorded of two with different addresses", [1], purchases: [purchase_row(1), purchase_row(2, email: "other@example.com")], order: [1, 2], extra: marker("purchase_review_reminder", 1))
cases << run("a purchase reminder already recorded for the only purchase", [1], purchases: [purchase_row(1)], order: [1], extra: marker("purchase_review_reminder", 1))
cases << run("one of two purchases is refunded", [1], purchases: [purchase_row(1), purchase_row(2, stripe_refunded: true)], order: [1, 2])
cases << run("every purchase is refunded", [1], purchases: [purchase_row(1, stripe_refunded: true), purchase_row(2, stripe_refunded: true)], order: [1, 2])
cases << run("a purchase that cannot be contacted", [1], purchases: [purchase_row(1), purchase_row(2, can_contact: false)], order: [1, 2])
cases << run("a seller who disabled reminders", [1], purchases: [purchase_row(1), purchase_row(2)], order: [1, 2], seller_flags: USER_DISABLE_REVIEW_REMINDERS)
cases << run("a buyer who opted out of reminders", [1], purchases: [purchase_row(1, purchaser_id: 2), purchase_row(2)], order: [1, 2], buyer_flags: USER_OPTED_OUT_OF_REVIEW_REMINDERS)
cases << run("a buyer who has not opted out", [1], purchases: [purchase_row(1, purchaser_id: 2), purchase_row(2, purchaser_id: 2)], order: [1, 2])
cases << run("a purchase that was reviewed", [1], purchases: [purchase_row(1), purchase_row(2)], order: [1, 2],
                                                 extra: { product_reviews: [{ id: 1, purchase_id: 1, rating: 5, link_id: 1, created_at: SEEDED_AT, updated_at: SEEDED_AT }] })
cases << run("failed and not charged purchases", [1], purchases: [purchase_row(1, purchase_state: "failed"), purchase_row(2, purchase_state: "not_charged"), purchase_row(3)], order: [1, 2, 3])
gift = ->(extra = {}) { merge_seeds({ gifts: [gift_row(1, 1, 2)] }, extra) }
cases << run("a gift sender purchase and its eligible receiver purchase", [1],
             purchases: [purchase_row(1, flags: GIFT_SENDER_PURCHASE), purchase_row(2, email: "giftee@example.com", flags: GIFT_RECEIVER_PURCHASE, purchase_state: "gift_receiver_purchase_successful")], order: [1], extra: gift.call)
cases << run("a gift sender purchase with no gift", [1], purchases: [purchase_row(1, flags: GIFT_SENDER_PURCHASE)], order: [1])
cases << run("a gift without a receiver purchase", [1], purchases: [purchase_row(1, flags: GIFT_SENDER_PURCHASE)], order: [1], extra: { gifts: [gift_row(1, 1, nil)] })
cases << run("a gift whose receiver purchase is missing", [1], purchases: [purchase_row(1, flags: GIFT_SENDER_PURCHASE)], order: [1], extra: { gifts: [gift_row(1, 1, 99)] })
cases << run("a gift whose receiver purchase is not eligible", [1],
             purchases: [purchase_row(1, flags: GIFT_SENDER_PURCHASE), purchase_row(2, flags: GIFT_RECEIVER_PURCHASE, purchase_state: "failed")], order: [1], extra: gift.call)
cases << run("a gift sender purchase next to an ordinary purchase", [1],
             purchases: [purchase_row(1, flags: GIFT_SENDER_PURCHASE), purchase_row(2, email: "giftee@example.com", flags: GIFT_RECEIVER_PURCHASE, purchase_state: "gift_receiver_purchase_successful"), purchase_row(3)],
             order: [1, 3], extra: gift.call)
cases << run("a gift receiver purchase sharing an address with an ordinary purchase", [1],
             purchases: [purchase_row(1, flags: GIFT_SENDER_PURCHASE), purchase_row(2, flags: GIFT_RECEIVER_PURCHASE, purchase_state: "gift_receiver_purchase_successful"), purchase_row(3)],
             order: [1, 3], extra: gift.call)
cases << run("two gift sender purchases pointing at one receiver purchase", [1],
             purchases: [purchase_row(1, flags: GIFT_SENDER_PURCHASE), purchase_row(3, flags: GIFT_SENDER_PURCHASE), purchase_row(2, flags: GIFT_RECEIVER_PURCHASE, purchase_state: "gift_receiver_purchase_successful")],
             order: [1, 3], extra: { gifts: [gift_row(1, 1, 2), gift_row(2, 3, 2)] })
cases << run("a receiver purchase listed in the order itself", [1],
             purchases: [purchase_row(2, flags: GIFT_RECEIVER_PURCHASE, purchase_state: "gift_receiver_purchase_successful")], order: [2])
cases << run("the same purchase listed twice in the order", [1], purchases: [purchase_row(1)], order: [1, 1])
cases << run("an order id given as a digit string", ["1"], purchases: [purchase_row(1), purchase_row(2)], order: [1, 2])
cases << run("an order id given as a float", [1.5], purchases: [purchase_row(1)], order: [1])
cases << run("an order id given as nil", [nil], purchases: [purchase_row(1)], order: [1])
cases << run("an order id given as a word", ["abc"], purchases: [purchase_row(1)], order: [1])
cases << run("the second purchase reminder fails to enqueue", [1], purchases: [purchase_row(1), purchase_row(2, email: "other@example.com")], order: [1, 2], fail_enqueue_at: 2)
cases << run("the first purchase reminder fails to enqueue", [1], purchases: [purchase_row(1), purchase_row(2, email: "other@example.com")], order: [1, 2], fail_enqueue_at: 1)
cases << run("the order reminder fails to enqueue", [1], purchases: [purchase_row(1), purchase_row(2)], order: [1, 2], fail_enqueue_at: 1)

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
