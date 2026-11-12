# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/fight-dispute-job.golden.json: FightDisputeJob past its guards, run by the real app
# against a scratch database as a Sidekiq job (support/sidekiq_executor.rb), with Stripe answered by the local capture server
# (the charge read, then the evidence submission with its idempotency key, in that order). A dispute whose submission Node does
# not make (a Connect charge, a charge of several purchases, a service charge, a processor other than Stripe, evidence with a file
# to upload) is recorded up to the call a marker exception stands in for. Run it like lift-platform-stripe-pause.rb:
#
#   RAILS_ENV=test DATABASE_NAME=gumroad_test_22 TEST_DATABASE_NAME=gumroad_test_22 DISABLE_TEST_REDIS_ISOLATION=1 \
#     USE_DB_WORKER_REPLICAS=true REDIS_HOST=redis:6379/36 SIDEKIQ_REDIS_HOST=redis:6379/37 \
#     RPUSH_REDIS_HOST=redis:6379/38 RACK_ATTACK_REDIS_HOST=redis:6379/44 \
#     bundle exec ruby bin/rails runner nextjs/scripts/golden/fight-dispute-job.rb
require_relative "support/rails_cases"
require_relative "../../src/server/stripe/__fixtures__/capture_server"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/fight-dispute-job.golden.json")
# A Wednesday after the window of every seeded stamp has closed.
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
CONTACTED_AT = "2026-10-28 09:00:00"
TABLES = %w[users purchases disputes dispute_evidences merchant_accounts charges charge_purchases active_storage_attachments
            active_storage_blobs versions service_charges subscriptions].freeze

# active_storage_attachments and _blobs reference each other, so a case cannot truncate either with the constraint on.
ActiveRecord::Base.connection.execute("SET FOREIGN_KEY_CHECKS = 0")

SERVER = CaptureServer.new
Stripe.api_base = "http://127.0.0.1:#{SERVER.port}"
Stripe.api_key = "sk_test_golden"
Stripe.max_network_retries = 0
Rails.logger = ActiveSupport::Logger.new(nil)

# Stands in for the first call or write of a submission Node hands back.
class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

StripeChargeProcessor.prepend(Module.new do
  def fight_chargeback(_charge_id, evidence, merchant_account: nil)
    raise HandBackMarker if merchant_migrated?(merchant_account) || evidence.for_subscription_purchase?

    super
  end

  def create_dispute_evidence_stripe_file(blob, **)
    raise HandBackMarker if blob.attached?

    super
  end
end)
ChargeProcessor.singleton_class.prepend(Module.new do
  def fight_chargeback(charge_processor_id, *, **)
    raise HandBackMarker unless charge_processor_id == StripeChargeProcessor.charge_processor_id

    super
  end
end)
Charge.prepend(Module.new do
  def charge_processor_transaction_id = raise(HandBackMarker)
end)
ServiceCharge.prepend(Module.new do
  def charge_processor_transaction_id = raise(HandBackMarker)
end)

