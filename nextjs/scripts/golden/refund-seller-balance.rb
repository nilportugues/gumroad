# frozen_string_literal: true

# Writes nextjs/src/server/models/__fixtures__/refund-seller-balance.golden.json: Purchase#process_refund_or_chargeback_for_purchase_balance
# as the real class runs it for a refund of a sold purchase (the seller's refund BalanceTransaction, the Balance it lands on and the
# purchase's `purchase_refund_balance_id`), against a scratch database, with every statement the mysql2 driver sent (and what MySQL
# answered) recorded between the "refund" markers. Stripe is never reached: nothing in this path calls it.
#
# The refund row is seeded the way refund_purchase! has it when it calls the method (inserted a moment earlier, same transaction).
#
#   RAILS_ENV=test DATABASE_NAME=gumroad_test_28 TEST_DATABASE_NAME=gumroad_test_28 DISABLE_TEST_REDIS_ISOLATION=1 \
#     REDIS_HOST=redis:6379/45 SIDEKIQ_REDIS_HOST=redis:6379/46 RPUSH_REDIS_HOST=redis:6379/47 \
#     RACK_ATTACK_REDIS_HOST=redis:6379/48 DISABLE_SPRING=1 bundle exec rails runner nextjs/scripts/golden/refund-seller-balance.rb
require_relative "support/paid_sale"

OUT = Rails.root.join("nextjs/src/server/models/__fixtures__/refund-seller-balance.golden.json")
REFUND_ID = 1

def refund_flow(issued: ["usd", 500], settled: ["usd", 500], gumroad: ["usd", 500], gross: nil, net: nil)
  FlowOfFunds.new(issued_amount: FlowOfFunds::Amount.new(currency: issued[0], cents: issued[1]),
                  settled_amount: FlowOfFunds::Amount.new(currency: settled[0], cents: settled[1]),
                  gumroad_amount: FlowOfFunds::Amount.new(currency: gumroad[0], cents: gumroad[1]),
                  merchant_account_gross_amount: gross && FlowOfFunds::Amount.new(currency: gross[0], cents: gross[1]),
                  merchant_account_net_amount: net && FlowOfFunds::Amount.new(currency: net[0], cents: net[1]))
end

# The refund refund_purchase! inserted: `refunds << refund` has run, the rest of the method has not.
def seed_refund(purchase, amount_cents: 500)
  Refund.new(purchase:, link_id: purchase.link_id, seller_id: purchase.seller_id, processor_refund_id: "re_golden01", status: "succeeded",
             total_transaction_cents: amount_cents, amount_cents:, fee_cents: 0, creator_tax_cents: 0, gumroad_tax_cents: 0,
             created_at: SEEDED_AT, updated_at: SEEDED_AT).save!(validate: false)
end

def refund_sale(refund_amount_cents: 500, **options)
  sale(**options) do |purchase, seller, merchant_account|
    seed_refund(purchase, amount_cents: refund_amount_cents)
    yield purchase, seller, merchant_account if block_given?
  end
end

def run_case(name, seed:, flow_of_funds: refund_flow, refund_cents: 355, **extra)
  warn "case: #{name}"
  $random_seq = 0
  in_memory = nil
  result = capture(name, now: NOW, tables: $dirty, seed:, flow_of_funds: flow_of_funds.to_h_for_golden) do
    purchase = Purchase.find(1)
    purchase.link.user # the create-time seller_is_link_user validation loaded it on the instance the order carries
    purchase.seller
    refund = Refund.find(REFUND_ID)
    marker("refund", "start")
    begin
      purchase.process_refund_or_chargeback_for_purchase_balance(flow_of_funds, refund:, refund_cents:)
    ensure
      marker("refund", "end")
      in_memory = purchase.purchase_refund_balance_id
    end
  end
  c = ActiveRecord::Base.connection
  $dirty = ALL_TABLES.reject { c.select_value("SELECT 1 FROM #{c.quote_table_name(_1)} LIMIT 1").nil? }
  result.merge("purchase_refund_balance_id" => in_memory, "persisted_purchase_refund_balance_id" => Purchase.find(1).purchase_refund_balance_id, "refund_cents" => refund_cents)
