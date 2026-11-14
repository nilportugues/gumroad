# frozen_string_literal: true

# Writes nextjs/src/server/models/__fixtures__/refund-presentment.golden.json: Purchase::PresentmentRefund (app/services/purchase/presentment_refund.rb)
# and Purchase#derive_presentment_refund_from_flow_of_funds (app/modules/purchase/refundable.rb) as the real classes run them against a scratch
# database, with every statement the mysql2 driver sent between the "presentment" markers. Each case makes one call; what it answered
# (the canonical gross refund and the snapshot's json_data, or nil), the errors it added to the purchase and what it reported to
# ErrorNotifier are recorded beside the statements. Nothing here reaches Stripe.
#
#   RAILS_ENV=test DATABASE_NAME=gumroad_test_28 TEST_DATABASE_NAME=gumroad_test_28 DISABLE_TEST_REDIS_ISOLATION=1 \
#     REDIS_HOST=redis:6379/45 SIDEKIQ_REDIS_HOST=redis:6379/46 RPUSH_REDIS_HOST=redis:6379/47 \
#     RACK_ATTACK_REDIS_HOST=redis:6379/48 DISABLE_SPRING=1 bundle exec rails runner nextjs/scripts/golden/refund-presentment.rb
require_relative "support/paid_sale"

OUT = Pathname(ENV.fetch("OUT", Rails.root.join("nextjs/src/server/models/__fixtures__/refund-presentment.golden.json").to_s))
ONLY = ENV["ONLY"] && Regexp.new(ENV["ONLY"]) # regenerate only the cases whose name matches, into OUT

$notified = []
ErrorNotifier.singleton_class.prepend(Module.new do
  def notify(error, **options) = $notified << { "message" => error.is_a?(String) ? error : error.message, "context" => options[:context]&.as_json }
end)

# A $10 sale with $1 of Gumroad VAT, charged as 13.50 CAD (12.00 + 1.50 VAT).
PRICE_CENTS = 1000
VAT_CENTS = 100
PRESENTMENT = { presentment_price_cents: 1200, presentment_gumroad_tax_cents: 150, presentment_total_cents: 1350, presentment_gumroad_amount_cents: 135 }.freeze

def presentment_sale(presentment: PRESENTMENT, refunds: [])
  sale(price_cents: PRICE_CENTS, fee_cents: 145, gumroad_tax_cents: VAT_CENTS, total_transaction_cents: PRICE_CENTS + VAT_CENTS) do |purchase, _seller, _account|
    PurchasePresentment.new(purchase:, processor: "stripe", presentment_currency: "cad", presentment_tip_cents: 0, presentment_seller_tax_cents: 0,
                            presentment_shipping_cents: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT, **presentment).save!(validate: false) if presentment
    refunds.each_with_index do |refund, index|
      Refund.new(purchase:, link_id: purchase.link_id, seller_id: purchase.seller_id, processor_refund_id: "re_golden_#{index}", status: refund.fetch(:status, "succeeded"),
                 total_transaction_cents: refund[:amount_cents] + refund.fetch(:gumroad_tax_cents, 0), amount_cents: refund[:amount_cents], fee_cents: 0, creator_tax_cents: 0,
                 gumroad_tax_cents: refund.fetch(:gumroad_tax_cents, 0), created_at: SEEDED_AT, updated_at: SEEDED_AT).tap do |row|
        row.presentment_amount_cents = refund[:presentment_amount_cents] if refund[:presentment_amount_cents]
        row.presentment_price_cents = refund[:presentment_price_cents] if refund[:presentment_price_cents]
        row.presentment_gumroad_tax_cents = refund[:presentment_gumroad_tax_cents] if refund[:presentment_gumroad_tax_cents]
        row.presentment_currency = "cad" if refund[:presentment_amount_cents]
        row.balance_reversed_on_failure = true if refund[:status] == "failed"
        row.save!(validate: false)
      end
    end
  end
end

def snapshot(result)
  result && result.json_data.as_json
end

def derived_answer(derived)
  derived && { "canonical_gross_refund_cents" => derived.canonical_gross_refund_cents, "presentment_refund" => snapshot(derived.presentment_refund) }
end

CALLS = {
  derive: ->(purchase, currency:, cents:) { purchase.derive_presentment_refund_from_flow_of_funds(flow(issued: [currency, -cents], settled: [currency, -cents], gumroad: [currency, -cents])).then { derived_answer(_1) } },
  from_presentment_amount: ->(purchase, cents:, **) { derived_answer(Purchase::PresentmentRefund.from_presentment_amount(purchase:, presentment_amount_cents: cents)) },
  result: ->(purchase, canonical:, **) { snapshot(Purchase::PresentmentRefund.new(purchase:, canonical_gross_refund_cents: canonical).result) },
  tax_only_result: ->(purchase, canonical:, **) { snapshot(Purchase::PresentmentRefund.new(purchase:, canonical_gross_refund_cents: canonical).tax_only_result) },
}.freeze

