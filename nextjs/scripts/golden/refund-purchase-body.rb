# frozen_string_literal: true

# Writes nextjs/src/server/models/__fixtures__/refund-purchase-body.golden.json: Purchase#refund_purchase! (app/modules/purchase/refundable.rb)
# as the real class runs it, from the transaction's `reload.lock!` down to the Credit.create_for_vat_exclusive_refund! line, against a
# scratch database, with every statement the mysql2 driver sent and every Sidekiq push recorded between the "refund" markers. The method
# is stopped where it would notify the seller's webhook (everything after it is side effects nothing here ports): the raise rolls the
# transaction back, so each case ends with that ROLLBACK. Stripe is never reached: refund_purchase! takes the refund the processor
# already made as an argument, and here that is a plain object.
#
#   RAILS_ENV=test DATABASE_NAME=gumroad_test_28 TEST_DATABASE_NAME=gumroad_test_28 DISABLE_TEST_REDIS_ISOLATION=1 \
#     REDIS_HOST=redis:6379/45 SIDEKIQ_REDIS_HOST=redis:6379/46 RPUSH_REDIS_HOST=redis:6379/47 \
#     RACK_ATTACK_REDIS_HOST=redis:6379/48 DISABLE_SPRING=1 bundle exec rails runner nextjs/scripts/golden/refund-purchase-body.rb
require_relative "support/paid_sale"

OUT = Rails.root.join("nextjs/src/server/models/__fixtures__/refund-purchase-body.golden.json")
REFUNDING_USER_ID = 77
AFFILIATE_CREDIT_CENTS = 14

class StopGolden < StandardError; end

Purchase.prepend(Module.new do
  private

  def send_refunded_notification_webhook = raise(StopGolden)
end)

class FlowOfFunds
  def to_h_for_golden
    amount = ->(a) { a && { "currency" => a.currency, "cents" => a.cents } }
    { "issued" => amount.(issued_amount), "settled" => amount.(settled_amount), "gumroad" => amount.(gumroad_amount),
      "gross" => amount.(merchant_account_gross_amount), "net" => amount.(merchant_account_net_amount) }
  end
end

def seed_refund(purchase, amount_cents:, fee_cents:, total_transaction_cents: amount_cents, status: "succeeded")
  Refund.new(purchase:, link_id: purchase.link_id, seller_id: purchase.seller_id, processor_refund_id: "re_golden#{Refund.count + 1}", status:,
             total_transaction_cents:, amount_cents:, fee_cents:, creator_tax_cents: 0, gumroad_tax_cents: 0,
             created_at: SEEDED_AT, updated_at: SEEDED_AT).tap { _1.save!(validate: false) }
end

# A sold purchase, booked the way checkout books it (the real increment_sellers_balance!), with `prior` refunds on it ([amount, fee] pairs;
# the sale then reads as partially refunded). `affiliate:` credits a direct affiliate of the seller.
def refundable_sale(prior: [], affiliate: false, account: :gumroad, **options)
  sale(account:, **options) do |purchase, seller, merchant_account|
    if affiliate
      direct = create(:direct_affiliate, seller:, affiliate_user: create(:user, created_at: SEEDED_AT, updated_at: SEEDED_AT), created_at: SEEDED_AT, updated_at: SEEDED_AT)
      purchase.update_columns(affiliate_id: direct.id, affiliate_credit_cents: AFFILIATE_CREDIT_CENTS)
    end
    purchase.flow_of_funds = flow
    purchase.increment_sellers_balance! unless account == :seller_connect
    purchase = Purchase.find(purchase.id)
    prior.each { |amount_cents, fee_cents| seed_refund(purchase, amount_cents:, fee_cents:) }
    purchase.update_columns(stripe_partially_refunded: true) if prior.any?
    yield purchase, seller, merchant_account if block_given?
  end
end

StripeRefund = Struct.new(:id, :status)

def run_case(name, seed:, issued: 500, stripe_refund: nil, is_for_fraud: false, note: nil, gumroad_funded: false, balance_reconciliation_needed: false)
  warn "case: #{name}"
  $random_seq = 0
  refund_flow = flow(issued: ["usd", issued], settled: ["usd", issued], gumroad: ["usd", issued])
  returned = nil
  errors = nil
  result = capture(name, now: NOW, tables: $dirty, seed:, flow_of_funds: refund_flow.to_h_for_golden) do
    purchase = Purchase.find(1)
    purchase.link.user
    purchase.seller
    marker("refund", "start")
    begin
      returned = purchase.refund_purchase!(refund_flow, REFUNDING_USER_ID, stripe_refund, is_for_fraud, note:, gumroad_funded:, balance_reconciliation_needed:)
    rescue StopGolden
      returned = :stopped
    ensure
      marker("refund", "end")
      errors = purchase.errors.full_messages
    end
  end
  c = ActiveRecord::Base.connection
  $dirty = ALL_TABLES.reject { c.select_value("SELECT 1 FROM #{c.quote_table_name(_1)} LIMIT 1").nil? }
  result.merge("returned" => returned.to_s, "errors" => errors, "refunding_user_id" => REFUNDING_USER_ID, "is_for_fraud" => is_for_fraud,
               "note" => note, "gumroad_funded" => gumroad_funded, "balance_reconciliation_needed" => balance_reconciliation_needed,
               "stripe_refund" => stripe_refund && { "id" => stripe_refund.id, "status" => stripe_refund.status })
end

warn "seeding"
cases = []
cases << run_case("a full refund", seed: refundable_sale)
cases << run_case("a partial refund", seed: refundable_sale, issued: 200)
cases << run_case("the rest of a partially refunded sale", seed: refundable_sale(prior: [[200, 58]]), issued: 300)
cases << run_case("another partial refund of a partially refunded sale", seed: refundable_sale(prior: [[200, 58]]), issued: 100)
cases << run_case("a refund for fraud", seed: refundable_sale, is_for_fraud: true)
cases << run_case("a refund the processor made", seed: refundable_sale, stripe_refund: StripeRefund.new("re_golden_processor", "pending"))
cases << run_case("a refund with a note", seed: refundable_sale, note: "Buyer was charged twice")
cases << run_case("a refund Gumroad funds moves no seller balance", seed: refundable_sale, gumroad_funded: true, note: "Goodwill")
cases << run_case("a refund that needs a balance reconciliation moves no seller balance", seed: refundable_sale, balance_reconciliation_needed: true)
cases << run_case("a refund of more than what is left builds no refund", seed: refundable_sale(prior: [[200, 58]]), issued: 400)
cases << run_case("a refund of nothing builds no refund", seed: refundable_sale, issued: 0)
cases << run_case("a refund of a sale an affiliate was credited for", seed: refundable_sale(affiliate: true), issued: 200)
cases << run_case("a refund of a sale on the seller's own Connect account", seed: refundable_sale(account: :seller_connect))
cases << run_case("a refund of a sale on an account Gumroad manages for the seller", seed: refundable_sale(account: :seller_managed))
cases << run_case("a refund of a sale that charged a Gumroad VAT", seed: refundable_sale(account: :seller_connect, gumroad_tax_cents: 100, total_transaction_cents: 600), issued: 600)

File.write(OUT, JSON.pretty_generate({ "now" => NOW.iso8601(3), "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
