# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/stripe-event-routing.golden.json: HandleStripeEventWorker run by the real app against a
# scratch database as a Sidekiq job (support/sidekiq_executor.rb) for the events Node answers without a ledger write or a Stripe call:
# the no-ops of the charge, capital, payout and seller plan families, the raises that precede any work, the payment_intent
# lifecycle events that stop before the charge processor, and SellerPlan::StripeEventHandler, whose only write is the offer row.
# HTTP is answered by WebMock and a request would be recorded under "http" (the test fails on one). Run it like
# stripe-account-events.rb (env as in publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/stripe-event-routing.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[users merchant_accounts seller_plan_offers charges purchases processed_stripe_events processor_payment_intents versions].freeze
capture_http!

ActiveJob::Base.queue_adapter = :sidekiq
ActiveJob::Base.logger = Logger.new(nil)
Rails.logger = ActiveSupport::Logger.new(nil)
CLIENT_CONFIRMED = Charge.flag_mapping["flags"][:client_confirmed]

def user_row(id, **overrides)
  {
    id:, email: "seller#{id}@example.com", username: "seller#{id}", external_id: (1000 + id).to_s, recommendation_type: "own_products",
    user_risk_state: "compliant", flags: 0, confirmed_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT
  }.merge(overrides)
end

def account_row(id, user_id: 1, merchant_id: "acct_#{id}", **overrides)
  {
    id:, user_id:, charge_processor_id: "stripe", charge_processor_merchant_id: merchant_id, json_data: JSON.generate(meta: { stripe_connect: "true" }),
    country: "US", currency: "usd", charge_processor_alive_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT
  }.merge(overrides)
end

