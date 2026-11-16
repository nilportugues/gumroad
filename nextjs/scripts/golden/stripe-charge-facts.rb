# frozen_string_literal: true

# Writes nextjs/src/server/models/__fixtures__/stripe-charge-facts.golden.json: what the real `StripeCharge` reads off a Stripe charge
# and its balance transactions after a charge succeeded: the processor fee, the flow of funds (issued, settled, Gumroad's amount, the
# connected account's gross and net) and the card details `Purchase#save_charge_data` stores. The inputs are the recorded response of
# the $5 card purchase (spec/requests/orders_paid_purchase_parity_spec.rb) and variations of it: no fee detail, a destination charge
# with and without an application fee, a direct charge, a buyer-currency charge, a destination payment that was never credited.
#
#   RAILS_ENV=test DATABASE_NAME=gumroad_test_24 TEST_DATABASE_NAME=gumroad_test_24 DISABLE_TEST_REDIS_ISOLATION=1 \
#     REDIS_HOST=redis:6379/50 SIDEKIQ_REDIS_HOST=redis:6379/51 RPUSH_REDIS_HOST=redis:6379/52 \
#     RACK_ATTACK_REDIS_HOST=redis:6379/53 DISABLE_SPRING=1 bundle exec rails runner nextjs/scripts/golden/stripe-charge-facts.rb
require "json"
require "active_support/testing/time_helpers"
include ActiveSupport::Testing::TimeHelpers

