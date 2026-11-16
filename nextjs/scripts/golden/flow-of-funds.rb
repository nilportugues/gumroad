# frozen_string_literal: true

# Produces nextjs/src/server/stripe/__fixtures__/flow-of-funds.golden.json: the FlowOfFunds that StripeChargeRefund builds from the
# objects Stripe returned for a refund (StripeChargeProcessor#get_refund), run by the real class on Stripe::StripeObjects built
# from JSON. No database, no service and no credential is reached. Run it with any test database configured:
#
#   RAILS_ENV=test DISABLE_SPRING=1 DISABLE_TEST_REDIS_ISOLATION=1 bundle exec rails runner nextjs/scripts/golden/flow-of-funds.rb
require "json"

OUT = Rails.root.join("nextjs/src/server/stripe/__fixtures__/flow-of-funds.golden.json")

def obj(hash) = hash && Stripe::StripeObject.construct_from(hash)

def bt(id, amount, currency = "usd") = { id:, object: "balance_transaction", amount:, currency: }

def refund_hash(amount: 100, currency: "usd", id: "re_1", bt_amount: -amount, bt_currency: currency)
  { id:, object: "refund", amount:, currency:, charge: "ch_1", balance_transaction: bt("txn_r1", bt_amount, bt_currency) }
end

def fee_refund(amount, currency = "usd", id: "fr_1") = { id:, object: "fee_refund", amount:, currency:, balance_transaction: bt("txn_f1", -amount, currency) }

def destination_refund(amount, currency = "usd", id: "pyr_1") = { id:, object: "refund", amount:, currency:, balance_transaction: bt("txn_d1", -amount, currency) }

