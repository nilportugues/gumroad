# frozen_string_literal: true

# Writes nextjs/src/server/models/__fixtures__/purchase-paid-success.golden.json: what Order::ChargeService does once Stripe has
# charged a paid purchase and the purchase holds its charge data: `Purchase::MarkSuccessfulService#perform` (set_succeeded_at,
# increment_sellers_balance!, the in_progress to successful transition with its after_transition callbacks and after_commit
# jobs, ActivateIntegrationsWorker), run by the real class against a scratch database. Every statement the mysql2 driver sent, every
# Sidekiq push, Flipper read and app Redis command is recorded between the "success" markers, in the order they happened.
# Stripe is never reached: the purchase is seeded as `save_charge_data` leaves it.
#
#   RAILS_ENV=test DATABASE_NAME=gumroad_test_24 TEST_DATABASE_NAME=gumroad_test_24 DISABLE_TEST_REDIS_ISOLATION=1 \
#     REDIS_HOST=redis:6379/50 SIDEKIQ_REDIS_HOST=redis:6379/51 RPUSH_REDIS_HOST=redis:6379/52 \
#     RACK_ATTACK_REDIS_HOST=redis:6379/53 DISABLE_SPRING=1 bundle exec rails runner nextjs/scripts/golden/purchase-paid-success.rb
require_relative "support/paid_sale"

OUT = Rails.root.join("nextjs/src/server/models/__fixtures__/purchase-paid-success.golden.json")

# The app's own Redis ($redis, db REDIS_HOST) commands; Sidekiq's client uses another database.
APP_REDIS_DB = ENV.fetch("REDIS_HOST")[%r{/(\d+)\z}, 1].to_i
module RedisRecorder
  def call_v(command, &block) = RedisRecorder.wrap(self, command) { super }
  def call_once_v(command, &block) = RedisRecorder.wrap(self, command) { super }
  def blocking_call_v(timeout, command, &block) = RedisRecorder.wrap(self, command) { super }

  def self.wrap(client, command)
    result = yield
    if RailsRecorder.log && client.config.db == APP_REDIS_DB
      RailsRecorder.log << { "redis" => command.map(&:to_s), "result" => RailsRecorder.encode_value(result) }
    end
    result
  end
end
RedisClient.prepend(RedisRecorder)

# A paid purchase as `save_charge_data` leaves it: charged, with the processor's fee and ids, in an order with one charge.
def paid_sale(account: :gumroad, order: true, **attributes)
  sale(account:, succeeded_at: nil, stripe_transaction_id: "ch_paid", stripe_fingerprint: "fp_paid", stripe_card_id: "card_paid",
       card_expiry_month: 12, card_expiry_year: 2030, processor_fee_cents: 45, processor_fee_cents_currency: "usd", **attributes) do |purchase, seller, merchant_account|
    if order
      the_order = Order.create!(created_at: SEEDED_AT, updated_at: SEEDED_AT)
      OrderPurchase.create!(order: the_order, purchase:)
      charge = Charge.create!(order: the_order, seller:, merchant_account:, processor: "stripe", processor_transaction_id: "ch_paid", amount_cents: 500,
                              gumroad_amount_cents: 145, stripe_payment_intent_id: "pi_paid", created_at: SEEDED_AT, updated_at: SEEDED_AT)
      ChargePurchase.create!(charge:, purchase:)
    end
    ProcessorPaymentIntent.create!(purchase:, intent_id: "pi_paid")
    yield purchase, seller, merchant_account if block_given?
  end
end

def run_case(name, seed:, flow_of_funds: flow)
  warn "case: #{name}"
  $random_seq = 0
  result = capture(name, now: NOW, tables: $dirty, seed:, flow_of_funds: flow_of_funds.to_h_for_golden) do
    purchase = Purchase.find(1)
    purchase.link.user # loaded by the create-time validations on the instance the order carries
    purchase.seller
    # The create service assigned the variants and prepare_merchant_account the account on the instance the charge then saved.
    purchase.variant_attributes.load
    purchase.merchant_account
    # The order service linked the order and the charge to it, and the create service assigned its url parameters.
    purchase.order_purchase
    purchase.charge&.order
    purchase.purchase_url_parameter
    purchase.flow_of_funds = flow_of_funds
    marker("success", "start")
    begin
      Purchase::MarkSuccessfulService.new(purchase).perform
    ensure
      marker("success", "end")
    end
  end
  c = ActiveRecord::Base.connection
  $dirty = ALL_TABLES.reject { c.select_value("SELECT 1 FROM #{c.quote_table_name(_1)} LIMIT 1").nil? }
  result.merge("final_state" => Purchase.find(1).purchase_state)
end

class FlowOfFunds
  def to_h_for_golden
    amount = ->(a) { a && { "currency" => a.currency, "cents" => a.cents } }
    { "issued" => amount.(issued_amount), "settled" => amount.(settled_amount), "gumroad" => amount.(gumroad_amount),
      "gross" => amount.(merchant_account_gross_amount), "net" => amount.(merchant_account_net_amount) }
  end
end

warn "seeding"
cases = []
cases << run_case("a $5 sale held by Gumroad's Stripe account", seed: paid_sale)
cases << run_case("a sale of a seller with a workflow", seed: paid_sale { |_, seller, _| create(:seller_workflow, seller:, created_at: SEEDED_AT, updated_at: SEEDED_AT) })
cases << run_case("a sale held by the seller's own Connect account", seed: paid_sale(account: :seller_connect))
cases << run_case("a sale lands on the seller's open balance of the day", seed: paid_sale { |_, seller, ma| unpaid_balance(seller, ma, date: SEEDED_AT.to_date) })
cases << run_case("a sale with a EUR issued amount", seed: paid_sale, flow_of_funds: flow(issued: ["eur", 460], settled: ["usd", 500], gumroad: ["usd", 500]))
cases << run_case("a sale in an order that carries a cart", seed: paid_sale { |_, _, _|
  Cart.create!(order: Order.first, user: nil, email: "buyer@example.com", ip_address: "127.0.0.1", created_at: SEEDED_AT, updated_at: SEEDED_AT)
})
cases << run_case("a sale with no order", seed: paid_sale(order: false))

File.write(OUT, JSON.pretty_generate({ "now" => NOW.iso8601(3), "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