def user_row(id, **overrides)
  { id:, email: "seller#{id}@example.com", username: "seller#{id}", external_id: (1000 + id).to_s, recommendation_type: "own_products",
    user_risk_state: "compliant", flags: 0, json_data: nil, confirmed_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def purchase_row(id, **overrides)
  { id:, link_id: 1, seller_id: 1, purchase_state: "successful", price_cents: 100, stripe_transaction_id: "ch_1", charge_processor_id: "stripe",
    created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def dispute_row(id, **overrides)
  { id:, purchase_id: 1, state: "formalized", seller_id: 1, charge_processor_id: "stripe", charge_processor_dispute_id: "dp_1",
    event_created_at: "2026-10-20 00:00:00", created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def evidence_row(id, dispute_id, **overrides)
  { id:, dispute_id:, created_at: SEEDED_AT, updated_at: SEEDED_AT, seller_contacted_at: CONTACTED_AT, resolution: "unknown",
    purchased_at: "2026-10-20 08:15:30", customer_email: "buyer@example.com", customer_name: "Buyer", customer_purchase_ip: "203.0.113.7",
    billing_address: "1 Main St", product_description: "An ebook", reason_for_winning: "The buyer downloaded it",
    access_activity_log: "Viewed on 2026-10-21" }.merge(overrides)
end

def account_row(id, **overrides)
  { id:, user_id: nil, charge_processor_id: "stripe", charge_processor_merchant_id: "acct_#{id}", json_data: nil,
    charge_processor_alive_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def charge_row(id, **overrides)
  { id:, seller_id: 1, processor: "stripe", processor_transaction_id: "ch_c#{id}", created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def blob_row(id, **overrides)
  { id:, key: "key#{id}", filename: "receipt.pdf", content_type: "application/pdf", metadata: "{}", service_name: "test", byte_size: 1000,
    checksum: "abc", created_at: SEEDED_AT }.merge(overrides)
end

def attachment_row(id, name, blob_id)
  { id:, name:, record_type: "DisputeEvidence", record_id: 1, blob_id:, created_at: SEEDED_AT }
end

def json(status, body) = [status, { "Content-Type" => "application/json", "Request-Id" => "req_#{status}" }, body.to_json]
def charge_answer(dispute: "dp_1") = json(200, { id: "ch_1", object: "charge", dispute: })
def dispute_answer = json(200, { id: "dp_1", object: "dispute" })
def stripe_error(status, message, code: nil)
  json(status, { error: { type: status == 400 ? "invalid_request_error" : "api_error", code:, message:, param: nil } })
end

def run(name, seed: {}, stripe: [], args: [1])
  SERVER.requests.clear
  SERVER.responses = stripe.dup
  hands_back = false
  result = capture(name, now: NOW, tables: TABLES, seed:, sidekiq: true, job: "FightDisputeJob", args:) do
    FightDisputeJob.new.perform(*args)
  rescue HandBackMarker
    hands_back = true
  end
  result.delete("seed")
  result.merge("hands_back" => hands_back,
               "stripe" => { "responses" => stripe, "requests" => SERVER.requests.map { _1.slice("method", "path", "query", "headers", "body") } })
end

base = { users: [user_row(1)], disputes: [dispute_row(1)] }
cases = []

cases << run("a purchase with no transaction id is rejected", seed: base.merge(purchases: [purchase_row(1, stripe_transaction_id: nil)], dispute_evidences: [evidence_row(1, 1)]))
cases << run("a purchase with a blank transaction id is rejected", seed: base.merge(purchases: [purchase_row(1, stripe_transaction_id: "")], dispute_evidences: [evidence_row(1, 1)]))
cases << run("a submission", seed: base.merge(purchases: [purchase_row(1)], dispute_evidences: [evidence_row(1, 1)]), stripe: [charge_answer, dispute_answer])
cases << run("a submission on Gumroad's own account", seed: base.merge(purchases: [purchase_row(1, merchant_account_id: 1)], merchant_accounts: [account_row(1)], dispute_evidences: [evidence_row(1, 1)]),
                                                     stripe: [charge_answer, dispute_answer])
cases << run("a submission with every text field and a shipment", seed: base.merge(purchases: [purchase_row(1)], dispute_evidences: [evidence_row(1, 1,
  shipping_address: "2 Side St", shipped_at: "2026-10-22 23:59:59", shipping_carrier: "UPS", shipping_tracking_number: "1Z999", uncategorized_text: "Extra context",
  cancellation_policy_disclosure: "No cancellations", refund_policy_disclosure: "30 days", cancellation_rebuttal: "Not cancelled", refund_refusal_explanation: "Outside the window")]),
                                                                          stripe: [charge_answer, dispute_answer])
cases << run("a submission with the statement and context blank", seed: base.merge(purchases: [purchase_row(1)], dispute_evidences: [evidence_row(1, 1, reason_for_winning: nil, uncategorized_text: "")]),
                                                                  stripe: [charge_answer, dispute_answer])
cases << run("a purchase time with no date", seed: base.merge(purchases: [purchase_row(1)], dispute_evidences: [evidence_row(1, 1, purchased_at: nil)]), stripe: [charge_answer])
cases << run("the dispute is already closed", seed: base.merge(purchases: [purchase_row(1)], dispute_evidences: [evidence_row(1, 1)]),
                                              stripe: [charge_answer, stripe_error(400, "This dispute is already closed and cannot be updated.")])
cases << run("the evidence was already submitted", seed: base.merge(purchases: [purchase_row(1)], dispute_evidences: [evidence_row(1, 1)]),
                                                   stripe: [charge_answer, stripe_error(400, "You have reached the maximum number of evidence submissions allowed for this dispute. " + ("x" * 300))])
cases << run("another invalid request is retried", seed: base.merge(purchases: [purchase_row(1)], dispute_evidences: [evidence_row(1, 1)]),
                                                    stripe: [charge_answer, stripe_error(400, "Evidence is too large.")])
cases << run("the charge cannot be read", seed: base.merge(purchases: [purchase_row(1)], dispute_evidences: [evidence_row(1, 1)]),
                                          stripe: [stripe_error(400, "No such charge: 'ch_1'", code: "resource_missing")])
cases << run("Stripe is unavailable", seed: base.merge(purchases: [purchase_row(1)], dispute_evidences: [evidence_row(1, 1)]),
                                      stripe: [charge_answer, stripe_error(500, "Something went wrong")])
cases << run("the charge has no dispute", seed: base.merge(purchases: [purchase_row(1)], dispute_evidences: [evidence_row(1, 1)]),
                                          stripe: [charge_answer(dispute: nil), stripe_error(404, "No such dispute: ''")])
cases << run("a Connect charge", seed: base.merge(purchases: [purchase_row(1, merchant_account_id: 1)], dispute_evidences: [evidence_row(1, 1)],
                                                  merchant_accounts: [account_row(1, user_id: 1, json_data: '{"meta":{"stripe_connect":"true"}}')]))
cases << run("a PayPal purchase", seed: base.merge(purchases: [purchase_row(1, charge_processor_id: "paypal", stripe_transaction_id: "PAYID-1")], dispute_evidences: [evidence_row(1, 1)]))
cases << run("a charge of several purchases", seed: { users: [user_row(1)], purchases: [purchase_row(1), purchase_row(2)], charges: [charge_row(1)], disputes: [dispute_row(1, purchase_id: nil, charge_id: 1)],
                                                      charge_purchases: [{ charge_id: 1, purchase_id: 1 }, { charge_id: 1, purchase_id: 2 }], dispute_evidences: [evidence_row(1, 1)] })
cases << run("a service charge", seed: { users: [user_row(1)], disputes: [dispute_row(1, purchase_id: nil, service_charge_id: 1)], dispute_evidences: [evidence_row(1, 1)],
                                         service_charges: [{ id: 1, created_at: SEEDED_AT, updated_at: SEEDED_AT }] })
cases << run("a receipt to upload", seed: base.merge(purchases: [purchase_row(1)], dispute_evidences: [evidence_row(1, 1)],
                                                     active_storage_blobs: [blob_row(1)], active_storage_attachments: [attachment_row(1, "receipt_image", 1)]),
                                                     stripe: [charge_answer])
cases << run("a customer communication file to upload", seed: base.merge(purchases: [purchase_row(1)], dispute_evidences: [evidence_row(1, 1)],
                                                                         active_storage_blobs: [blob_row(1)], active_storage_attachments: [attachment_row(1, "customer_communication_file", 1)]),
                                                                         stripe: [charge_answer])
cases << run("a refund policy image to upload", seed: base.merge(purchases: [purchase_row(1)], dispute_evidences: [evidence_row(1, 1)],
                                                                 active_storage_blobs: [blob_row(1)], active_storage_attachments: [attachment_row(1, "refund_policy_image", 1)]),
                                                                 stripe: [charge_answer])
cases << run("a cancellation policy image to upload", seed: base.merge(purchases: [purchase_row(1)], dispute_evidences: [evidence_row(1, 1)],
                                                                       active_storage_blobs: [blob_row(1)], active_storage_attachments: [attachment_row(1, "cancellation_policy_image", 1)]),
                                                                       stripe: [charge_answer])
cases << run("a purchase of a subscription", seed: base.merge(purchases: [purchase_row(1, subscription_id: 1)], dispute_evidences: [evidence_row(1, 1)],
                                                       subscriptions: [{ id: 1, link_id: 1, user_id: 1, created_at: SEEDED_AT, updated_at: SEEDED_AT }]), stripe: [charge_answer])
cases << run("the purchase is missing", seed: base.merge(dispute_evidences: [evidence_row(1, 1)]))
cases << run("the dispute has no disputable", seed: { users: [user_row(1)], disputes: [dispute_row(1, purchase_id: nil)], dispute_evidences: [evidence_row(1, 1)] })
cases << run("the evidence is resolved before the window check", seed: base.merge(purchases: [purchase_row(1)], dispute_evidences: [evidence_row(1, 1, resolved_at: "2026-10-30 00:00:00", resolution: "submitted")]))

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