def offer_row(id = 1, **overrides)
  { id:, user_id: 1, arm: "five", price_cents: 500, status: "checkout_started", offered_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def charge_row(id, **overrides)
  { id:, order_id: 1, seller_id: 1, processor_transaction_id: "ch_#{id}", stripe_payment_intent_id: "pi_#{id}", flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def purchase_row(id, **overrides)
  { id:, link_id: 1, seller_id: 1, purchase_state: "successful", created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def event(type, object = {}, id: "evt_1", **extra)
  { "id" => id, "type" => type, "created" => 1_762_000_000, "data" => { "object" => object } }.merge(extra)
end

def run(name, params, seed = {})
  result = capture(name, now: NOW, tables: TABLES, seed:, sidekiq: true, job: "HandleStripeEventWorker", args: [params]) do
    HandleStripeEventWorker.new.perform(params)
  end
  result.delete("seed")
  result.delete("rows")
  result
end

def seeded(users: [user_row(1)], **rest) = { users:, **rest }

connected = { "account" => "acct_1" }
cases = []

# charge.* of the platform and of a connected account
cases << run("charge.failed of the platform is ignored", event("charge.failed", { "object" => "charge", "id" => "ch_1" }))
cases << run("charge.failed of a connected account is ignored", event("charge.failed", { "object" => "charge", "id" => "ch_1" }, **connected))
cases << run("charge.succeeded created by Twitter is ignored", event("charge.succeeded", { "object" => "charge", "id" => "ch_1", "metadata" => { "twitter_username" => "gumroad" } }))
cases << run("charge.succeeded created by Twitter on a connected account is ignored", event("charge.succeeded", { "object" => "charge", "id" => "ch_1", "metadata" => { "twitter_username" => "gumroad" } }, **connected))
cases << run("charge event without a charge object raises", event("charge.captured", { "object" => "refund", "id" => "ch_1" }))
cases << run("charge event without an id raises", event("charge.captured", { "object" => "charge" }))
cases << run("charge event without a created date raises", event("charge.captured", { "object" => "charge", "id" => "ch_1" }).except("created"))
cases << run("charge event raise names a missing event id", event("charge.captured", { "object" => "refund" }).except("id"))
cases << run("charge.dispute event without a dispute object raises", event("charge.dispute.created", { "object" => "charge", "charge" => "ch_1" }))
cases << run("charge.dispute event without a charge id raises", event("charge.dispute.created", { "object" => "dispute", "id" => "dp_1" }))
cases << run("charge.dispute event without a created date raises", event("charge.dispute.created", { "object" => "dispute", "id" => "dp_1", "charge" => "ch_1" }).except("created"))
cases << run("charge.dispute.closed because the charge was refunded is ignored", event("charge.dispute.closed", { "object" => "dispute", "id" => "dp_1", "charge" => "ch_1", "status" => "charge_refunded" }))
cases << run("charge.dispute.closed because the charge was refunded on a connected account is ignored", event("charge.dispute.closed", { "object" => "dispute", "id" => "dp_1", "charge" => "ch_1", "status" => "charge_refunded" }, **connected))

# refund.* and payment_intent.* variants that the handler routes but the charge processor does not
cases << run("refund.updated variant is a no-op", event("refund.updated.v2", { "object" => "refund" }))
cases << run("payment_intent.succeeded variant is a no-op", event("payment_intent.succeeded.v2", { "object" => "payment_intent" }))
cases << run("payment_intent.processing variant is a no-op", event("payment_intent.processing.v2", { "object" => "payment_intent" }))
cases << run("payment_intent.payment_failed without a payment_intent object raises", event("payment_intent.payment_failed", { "object" => "charge" }))
cases << run("payment_intent.succeeded without a payment_intent object raises", event("payment_intent.succeeded", { "object" => "charge" }))
cases << run("payment_intent.processing without a payment_intent object raises", event("payment_intent.processing", { "object" => "charge" }, **connected))

# payment_intent lifecycle events that stop before the charge processor
intent = ->(type, metadata: {}, **extra) { event(type, { "object" => "payment_intent", "id" => "pi_1", "latest_charge" => "ch_1", "metadata" => metadata }.merge(extra)) }
purchase_id = ObfuscateIds.encrypt(77)
combined = { "transfer_group" => "CH-5" }
cases << run("payment_intent.succeeded matching nothing is ignored", intent.("payment_intent.succeeded"), seeded)
cases << run("payment_intent.succeeded of a connected account matching nothing is ignored", intent.("payment_intent.succeeded").merge(connected), seeded)
cases << run("payment_intent.processing with a purchase reference matching nothing is ignored", intent.("payment_intent.processing", metadata: { "purchase" => purchase_id }), seeded)
cases << run("payment_intent.succeeded of a purchase is ignored", intent.("payment_intent.succeeded", metadata: { "purchase" => purchase_id }), seeded(purchases: [purchase_row(77)]))
cases << run("payment_intent.succeeded found by the purchase's stripe_transaction_id is ignored", intent.("payment_intent.succeeded"), seeded(purchases: [purchase_row(78, stripe_transaction_id: "ch_1")]))
cases << run("payment_intent.succeeded found through a processor payment intent is ignored", intent.("payment_intent.succeeded", "latest_charge" => nil),
             seeded(purchases: [purchase_row(79)], processor_payment_intents: [{ id: 1, purchase_id: 79, intent_id: "pi_1", created_at: SEEDED_AT, updated_at: SEEDED_AT }]))
cases << run("payment_intent.succeeded of a charge that is not client confirmed is ignored", intent.("payment_intent.succeeded", **combined), seeded(charges: [charge_row(5)]))
cases << run("payment_intent.processing found by processor_transaction_id, not client confirmed, is ignored", intent.("payment_intent.processing", **combined.merge("transfer_group" => "CH-404")), seeded(charges: [charge_row(9, processor_transaction_id: "ch_1")]))
cases << run("payment_intent.processing found by payment intent id, not client confirmed, is ignored", intent.("payment_intent.processing", "latest_charge" => nil, **combined.merge("transfer_group" => "CH-404")), seeded(charges: [charge_row(9, stripe_payment_intent_id: "pi_1")]))
cases << run("payment_intent.succeeded of a client confirmed charge already processed is ignored", intent.("payment_intent.succeeded", **combined),
             seeded(charges: [charge_row(5, flags: CLIENT_CONFIRMED)], processed_stripe_events: [{ id: 1, event_id: "evt_1", event_type: "payment_intent.succeeded", created_at: SEEDED_AT, updated_at: SEEDED_AT }]))
cases << run("payment_intent.processing of a client confirmed charge already processed on a connected account is ignored", intent.("payment_intent.processing", **combined).merge(connected),
             seeded(charges: [charge_row(5, flags: CLIENT_CONFIRMED)], processed_stripe_events: [{ id: 1, event_id: "evt_1", event_type: "payment_intent.processing", created_at: SEEDED_AT, updated_at: SEEDED_AT }]))

cases << run("payment_intent.succeeded with a purchase reference that does not decode is ignored", intent.("payment_intent.succeeded", metadata: { "purchase" => "not-an-id" }), seeded)
cases << run("payment_intent.succeeded with a combined reference that is not numeric is ignored", intent.("payment_intent.succeeded", "transfer_group" => "CH-abc"), seeded)
cases << run("payment_intent.succeeded with a bare combined prefix is ignored", intent.("payment_intent.succeeded", "transfer_group" => "CH-"), seeded)
cases << run("payment_intent.succeeded with a numeric prefix on the combined reference reads that charge", intent.("payment_intent.succeeded", "transfer_group" => "CH-5x"), seeded(charges: [charge_row(5)]))
cases << run("payment_intent.succeeded with a blank purchase reference skips the purchase lookup", intent.("payment_intent.succeeded", metadata: { "purchase" => "" }), seeded)
cases << run("payment_intent.succeeded with a transfer group that is not combined reads the purchase metadata", intent.("payment_intent.succeeded", "transfer_group" => "group_1", metadata: { "purchase" => purchase_id }), seeded(purchases: [purchase_row(77)]))

# capital.*
capital = ->(object = {}, **extra) { event("capital.financing_transaction.created", { "object" => "capital.financing_transaction", "type" => "payment", "account" => "acct_1", "id" => "cptxn_1", "details" => { "currency" => "usd", "total_amount" => 100, "reason" => "collection" } }.merge(object), **extra) }
cases << run("capital event of another type is ignored", event("capital.financing_offer.paid_out", { "object" => "capital.financing_offer" }))
cases << run("capital financing transaction that is not a payment is ignored", capital.({ "type" => "advance" }))
cases << run("capital financing transaction of an unknown account is ignored", capital.call, seeded)
cases << run("capital financing transaction in another currency is ignored", capital.({ "details" => { "currency" => "eur", "total_amount" => 100 } }), seeded(merchant_accounts: [account_row(1, json_data: JSON.generate(meta: { stripe_connect: "false" }))]))
cases << run("capital financing transaction of a Connect account is ignored", capital.call, seeded(merchant_accounts: [account_row(1)]))
cases << run("capital financing transaction of a Gumroad-managed account is ignored", capital.call, seeded(merchant_accounts: [account_row(1, user_id: nil, json_data: JSON.generate(meta: { stripe_connect: "false" }))]))
cases << run("capital financing transaction finds the lowest id among accounts sharing a Stripe id", capital.call, seeded(merchant_accounts: [account_row(2, merchant_id: "acct_1", currency: "eur"), account_row(1, merchant_id: "acct_1")]))
cases << run("capital event of a connected account is not routed", capital.call.merge(connected), seeded(merchant_accounts: [account_row(1, json_data: JSON.generate(meta: { stripe_connect: "false" }))]))

# radar.*
cases << run("radar event of an unsupported type raises", event("radar.early_fraud_warning.deleted", { "object" => "radar.early_fraud_warning" }))

# connected accounts: events no branch of handle_event_for_connected_account routes
cases << run("checkout.session.completed of a connected account is not routed", event("checkout.session.completed", { "object" => "checkout.session", "metadata" => { "seller_plan_offer_id" => "1" } }, **connected), seeded(seller_plan_offers: [offer_row]))
cases << run("customer.subscription.updated of a connected account is not routed", event("customer.subscription.updated", { "object" => "subscription", "id" => "sub_1", "status" => "active", "metadata" => { "seller_plan_offer_id" => "1" } }, **connected), seeded(seller_plan_offers: [offer_row]))
cases << run("payout.created of a connected account is ignored", event("payout.created", { "object" => "payout", "id" => "po_1" }, **connected))
cases << run("payout.updated of a connected account is ignored", event("payout.updated", { "object" => "payout", "id" => "po_1" }, **connected))

# SellerPlan::StripeEventHandler
session = ->(metadata = { "seller_plan_offer_id" => "1" }, **extra) { event("checkout.session.completed", { "object" => "checkout.session", "customer" => "cus_1", "subscription" => "sub_1", "metadata" => metadata }.merge(extra)) }
cases << run("checkout.session.completed activates the offer", session.call, seeded(seller_plan_offers: [offer_row]))
cases << run("checkout.session.completed clears an earlier cancellation", session.call, seeded(seller_plan_offers: [offer_row(status: "canceled", canceled_at: SEEDED_AT, stripe_subscription_id: "sub_1")]))
cases << run("checkout.session.completed without metadata is ignored", session.(nil), seeded(seller_plan_offers: [offer_row]))
cases << run("checkout.session.completed without an offer id is ignored", session.({ "other" => "1" }), seeded(seller_plan_offers: [offer_row]))
cases << run("checkout.session.completed with a blank offer id is ignored", session.({ "seller_plan_offer_id" => "" }), seeded(seller_plan_offers: [offer_row]))
cases << run("checkout.session.completed of an unknown offer is ignored", session.({ "seller_plan_offer_id" => "9" }), seeded(seller_plan_offers: [offer_row]))
cases << run("checkout.session.completed of an offer id with trailing text finds the numeric prefix", session.({ "seller_plan_offer_id" => "12abc" }), seeded(seller_plan_offers: [offer_row(12, user_id: 2)], users: [user_row(1), user_row(2)]))
cases << run("checkout.session.completed of a non-numeric offer id reads offer id NULL", session.({ "seller_plan_offer_id" => "abc" }), seeded(seller_plan_offers: [offer_row]))
cases << run("checkout.session.completed of a decimal offer id reads its integer part", session.({ "seller_plan_offer_id" => "1.9" }), seeded(seller_plan_offers: [offer_row]))
cases << run("checkout.session.completed of a numeric offer id reads that offer", session.({ "seller_plan_offer_id" => 1 }), seeded(seller_plan_offers: [offer_row]))
cases << run("checkout.session.completed of an offer id with leading space reads that offer", session.({ "seller_plan_offer_id" => " 1" }), seeded(seller_plan_offers: [offer_row]))
cases << run("checkout.session.completed of an offer already active on another subscription is not applied", session.call, seeded(seller_plan_offers: [offer_row(status: "active", stripe_subscription_id: "sub_other")]))
cases << run("checkout.session.completed of an offer already active on the same subscription is applied again", session.call, seeded(seller_plan_offers: [offer_row(status: "active", stripe_subscription_id: "sub_1", activated_at: SEEDED_AT)]))
cases << run("checkout.session.completed of an offer whose subscription id is already taken fails", session.call, seeded(seller_plan_offers: [offer_row, offer_row(2, user_id: 2, stripe_subscription_id: "sub_1")], users: [user_row(1), user_row(2)]))
cases << run("checkout.session.completed of an offer whose seller is gone fails validation", session.call, seeded(seller_plan_offers: [offer_row], users: []))
cases << run("checkout.session.completed of an offer with an invalid arm fails validation", session.call, seeded(seller_plan_offers: [offer_row(arm: "twenty")]))

sub = ->(status, id: "sub_1", metadata: { "seller_plan_offer_id" => "1" }, type: "customer.subscription.updated") { event(type, { "object" => "subscription", "id" => id, "status" => status, "metadata" => metadata }) }
cases << run("subscription active adopts the id and activates a checkout_started offer", sub.("active"), seeded(seller_plan_offers: [offer_row]))
cases << run("subscription trialing keeps an earlier activation time", sub.("trialing"), seeded(seller_plan_offers: [offer_row(stripe_subscription_id: "sub_1", status: "past_due", activated_at: SEEDED_AT, canceled_at: SEEDED_AT)]))
cases << run("subscription past_due marks the offer past due", sub.("past_due"), seeded(seller_plan_offers: [offer_row(stripe_subscription_id: "sub_1", status: "active")]))
cases << run("subscription unpaid marks the offer past due", sub.("unpaid"), seeded(seller_plan_offers: [offer_row(stripe_subscription_id: "sub_1", status: "active")]))
cases << run("subscription canceled cancels the offer", sub.("canceled", type: "customer.subscription.deleted"), seeded(seller_plan_offers: [offer_row(stripe_subscription_id: "sub_1", status: "active")]))
cases << run("subscription incomplete_expired cancels the offer", sub.("incomplete_expired"), seeded(seller_plan_offers: [offer_row(stripe_subscription_id: "sub_1")]))
cases << run("subscription incomplete only adopts the id", sub.("incomplete", type: "customer.subscription.created"), seeded(seller_plan_offers: [offer_row]))
cases << run("subscription with an unknown status and a known id changes nothing", sub.("paused"), seeded(seller_plan_offers: [offer_row(stripe_subscription_id: "sub_1")]))
cases << run("terminal subscription event never claims a blank offer", sub.("canceled"), seeded(seller_plan_offers: [offer_row]))
cases << run("incomplete_expired subscription never claims a blank offer", sub.("incomplete_expired"), seeded(seller_plan_offers: [offer_row]))
cases << run("subscription of another id than the offer's is ignored", sub.("active", id: "sub_2"), seeded(seller_plan_offers: [offer_row(stripe_subscription_id: "sub_1")]))
cases << run("subscription without an id does not adopt one", sub.("active", id: nil), seeded(seller_plan_offers: [offer_row]))
cases << run("subscription without metadata is ignored", sub.("active", metadata: nil), seeded(seller_plan_offers: [offer_row]))
cases << run("subscription with an unknown offer is ignored", sub.("active", metadata: { "seller_plan_offer_id" => "9" }), seeded(seller_plan_offers: [offer_row]))
cases << run("subscription adopting an id another offer holds fails", sub.("active"), seeded(seller_plan_offers: [offer_row, offer_row(2, user_id: 2, stripe_subscription_id: "sub_1")], users: [user_row(1), user_row(2)]))

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