def run_case(name, call, seed:, **arguments)
  return if ONLY && name !~ ONLY

  warn "case: #{name}"
  $random_seq = 0
  $notified = []
  answer = nil
  errors = nil
  result = capture(name, now: NOW, tables: $dirty, seed:) do
    purchase = Purchase.find(1)
    marker("presentment", "start")
    begin
      answer = CALLS.fetch(call).call(purchase, **arguments)
    ensure
      marker("presentment", "end")
      errors = purchase.errors.full_messages
    end
  end
  c = ActiveRecord::Base.connection
  $dirty = ALL_TABLES.reject { c.select_value("SELECT 1 FROM #{c.quote_table_name(_1)} LIMIT 1").nil? }
  result.merge("call" => call.to_s, "arguments" => arguments.as_json, "answer" => answer, "errors" => errors, "notified" => $notified)
end

warn "seeding"
cases = []
PRIOR = { amount_cents: 400, presentment_amount_cents: 540, presentment_price_cents: 480 }.freeze
UNSNAPSHOTTED = { amount_cents: 400 }.freeze

# derive_presentment_refund_from_flow_of_funds
cases << run_case("derive: part of the sale in the buyer's currency", :derive, seed: presentment_sale, currency: "cad", cents: 300)
cases << run_case("derive: all of the sale in the buyer's currency", :derive, seed: presentment_sale, currency: "cad", cents: 1350)
cases << run_case("derive: the rest of a partly refunded sale", :derive, seed: presentment_sale(refunds: [PRIOR]), currency: "cad", cents: 810)
cases << run_case("derive: part of what is left of a partly refunded sale", :derive, seed: presentment_sale(refunds: [PRIOR]), currency: "cad", cents: 400)
cases << run_case("derive: a failed refund consumes no balance", :derive, seed: presentment_sale(refunds: [PRIOR.merge(status: "failed")]), currency: "cad", cents: 1350)
cases << run_case("derive: more than is left", :derive, seed: presentment_sale(refunds: [PRIOR]), currency: "cad", cents: 811)
cases << run_case("derive: a flow of funds in dollars", :derive, seed: presentment_sale, currency: "usd", cents: 300)
cases << run_case("derive: a prior refund with no buyer-currency snapshot", :derive, seed: presentment_sale(refunds: [UNSNAPSHOTTED]), currency: "cad", cents: 300)
cases << run_case("derive: nothing refunded", :derive, seed: presentment_sale, currency: "cad", cents: 0)
cases << run_case("derive: a sale with no buyer-currency charge", :derive, seed: presentment_sale(presentment: nil), currency: "cad", cents: 300)
cases << run_case("derive: an amount that rounds to no dollars", :derive, seed: presentment_sale, currency: "cad", cents: 1)

# PresentmentRefund.from_presentment_amount
cases << run_case("from_presentment_amount: a share that rounds up", :from_presentment_amount, seed: presentment_sale, cents: 700)
cases << run_case("from_presentment_amount: a share that rounds down", :from_presentment_amount, seed: presentment_sale(refunds: [PRIOR]), cents: 500)

# PresentmentRefund#result
cases << run_case("result: part of the sale", :result, seed: presentment_sale, canonical: 400)
cases << run_case("result: all of the sale", :result, seed: presentment_sale, canonical: 1100)
cases << run_case("result: more than the sale", :result, seed: presentment_sale, canonical: 1500)
cases << run_case("result: part of a partly refunded sale", :result, seed: presentment_sale(refunds: [PRIOR]), canonical: 300)
cases << run_case("result: the rest of a partly refunded sale", :result, seed: presentment_sale(refunds: [PRIOR]), canonical: 700)
cases << run_case("result: a prior refund with no buyer-currency snapshot", :result, seed: presentment_sale(refunds: [UNSNAPSHOTTED]), canonical: 300)
cases << run_case("result: nothing to refund", :result, seed: presentment_sale, canonical: 0)
cases << run_case("result: a sale with no buyer-currency charge", :result, seed: presentment_sale(presentment: nil), canonical: 300)

# PresentmentRefund#tax_only_result
cases << run_case("tax_only_result: the VAT of a sale", :tax_only_result, seed: presentment_sale, canonical: 100)
cases << run_case("tax_only_result: a VAT that was refunded", :tax_only_result, seed: presentment_sale(refunds: [{ amount_cents: 0, gumroad_tax_cents: 100, presentment_amount_cents: 150, presentment_gumroad_tax_cents: 150 }]), canonical: 100)
cases << run_case("tax_only_result: a prior refund with no buyer-currency snapshot", :tax_only_result, seed: presentment_sale(refunds: [UNSNAPSHOTTED]), canonical: 100)
cases << run_case("tax_only_result: nothing to refund", :tax_only_result, seed: presentment_sale, canonical: 0)

File.write(OUT, JSON.pretty_generate({ "now" => NOW.iso8601(3), "cases" => cases.compact }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.compact.size} cases)"
