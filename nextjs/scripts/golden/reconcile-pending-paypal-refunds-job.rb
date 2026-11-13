# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/reconcile-pending-paypal-refunds-job.golden.json: ReconcilePendingPaypalRefundsJob run by
# the real app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). Outbound HTTP is answered `200 {}` by WebMock
# (capture_http!) and recorded under "http", so a sweep that finds a refund shows the PayPal call Node would have to make.
# Run it like send-workflow-emails-to-past-canceled-members-job.rb.
require_relative "support/rails_cases"
include RailsCases
capture_elasticsearch!
capture_http!

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/reconcile-pending-paypal-refunds-job.golden.json")
NOW = Time.utc(2025, 11, 1, 12, 30, 45, 123_000)
SEEDED_AT = "2025-01-01 00:00:00"
OLD = "2025-10-20 00:00:00"
TABLES = %w[users links purchases refunds merchant_accounts].freeze

Stripe.api_base = "http://127.0.0.1:9"
Stripe.max_network_retries = 0
ActiveJob::Base.queue_adapter = :sidekiq
ActiveJob::Base.logger = Logger.new(nil)
Rails.logger = ActiveSupport::Logger.new(nil)

def user_row(id, **overrides)
  { id:, email: "user#{id}@example.com", username: "user#{id}", external_id: (1000 + id).to_s, recommendation_type: "own_products",
    user_risk_state: "compliant", flags: 0, json_data: nil, confirmed_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def link_row(id = 1, **overrides)
  { id:, name: "Product #{id}", user_id: 1, unique_permalink: "p#{id}", price_currency_type: "usd", flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def purchase_row(id = 1, **overrides)
  { id:, link_id: 1, seller_id: 1, email: "buyer#{id}@example.com", purchase_state: "successful", charge_processor_id: "paypal", price_cents: 500, displayed_price_cents: 500,
    quantity: 1, flags: 0, country: "United States", ip_country: "United States", created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def refund_row(id = 1, purchase: id, json: nil, **overrides)
  { id:, purchase_id: purchase, link_id: 1, seller_id: 1, amount_cents: 500, status: "PENDING", processor_refund_id: "REF#{id}", json_data: json&.to_json,
    created_at: OLD, updated_at: OLD }.merge(overrides)
end

def base_seed(**extra)
  { users: [user_row(1)], links: [link_row], purchases: [purchase_row], refunds: [refund_row] }.merge(extra)
end

JOB = "ReconcilePendingPaypalRefundsJob"
cases = []
run = lambda do |name, **seed|
  result = capture(name, now: NOW, tables: TABLES, seed: base_seed(**seed), sidekiq: true, job: JOB, args: [], case_now: NOW.to_f) { JOB.constantize.new.perform }
  result.delete("rows")
  result.delete("seed")
  cases << result
end

run.call("no refunds", refunds: [], purchases: [])
run.call("a refund that already succeeded", refunds: [refund_row(status: "succeeded")])
run.call("a completed refund", refunds: [refund_row(status: "COMPLETED")])
run.call("a failed refund", refunds: [refund_row(status: "failed")])
run.call("a status in another case than the two PayPal sends", refunds: [refund_row(status: "Pending")])
run.call("a refund without a status", refunds: [refund_row(status: nil)])
run.call("a pending refund without a processor refund id", refunds: [refund_row(processor_refund_id: nil)])
run.call("a pending refund with a blank processor refund id", refunds: [refund_row(processor_refund_id: "")])
run.call("a pending refund of a Stripe purchase", purchases: [purchase_row(charge_processor_id: "stripe")])
run.call("a pending refund of a purchase without a processor", purchases: [purchase_row(charge_processor_id: nil)])
run.call("a pending refund without a purchase", purchases: [])
run.call("a pending refund younger than three days", refunds: [refund_row(created_at: "2025-10-30 00:00:00")])
run.call("a pending refund created in the second three days ago", refunds: [refund_row(created_at: "2025-10-29 12:30:45")])
run.call("a pending refund created a second later than that", refunds: [refund_row(created_at: "2025-10-29 12:30:46")])
run.call("a pending refund marked unreadable because the account was closed", refunds: [refund_row(json: { paypal_refund_unreadable_at: "2025-10-25T00:00:00Z", paypal_refund_unreadable_issue: "closed_user" })])
run.call("a pending refund marked unreadable for another reason", refunds: [refund_row(json: { paypal_refund_unreadable_at: "2025-10-25T00:00:00Z", paypal_refund_unreadable_issue: "locked_user" })])
run.call("a pending refund with an unreadable issue and no time", refunds: [refund_row(json: { paypal_refund_unreadable_issue: "closed_user" })])
run.call("a pending refund with a null unreadable time", refunds: [refund_row(json: { paypal_refund_unreadable_at: nil, paypal_refund_unreadable_issue: "closed_user" })])
run.call("a pending refund with a blank unreadable time", refunds: [refund_row(json: { paypal_refund_unreadable_at: "", paypal_refund_unreadable_issue: "closed_user" })])
run.call("a pending refund with an unreadable time and no issue", refunds: [refund_row(json: { paypal_refund_unreadable_at: "2025-10-25T00:00:00Z" })])
run.call("a pending refund with other json data", refunds: [refund_row(json: { note: "x" })])
run.call("a pending refund to reconcile", refunds: [refund_row])
run.call("a lowercase pending refund to reconcile", refunds: [refund_row(status: "pending")])
run.call("a pending refund with a merchant account of the seller", merchant_accounts: [{ id: 1, user_id: 1, charge_processor_id: "paypal", charge_processor_merchant_id: "M1", charge_processor_alive_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT }])
run.call("two refunds, one of them to reconcile", purchases: [purchase_row, purchase_row(2)], refunds: [refund_row(json: { paypal_refund_unreadable_at: "x", paypal_refund_unreadable_issue: "closed_user" }), refund_row(2)])
run.call("a refund older than a year", refunds: [refund_row(created_at: "2024-01-01 00:00:00")])

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