OUT = Rails.root.join("nextjs/src/server/models/__fixtures__/stripe-charge-facts.golden.json")
RECORDING = Rails.root.join("nextjs/parity/fixtures/requests/orders_paid_purchase_parity_spec/orders-paid-purchase-hands-a-paid-tokenized-card-purchase-back-whole.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45)

recorded = JSON.parse(File.read(RECORDING)).fetch("exchanges").last.fetch("http").last
RECORDED_CHARGE = JSON.parse(recorded.fetch("response").fetch("body"))
BASE_BALANCE_TRANSACTION = RECORDED_CHARGE.fetch("balance_transaction")
BASE_CHARGE = RECORDED_CHARGE.merge("balance_transaction" => BASE_BALANCE_TRANSACTION["id"])

def deep_merge(base, override) = base.deep_merge(override.deep_stringify_keys)

def facts_of(charge_json, bt, app_fee_bt, dest_bt, transfer, destination_payment: nil, merchant_account_currency: nil)
  charge = Stripe::Charge.construct_from(charge_json)
  wrap = ->(value) { value && Stripe::BalanceTransaction.construct_from(value) }
  processor_charge = StripeCharge.new(charge, wrap.call(bt), wrap.call(app_fee_bt), wrap.call(dest_bt), transfer && Stripe::Transfer.construct_from(transfer),
                                      stripe_destination_payment: destination_payment && Stripe::Charge.construct_from(destination_payment),
                                      merchant_account_currency:)
  amount = ->(value) { value && { currency: value.currency, cents: value.cents } }
  flow = processor_charge.flow_of_funds
  {
    id: processor_charge.id, status: processor_charge.status, refunded: processor_charge.refunded, disputed: processor_charge.disputed,
    amount_cents: processor_charge.amount_cents, currency: processor_charge.currency, amount_refunded_cents: processor_charge.amount_refunded_cents,
    fee: processor_charge.fee, fee_currency: processor_charge.fee_currency,
    flow_of_funds: flow && {
      issued_amount: amount.call(flow.issued_amount), settled_amount: amount.call(flow.settled_amount), gumroad_amount: amount.call(flow.gumroad_amount),
      merchant_account_gross_amount: amount.call(flow.merchant_account_gross_amount), merchant_account_net_amount: amount.call(flow.merchant_account_net_amount)
    },
    card_fingerprint: processor_charge.card_fingerprint, card_instance_id: processor_charge.card_instance_id, card_last4: processor_charge.card_last4,
    card_number_length: processor_charge.card_number_length, card_expiry_month: processor_charge.card_expiry_month,
    card_expiry_year: processor_charge.card_expiry_year, card_zip_code: processor_charge.card_zip_code, card_type: processor_charge.card_type,
    card_country: processor_charge.card_country, zip_check_result: processor_charge.zip_check_result, risk_level: processor_charge.risk_level,
    card_mandate: processor_charge.card_mandate, payment_method_type: processor_charge.payment_method_type
  }
end

cases = []
add = lambda do |name, charge: {}, bt: {}, app_fee_bt: nil, dest_bt: nil, transfer: nil, destination_payment: nil, merchant_account_currency: nil, drop_bt: false, fee_details: nil, drop_charge_keys: []|
  charge_json = deep_merge(BASE_CHARGE, charge)
  drop_charge_keys.each { charge_json.delete(_1) }
  bt_json = deep_merge(BASE_BALANCE_TRANSACTION, bt)
  bt_json["fee_details"] = fee_details unless fee_details.nil?
  input = { charge: charge_json, balance_transaction: drop_bt ? nil : bt_json, application_fee_balance_transaction: app_fee_bt,
            destination_payment_balance_transaction: dest_bt, destination_transfer: transfer, destination_payment:, merchant_account_currency: }
  output = travel_to(NOW) do
    facts_of(charge_json, drop_bt ? nil : bt_json, app_fee_bt, dest_bt, transfer, destination_payment:, merchant_account_currency:)
  end
  cases << { name:, input:, output: }
end

add.call("recorded platform charge")
add.call("no balance transaction", drop_bt: true)
add.call("empty fee details", fee_details: [])
add.call("fee detail that is not Stripe's", fee_details: [{ "amount" => 12, "currency" => "usd", "type" => "application_fee" }])
add.call("several fee details, Stripe's second", fee_details: [{ "amount" => 12, "currency" => "usd", "type" => "tax" }, { "amount" => 45, "currency" => "usd", "type" => "stripe_fee" }])
add.call("fee in another currency", bt: { "currency" => "eur", "amount" => 460, "net" => 420 }, fee_details: [{ "amount" => 40, "currency" => "eur", "type" => "stripe_fee" }])
add.call("buyer-currency charge settled in dollars", charge: { "currency" => "eur", "amount" => 460 }, bt: { "currency" => "usd", "amount" => 500, "net" => 455 })
add.call("fully refunded", charge: { "refunded" => true, "amount_refunded" => 500, "status" => "SUCCEEDED" })
add.call("partially refunded", charge: { "amount_refunded" => 200 })
add.call("disputed", charge: { "dispute" => "dp_1" })
add.call("no payment method details", drop_charge_keys: ["payment_method_details"])
add.call("link payment, no card block", charge: { "payment_method_details" => { "type" => "link", "card" => nil, "link" => { "country" => "US" } }, "billing_details" => { "address" => { "postal_code" => "10001" } } })
add.call("pix payment, no card block", charge: { "payment_method_details" => { "type" => "pix", "card" => nil, "pix" => { "country" => "BR" } } })
add.call("unknown method type, no card block", charge: { "payment_method_details" => { "type" => "wechat_pay", "card" => nil } })
add.call("card brand mastercard", charge: { "payment_method_details" => { "card" => { "brand" => "mastercard" } } })
add.call("card brand amex", charge: { "payment_method_details" => { "card" => { "brand" => "amex" } } })
add.call("card brand unknown to the table", charge: { "payment_method_details" => { "card" => { "brand" => "cartes_bancaires" } } })
add.call("card without brand", charge: { "payment_method_details" => { "card" => { "brand" => nil } } })
add.call("zip check passed", charge: { "payment_method_details" => { "card" => { "checks" => { "address_postal_code_check" => "pass" } } } })
add.call("zip check failed", charge: { "payment_method_details" => { "card" => { "checks" => { "address_postal_code_check" => "fail" } } } })
add.call("zip check unavailable", charge: { "payment_method_details" => { "card" => { "checks" => { "address_postal_code_check" => "unavailable" } } } })
add.call("card with a mandate", charge: { "payment_method_details" => { "card" => { "mandate" => "mandate_1" } } })
add.call("elevated risk", charge: { "outcome" => { "risk_level" => "elevated" } })

app_fee = { "id" => "txn_fee", "object" => "balance_transaction", "amount" => 145, "currency" => "usd", "net" => 145, "fee" => 0, "fee_details" => [], "type" => "application_fee" }
dest_payment_bt = { "id" => "txn_dest", "object" => "balance_transaction", "amount" => 500, "currency" => "usd", "net" => 355, "fee" => 0, "fee_details" => [], "type" => "payment" }
transfer = { "id" => "tr_1", "object" => "transfer", "amount" => 355, "currency" => "usd" }
add.call("direct charge with an application fee", app_fee_bt: app_fee)
add.call("direct charge in another currency", charge: { "currency" => "eur", "amount" => 460 }, bt: { "currency" => "cad", "amount" => 700, "net" => 650 }, app_fee_bt: app_fee.merge("currency" => "eur", "amount" => 130))
add.call("destination charge, application fee object, destination payment credited", charge: { "destination" => "acct_dest" }, app_fee_bt: app_fee, dest_bt: dest_payment_bt, transfer: transfer)
add.call("destination charge, transfer data only, destination payment credited", charge: { "destination" => "acct_dest" }, dest_bt: dest_payment_bt, transfer: transfer)
add.call("destination charge, buyer-currency transfer data", charge: { "destination" => "acct_dest", "currency" => "eur", "amount" => 460 }, dest_bt: dest_payment_bt.merge("currency" => "gbp", "amount" => 400, "net" => 330), transfer: transfer.merge("amount" => 330, "currency" => "eur"))
add.call("destination charge, no application fee and no transfer", charge: { "destination" => "acct_dest" }, dest_bt: dest_payment_bt)
add.call("destination charge, destination payment not credited yet", charge: { "destination" => "acct_dest" }, app_fee_bt: app_fee, transfer: transfer)
add.call("destination charge, destination payment never credited", charge: { "destination" => "acct_dest" }, transfer: transfer.merge("amount" => 1), merchant_account_currency: "gbp",
                                                                   destination_payment: { "id" => "py_1", "status" => "succeeded", "captured" => true, "created" => (NOW - 25 * 3600).to_i })
add.call("destination charge, destination payment settling within the grace", charge: { "destination" => "acct_dest" }, transfer: transfer.merge("amount" => 1), merchant_account_currency: "gbp",
                                                                   destination_payment: { "id" => "py_1", "status" => "succeeded", "captured" => true, "created" => (NOW - 23 * 3600).to_i })
add.call("destination charge, destination payment not captured", charge: { "destination" => "acct_dest" }, transfer: transfer.merge("amount" => 1), merchant_account_currency: "gbp",
                                                                   destination_payment: { "id" => "py_1", "status" => "succeeded", "captured" => false, "created" => (NOW - 25 * 3600).to_i })
add.call("destination charge, never credited, account currency unknown", charge: { "destination" => "acct_dest" }, transfer: transfer.merge("amount" => 1),
                                                                   destination_payment: { "id" => "py_1", "status" => "succeeded", "captured" => true, "created" => (NOW - 25 * 3600).to_i })

lengths = CreditCardUtility::CARD_TYPE_DEFAULT_LENGTHS
File.write(OUT, JSON.pretty_generate(
  constants: { card_number_lengths: lengths, now: NOW.iso8601, destination_payment_settlement_grace_hours: StripeCharge::DESTINATION_PAYMENT_SETTLEMENT_GRACE.in_hours.to_i },
  cases:
) + "\n")
puts "wrote #{OUT} (#{cases.size} cases)"
