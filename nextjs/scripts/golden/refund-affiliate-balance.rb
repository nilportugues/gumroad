# frozen_string_literal: true

# Writes nextjs/src/server/models/__fixtures__/refund-affiliate-balance.golden.json: Purchase#decrement_balance_for_refund_or_chargeback!
# as the real class runs it for a refund of a sale that credits an affiliate (the affiliate's refund BalanceTransaction, the credit's
# refund balance, the AffiliatePartialRefund row of a partial reversal, then the seller's share), against a scratch database, with every
# statement the mysql2 driver sent and every Sidekiq push recorded between the "decrement" markers. Nothing here reaches Stripe.
#
#   RAILS_ENV=test DATABASE_NAME=gumroad_test_28 TEST_DATABASE_NAME=gumroad_test_28 DISABLE_TEST_REDIS_ISOLATION=1 \
#     REDIS_HOST=redis:6379/45 SIDEKIQ_REDIS_HOST=redis:6379/46 RPUSH_REDIS_HOST=redis:6379/47 \
#     RACK_ATTACK_REDIS_HOST=redis:6379/48 DISABLE_SPRING=1 bundle exec rails runner nextjs/scripts/golden/refund-affiliate-balance.rb
require_relative "support/paid_sale"

OUT = Rails.root.join("nextjs/src/server/models/__fixtures__/refund-affiliate-balance.golden.json")
AFFILIATE_CREDIT_CENTS = 14 # 3% of $5, as the purchase's credit is sized at checkout
DIRECT_ON_COLLAB_CENTS = 10

class FlowOfFunds
  def to_h_for_golden
    amount = ->(a) { a && { "currency" => a.currency, "cents" => a.cents } }
    { "issued" => amount.(issued_amount), "settled" => amount.(settled_amount), "gumroad" => amount.(gumroad_amount),
      "gross" => amount.(merchant_account_gross_amount), "net" => amount.(merchant_account_net_amount) }
  end
end

# The refund refund_purchase! inserted: `refunds << refund` has run, the rest of the method has not.
def seed_refund(purchase, amount_cents:, fee_cents:, total_transaction_cents: amount_cents, status: "succeeded")
  Refund.new(purchase:, link_id: purchase.link_id, seller_id: purchase.seller_id, processor_refund_id: "re_golden#{Refund.count + 1}", status:,
             total_transaction_cents:, amount_cents:, fee_cents:, creator_tax_cents: 0, gumroad_tax_cents: 0,
             created_at: SEEDED_AT, updated_at: SEEDED_AT).tap { _1.save!(validate: false) }
end

def affiliate_user = create(:user, created_at: SEEDED_AT, updated_at: SEEDED_AT)

def refund_flow_of(amount_cents) = flow(issued: ["usd", amount_cents], settled: ["usd", amount_cents], gumroad: ["usd", amount_cents])

# A sale credited to an affiliate of the seller, booked the way checkout books it (the real increment_sellers_balance!).
# `refunds:` are [amount_cents, fee_cents] pairs, inserted as refunds 1, 2, ...; with `prior: :partial` or `:full` all but the last are already decremented (the sale then carries a refund balance).
def affiliate_sale(kind: :direct_affiliate, credit_cents: AFFILIATE_CREDIT_CENTS, refunds: [[500, 145]], direct: false, prior: nil, bears_fee: false, sale_options: {}, **affiliate_attributes)
  sale(**sale_options) do |purchase, seller, merchant_account|
    seller.update_columns(flags: seller.flags | (1 << 14)) if bears_fee
    affiliate = create(kind, seller:, affiliate_user:, created_at: SEEDED_AT, updated_at: SEEDED_AT, **affiliate_attributes)
    purchase.update_columns(affiliate_id: affiliate.id, affiliate_credit_cents: credit_cents)
    if direct
      direct_affiliate = create(:direct_affiliate, seller:, affiliate_user:, created_at: SEEDED_AT, updated_at: SEEDED_AT)
      purchase.direct_affiliate_id = direct_affiliate.id
      purchase.direct_affiliate_credit_cents = DIRECT_ON_COLLAB_CENTS
      purchase.affiliate_credit_cents += DIRECT_ON_COLLAB_CENTS
      purchase.save!(validate: false)
    end
    purchase.flow_of_funds = flow
    purchase.increment_sellers_balance!
    purchase = Purchase.find(purchase.id)
    refunds.each_with_index do |(amount_cents, fee_cents), index|
      refund = seed_refund(purchase, amount_cents:, fee_cents:)
      next unless prior && index < refunds.size - 1

      purchase.stripe_partially_refunded = prior == :partial
      purchase.stripe_refunded = prior == :full
      purchase.decrement_balance_for_refund_or_chargeback!(refund_flow_of(amount_cents), refund:)
      purchase.save!(validate: false)
    end
    yield purchase, seller, merchant_account if block_given?
  end