end

class FlowOfFunds
  def to_h_for_golden
    amount = ->(a) { a && { "currency" => a.currency, "cents" => a.cents } }
    { "issued" => amount.(issued_amount), "settled" => amount.(settled_amount), "gumroad" => amount.(gumroad_amount),
      "gross" => amount.(merchant_account_gross_amount), "net" => amount.(merchant_account_net_amount) }
  end
end

SALE_DAY = Date.new(2026, 11, 1)
SALE_AT = Time.utc(2026, 11, 1, 10, 0, 0)

warn "seeding"
cases = []
cases << run_case("a refund lands on the open balance of the day the sale succeeded", seed: refund_sale(succeeded_at: SALE_AT) { |_, seller, ma|
  unpaid_balance(seller, ma, date: SALE_DAY - 3)
  unpaid_balance(seller, ma, date: SALE_DAY)
})
cases << run_case("a refund lands on the oldest open balance when the sale's day has none", seed: refund_sale(succeeded_at: SALE_AT) { |_, seller, ma|
  unpaid_balance(seller, ma, date: SALE_DAY + 1)
  unpaid_balance(seller, ma, date: SALE_DAY - 2)
})
cases << run_case("a refund with no open balance creates the one of the day it was made", seed: refund_sale(succeeded_at: SALE_AT))
cases << run_case("a refund does not land on a paid balance of the sale's day", seed: refund_sale(succeeded_at: SALE_AT) { |_, seller, ma|
  unpaid_balance(seller, ma, date: SALE_DAY, state: "paid")
})
cases << run_case("a refund does not land on a balance held in another currency", seed: refund_sale(succeeded_at: SALE_AT) { |_, seller, ma|
  Balance.create!(user: seller, merchant_account: ma, date: SALE_DAY, currency: "usd", holding_currency: "cad", amount_cents: 1000, holding_amount_cents: 1250)
})
cases << run_case("a refund of a sale with no succeeded_at takes the oldest open balance", seed: refund_sale(succeeded_at: nil) { |_, seller, ma|
  unpaid_balance(seller, ma, date: SALE_DAY + 1)
})
cases << run_case("a refund of a sale with no succeeded_at and no open balance creates the day's", seed: refund_sale(succeeded_at: nil))
cases << run_case("a refund takes the only open balance, dated the day of the refund", seed: refund_sale(succeeded_at: SALE_AT) { |_, seller, ma|
  unpaid_balance(seller, ma, date: SEEDED_AT.to_date, amount_cents: 200)
}, refund_cents: 100)
cases << run_case("a refund whose flow of funds holds the money in the account's currency", seed: refund_sale(succeeded_at: SALE_AT) { |_, seller, ma|
  Balance.create!(user: seller, merchant_account: ma, date: SALE_DAY, currency: "usd", holding_currency: "cad", amount_cents: 1000, holding_amount_cents: 1250)
}, flow_of_funds: refund_flow(gross: ["cad", 625], net: ["cad", 444]))
cases << run_case("a refund of a EUR issued amount books its currency", seed: refund_sale(succeeded_at: SALE_AT), flow_of_funds: refund_flow(issued: ["eur", 460]))
cases << run_case("a refund of nothing books nothing", seed: refund_sale(succeeded_at: SALE_AT), refund_cents: 0)
cases << run_case("a refund of a seller's own Connect account books nothing", seed: refund_sale(account: :seller_connect, succeeded_at: SALE_AT))
cases << run_case("a refund of a sale with a buyer-currency presentment", seed: refund_sale(succeeded_at: SALE_AT) { |purchase, _, _|
  purchase.update_columns(total_transaction_cents: 470)
  PurchasePresentment.new(purchase:, processor: "stripe", presentment_currency: "eur", presentment_price_cents: 460, presentment_total_cents: 460, presentment_gumroad_amount_cents: 100).save!(validate: false)
})

File.write(OUT, JSON.pretty_generate({ "now" => NOW.iso8601(3), "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
