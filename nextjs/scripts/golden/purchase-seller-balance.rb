# frozen_string_literal: true

# Writes nextjs/src/server/models/__fixtures__/purchase-seller-balance.golden.json: Purchase#increment_sellers_balance! as the real
# class runs it for a sold purchase, against a scratch database, with every statement the mysql2 driver sent (and what MySQL
# answered) recorded between the "increment" markers. Stripe is never reached: nothing in this path calls it.
#
# Each case seeds its rows with the factories (the purchase is built and saved without validation, since the purchase factories
# charge a card), loads the purchase, its link and its seller, sets the flow of funds the processor charge would have produced, and
# calls the method.
#
#   RAILS_ENV=test DATABASE_NAME=gumroad_test_24 TEST_DATABASE_NAME=gumroad_test_24 DISABLE_TEST_REDIS_ISOLATION=1 \
#     REDIS_HOST=redis:6379/50 SIDEKIQ_REDIS_HOST=redis:6379/51 RPUSH_REDIS_HOST=redis:6379/52 \
#     RACK_ATTACK_REDIS_HOST=redis:6379/53 DISABLE_SPRING=1 bundle exec rails runner nextjs/scripts/golden/purchase-seller-balance.rb
require_relative "support/paid_sale"

OUT = Rails.root.join("nextjs/src/server/models/__fixtures__/purchase-seller-balance.golden.json")

def run_case(name, seed:, flow_of_funds: flow, **extra)
  warn "case: #{name}"
  $random_seq = 0
  in_memory = nil
  result = capture(name, now: NOW, tables: $dirty, seed:, flow_of_funds: flow_of_funds.to_h_for_golden) do
    purchase = Purchase.find(1)
    purchase.link.user # the create-time seller_is_link_user validation loaded it on the instance the order carries
    purchase.seller
    purchase.flow_of_funds = flow_of_funds
    marker("increment", "start")
    begin
      purchase.increment_sellers_balance!
    ensure
      marker("increment", "end")
      in_memory = purchase.purchase_success_balance_id
    end
  end
  c = ActiveRecord::Base.connection
  $dirty = ALL_TABLES.reject { c.select_value("SELECT 1 FROM #{c.quote_table_name(_1)} LIMIT 1").nil? }
  # in memory after the call (a sale already booked links without saving) and in the table
  result.merge("purchase_success_balance_id" => in_memory, "persisted_purchase_success_balance_id" => Purchase.find(1).purchase_success_balance_id)
end

class FlowOfFunds
  def to_h_for_golden
    amount = ->(a) { a && { "currency" => a.currency, "cents" => a.cents } }
    { "issued" => amount.(issued_amount), "settled" => amount.(settled_amount), "gumroad" => amount.(gumroad_amount),
      "gross" => amount.(merchant_account_gross_amount), "net" => amount.(merchant_account_net_amount) }
  end
end

def usd(gross, net) = BalanceTransaction::Amount.new(currency: "usd", gross_cents: gross, net_cents: net)

# A booked, unapplied balance transaction for the purchase (update_user_balance: false), optionally applied to a balance.
def booked(purchase, seller, merchant_account, applied_to: nil)
  transaction = BalanceTransaction.create!(user: seller, merchant_account:, purchase:, update_user_balance: false, issued_amount: usd(500, 355), holding_amount: usd(500, 355))
  transaction.update_columns(balance_id: applied_to.id) if applied_to
  transaction
end

warn "seeding"
cases = []
cases << run_case("a sale the day it succeeded creates the day's balance", seed: sale)
cases << run_case("a sale lands on the seller's open balance of the same day", seed: sale { |_, seller, ma| unpaid_balance(seller, ma, date: SEEDED_AT.to_date) })
cases << run_case("a sale does not land on an open balance of another day", seed: sale { |_, seller, ma| unpaid_balance(seller, ma, date: SEEDED_AT.to_date - 1) })
cases << run_case("a sale does not land on a paid balance of the same day", seed: sale { |_, seller, ma| unpaid_balance(seller, ma, date: SEEDED_AT.to_date, state: "paid") })
cases << run_case("a sale with a EUR issued amount books its currency", seed: sale, flow_of_funds: flow(issued: ["eur", 460], settled: ["usd", 500], gumroad: ["usd", 500]))
cases << run_case("a sale with no fee books the whole price", seed: sale(fee_cents: 0))
cases << run_case("a sale whose fee exceeds the price books a negative net", seed: sale(fee_cents: 600))
cases << run_case("a free purchase books nothing", seed: sale(price_cents: 0, fee_cents: 0))
cases << run_case("a seller's own Connect account books nothing", seed: sale(account: :seller_connect))
cases << run_case("a purchase with no merchant account is Stripe's and books", seed: sale(account: :none))
cases << run_case("a sale already booked to a balance only links it", seed: sale { |purchase, seller, ma|
  booked(purchase, seller, ma, applied_to: unpaid_balance(seller, ma, date: SEEDED_AT.to_date, amount_cents: 355))
})
cases << run_case("a sale already booked and linked saves nothing", seed: sale { |purchase, seller, ma|
  balance = unpaid_balance(seller, ma, date: SEEDED_AT.to_date, amount_cents: 355)
  booked(purchase, seller, ma, applied_to: balance)
  purchase.update_columns(purchase_success_balance_id: balance.id)
})
cases << run_case("a sale with a balance transaction not yet applied books a second one", seed: sale { |purchase, seller, ma| booked(purchase, seller, ma) })
cases << run_case("a sale with a buyer-currency presentment", seed: sale { |purchase, _, _|
  purchase.update_columns(total_transaction_cents: 470)
  PurchasePresentment.new(purchase:, processor: "stripe", presentment_currency: "eur", presentment_price_cents: 460, presentment_total_cents: 460, presentment_gumroad_amount_cents: 100).save!(validate: false)
})

File.write(OUT, JSON.pretty_generate({ "now" => NOW.iso8601(3), "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