end

def run_case(name, seed:, refund_id: 1, partially_refunded: false)
  warn "case: #{name}"
  $random_seq = 0
  refund_flow = nil
  result = capture(name, now: NOW, tables: $dirty, seed:) do
    purchase = Purchase.find(1)
    purchase.link.user
    purchase.seller
    refund = Refund.find(refund_id)
    refund.purchase = purchase
    refund_flow = refund_flow_of(refund.total_transaction_cents)
    # refund_purchase! has set the new flags in memory when it gets here
    purchase.stripe_partially_refunded = partially_refunded
    purchase.stripe_refunded = !partially_refunded
    marker("decrement", "start")
    begin
      purchase.decrement_balance_for_refund_or_chargeback!(refund_flow, refund:)
    ensure
      marker("decrement", "end")
    end
  end
  c = ActiveRecord::Base.connection
  $dirty = ALL_TABLES.reject { c.select_value("SELECT 1 FROM #{c.quote_table_name(_1)} LIMIT 1").nil? }
  result.merge("flow_of_funds" => refund_flow.to_h_for_golden, "partially_refunded" => partially_refunded, "refund_id" => refund_id)
end

warn "seeding"
cases = []
cases << run_case("a full refund reverses the affiliate's whole credit and the seller's rest", seed: affiliate_sale)
cases << run_case("a partial refund reverses the affiliate's share and leaves an AffiliatePartialRefund", seed: affiliate_sale(refunds: [[200, 58]]), partially_refunded: true)
cases << run_case("a collaborator's partial refund", seed: affiliate_sale(kind: :collaborator, refunds: [[200, 58]]), partially_refunded: true)
cases << run_case("a collaborator's full refund", seed: affiliate_sale(kind: :collaborator))
cases << run_case("a seller who bears the affiliate fee gets a partial reversal without a fee", seed: affiliate_sale(refunds: [[200, 58]], bears_fee: true), partially_refunded: true)
cases << run_case("a second partial refund reverses its share of an earlier one", seed: affiliate_sale(refunds: [[200, 58], [100, 29]], prior: :partial), refund_id: 2, partially_refunded: true)
cases << run_case("a partial refund too small to reverse anything reaches only the seller", seed: affiliate_sale(refunds: [[1, 0]]), partially_refunded: true)
cases << run_case("a sale with no affiliate credit reaches only the seller", seed: sale { |purchase, _, _|
  purchase.flow_of_funds = flow
  purchase.increment_sellers_balance!
  seed_refund(Purchase.find(purchase.id), amount_cents: 200, fee_cents: 58)
}, partially_refunded: true)
cases << run_case("a refund after the whole purchase was refunded writes nothing", seed: affiliate_sale(refunds: [[500, 145], [500, 145]], prior: :full), refund_id: 2)
cases << run_case("the rest of a sale whose earlier partial refund reversed part of the credit", seed: affiliate_sale(refunds: [[200, 58], [300, 87]], prior: :partial), refund_id: 2)
cases << run_case("a refund whose amount is the total transaction of a sale with tax is a full one", seed: affiliate_sale(refunds: [[600, 174]], sale_options: { total_transaction_cents: 600 }))
cases << run_case("a collaborator beside a direct affiliate, refunded in full", seed: affiliate_sale(kind: :collaborator, direct: true))
cases << run_case("a collaborator beside a direct affiliate, partially refunded", seed: affiliate_sale(kind: :collaborator, direct: true, refunds: [[200, 58]]), partially_refunded: true)

File.write(OUT, JSON.pretty_generate({ "now" => NOW.iso8601(3), "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