# Each case lists the Stripe objects the way get_refund hands them over. `fee_leg` is the application fee refund's balance transaction;
# `destination_fee_refund` is the fee refund on the destination payment.
CASES = {
  "a plain charge" => { charge: { destination: nil, application_fee: nil }, refund: refund_hash },
  "a plain partial refund" => { charge: { destination: nil, application_fee: nil }, refund: refund_hash(amount: 37) },
  "a plain refund settled in another currency" => { charge: { destination: nil, application_fee: nil }, refund: refund_hash(amount: 100, bt_amount: -91, bt_currency: "eur") },
  "a plain charge whose expanded application fee has an account" => { charge: { destination: nil, application_fee: { id: "fee_1", account: "acct_1" } }, refund: refund_hash(amount: 80) },
  "a plain charge whose expanded application fee has no account" => { charge: { destination: nil, application_fee: { id: "fee_1", account: nil } }, refund: refund_hash },
  "a plain charge with an empty destination string" => { charge: { destination: "", application_fee: nil }, refund: refund_hash },
  "a destination charge refunding the fee" => {
    charge: { destination: "acct_dest", application_fee: { id: "fee_1" } }, refund: refund_hash(amount: 100),
    destination_payment_refund: destination_refund(70), refund_bt: bt("txn_r1", -100),
    fee_refund_bt: bt("txn_f1", -30), destination_refund_bt: bt("txn_d1", -70), destination_fee_refund: fee_refund(30)
  },
  "a destination charge refunding the fee in the connected account's currency" => {
    charge: { destination: "acct_dest", application_fee: { id: "fee_1" } }, refund: refund_hash(amount: 100),
    destination_payment_refund: destination_refund(64, "eur"), refund_bt: bt("txn_r1", -100),
    fee_refund_bt: bt("txn_f1", -30), destination_refund_bt: bt("txn_d1", -64, "eur"), destination_fee_refund: fee_refund(27, "eur")
  },
  "a destination charge with a fee refund in another currency than the destination refund" => {
    charge: { destination: "acct_dest", application_fee: { id: "fee_1" } }, refund: refund_hash(amount: 100),
    destination_payment_refund: destination_refund(64, "eur"), refund_bt: bt("txn_r1", -100),
    fee_refund_bt: bt("txn_f1", -30), destination_refund_bt: bt("txn_d1", -64, "eur"), destination_fee_refund: fee_refund(30, "usd")
  },
  "a destination charge without a fee refund" => {
    charge: { destination: "acct_dest", application_fee: nil }, refund: refund_hash(amount: 100),
    destination_payment_refund: destination_refund(70), refund_bt: bt("txn_r1", -100), destination_refund_bt: bt("txn_d1", -70)
  },
  "a destination charge with only the platform's fee leg" => {
    charge: { destination: "acct_dest", application_fee: { id: "fee_1" } }, refund: refund_hash(amount: 100),
    destination_payment_refund: destination_refund(70), refund_bt: bt("txn_r1", -100), fee_refund_bt: bt("txn_f1", -30), destination_refund_bt: bt("txn_d1", -70)
  },
  "a destination charge with only the destination's fee leg" => {
    charge: { destination: "acct_dest", application_fee: nil }, refund: refund_hash(amount: 100),
    destination_payment_refund: destination_refund(70), refund_bt: bt("txn_r1", -100), destination_refund_bt: bt("txn_d1", -70), destination_fee_refund: fee_refund(30)
  },
  "a destination charge made on behalf of the account" => {
    charge: { destination: "acct_dest", application_fee: nil, on_behalf_of: "acct_dest" }, refund: refund_hash(amount: 100),
    destination_payment_refund: destination_refund(70), refund_bt: bt("txn_r1", -100), destination_refund_bt: bt("txn_d1", -70)
  },
  "a destination charge whose refund did not reach the destination" => {
    charge: { destination: "acct_dest", application_fee: nil }, refund: refund_hash(amount: 100), refund_bt: bt("txn_r1", -100)
  },
  "a destination charge whose refund did not reach the destination but has an application fee" => {
    charge: { destination: "acct_dest", application_fee: { id: "fee_1", account: "acct_1" } }, refund: refund_hash(amount: 55), refund_bt: bt("txn_r1", -55)
  },
  "a destination payment Stripe never credited" => {
    charge: { destination: "acct_dest", application_fee: nil }, refund: refund_hash(amount: 100), refund_bt: bt("txn_r1", -100),
    uncredited: true, merchant_account_currency: "usd"
  },
  "an uncredited destination payment that also refunded to the destination" => {
    charge: { destination: "acct_dest", application_fee: { id: "fee_1" } }, refund: refund_hash(amount: 100, bt_amount: -91, bt_currency: "eur"),
    destination_payment_refund: destination_refund(70), refund_bt: bt("txn_r1", -91, "eur"), destination_refund_bt: bt("txn_d1", -70),
    uncredited: true, merchant_account_currency: "eur"
  },
  "an uncredited destination payment with no merchant account currency" => {
    charge: { destination: "acct_dest", application_fee: nil }, refund: refund_hash(amount: 100), refund_bt: bt("txn_r1", -100),
    destination_payment_refund: destination_refund(70), destination_refund_bt: bt("txn_d1", -70), uncredited: true
  },
  "an uncredited flag on a charge with no destination" => {
    charge: { destination: nil, application_fee: nil }, refund: refund_hash(amount: 100), uncredited: true, merchant_account_currency: "usd"
  },
  "an unexpanded application fee on a charge with no destination" => { charge: { destination: nil, application_fee: "fee_1" }, refund: refund_hash(amount: 100) }
}.freeze

def run(spec)
  spec = normalized(spec)
  charge = obj({ id: "ch_1", object: "charge", on_behalf_of: nil }.merge(spec[:charge]))
  refund = obj(spec[:refund])
  result = StripeChargeRefund.new(
    charge, refund, obj(spec[:destination_payment_refund]), obj(spec[:refund_bt]), obj(spec[:fee_refund_bt]),
    obj(spec[:destination_refund_bt]), obj(spec[:destination_fee_refund]),
    destination_payment_uncredited: spec[:uncredited] == true, merchant_account_currency: spec[:merchant_account_currency]
  )
  { "id" => result.id, "charge_id" => result.charge_id, "flow_of_funds" => JSON.parse(result.flow_of_funds.to_h.to_json) }
rescue StandardError => e
  { "error" => { "class" => e.class.name, "message" => e.message } }
end

# get_refund hands over the refund's own balance transaction unless the case says otherwise.
def normalized(spec) = spec.merge(refund_bt: spec[:refund_bt] || spec[:refund][:balance_transaction])

def input(spec) = JSON.parse(normalized(spec).to_json)

cases = CASES.map { |name, spec| { "name" => name, "input" => input(spec), "output" => run(spec) } }
File.write(OUT, JSON.pretty_generate({ "cases" => cases }) + "\n")
puts "wrote #{cases.size} cases to #{OUT}"
