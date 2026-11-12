# frozen_string_literal: true

# Produces nextjs/src/server/stripe/__fixtures__/refund-fee-retention.golden.json: what Rails does with Stripe after a refund's ledger
# is written, run by the real classes on rows inserted inside a transaction that is rolled back. Four parts:
#   retention  - Credit.create_for_refund_fee_retention! (the fee kept from the seller, for Gumroad-managed and for Connect accounts)
#   collection - StripeChargeProcessor.debit_stripe_account_for_refund_fee against a scripted Stripe
#   excess     - Purchase#reverse_excess_amount_from_stripe_transfer against a scripted Stripe
#   dispute    - Purchase#reverse_the_transfer_made_for_dispute_win! against a scripted Stripe
# Stripe is never reached: the class methods the code calls are replaced by ones that note the call and answer from the case. The
# refund's writes (save!, with_lock) are noted in the same list, so the order of a pin, a call and a record is part of the golden.
#
#   RAILS_ENV=test DISABLE_SPRING=1 DISABLE_TEST_REDIS_ISOLATION=1 bundle exec rails runner nextjs/scripts/golden/refund-fee-retention.rb
require "json"
require "factory_bot_rails"
require "active_support/testing/time_helpers"

include ActiveSupport::Testing::TimeHelpers

OUT = Rails.root.join("nextjs/src/server/stripe/__fixtures__/refund-fee-retention.golden.json")
Rails.logger = ActiveSupport::Logger.new(nil)
FactoryBot.definition_file_paths = [Rails.root.join("spec/support/factories").to_s]
FactoryBot.find_definitions

NOW = Time.utc(2026, 11, 12, 12, 0, 0)
RATES = { "CAD" => "1.25", "EUR" => "0.8" }.freeze
ACCOUNT_ID = "acct_golden01"

def obj(hash) = Stripe::StripeObject.construct_from(hash)
def list(*data) = Stripe::ListObject.construct_from(object: "list", data:, has_more: false)
def transfer(id, amount: 5000, amount_reversed: 0, currency: "usd", reversals: [], description: nil)
  Stripe::Transfer.construct_from(id:, object: "transfer", amount:, amount_reversed:, currency:, description:, destination: ACCOUNT_ID, reversals: list(*reversals))
end
def reversal(id, amount: 4125, currency: "cad", source_refund: nil, refund_id: nil, destination_payment_refund: "pyr_golden01")
  metadata = refund_id ? { refund_id: refund_id.to_s } : {}
  obj(id:, object: "transfer_reversal", amount:, currency:, source_refund:, metadata:, destination_payment_refund:)
end
def invalid_request(message) = Stripe::InvalidRequestError.new(message, nil)
def api_error(message) = Stripe::APIError.new(message)

# Everything the code under test does to Stripe or to the refund, in order.
module Trace
  EVENTS = []
  ANSWERS = {}

  def self.reset(answers)
    EVENTS.clear
    ANSWERS.replace(answers.transform_values { _1.is_a?(Array) ? _1.dup : [_1] })
  end

  OPTION_KEYS = %w[stripe_account idempotency_key api_key].freeze

  # The gem takes (id, params, options) with each optional; a hash is options when every key is one of the request options.
  def self.call(name, args, kwargs)
    args = args.dup
    id = args.first.is_a?(String) ? args.shift : nil
    second_id = args.first.is_a?(String) ? args.shift : nil
    params = nil
    options = nil
    (args + [kwargs]).each do |hash|
      next unless hash.is_a?(Hash) && !hash.empty?

      keys = hash.keys.map(&:to_s)
      if keys.all? { OPTION_KEYS.include?(_1) } then options = hash else params = hash end
    end
    EVENTS << { "call" => name, "id" => id, "params" => JSON.parse(params.to_json), "second_id" => second_id, "options" => JSON.parse(options.to_json) }.compact
    queue = ANSWERS.fetch(name) { raise "unscripted Stripe call #{name} #{args.inspect}" }
    answer = queue.size > 1 ? queue.shift : queue.first
    answer = answer.call(params, options) if answer.respond_to?(:call)
    raise answer if answer.is_a?(Exception)

    answer
  end

  def self.refund_snapshot(refund)
    refund.json_data.slice(*%w[fee_retention_source_transfer debited_stripe_transfer fee_retention_collected_cents fee_retention_pending fee_retention_written_off_at]).compact
  end
end

# [params, options] are taken as Stripe's gem takes them: a hash first, then a hash of options.
{
  Stripe::Transfer => %i[list retrieve create create_reversal list_reversals retrieve_reversal],
  Stripe::Refund => %i[retrieve],
  Stripe::BalanceTransaction => %i[retrieve],
  Stripe::Charge => %i[retrieve]
}.each do |klass, methods|
  methods.each do |method|
    name = "#{klass.name.demodulize}.#{method}"
    klass.define_singleton_method(method) do |*args, **kwargs|
      Trace.call(name, args, kwargs)
    end
  end
end

Refund.prepend(Module.new do
  def save!(*args, **kwargs, &block)
    Trace::EVENTS << { "write" => "refund.save!", "refund" => Trace.refund_snapshot(self) }
    super
  end

  def with_lock(*args, **kwargs, &block)
    Trace::EVENTS << { "write" => "refund.with_lock" }
    super
  end
end)

# The account id is unique per row (a Stripe account belongs to one user) and written back to ACCOUNT_ID in the golden.
def next_account_id = "acct_golden#{format('%02d', (@account_sequence = (@account_sequence || 0) + 1))}"

def merchant_account_for(seller, country:, currency:)
  FactoryBot.create(:merchant_account, user: seller, charge_processor_merchant_id: next_account_id, country:, currency:)
end

def create_purchase(seller, product, merchant_account, columns)
  purchase = FactoryBot.build(:purchase, link: product, seller:, email: "buyer@example.com", purchase_state: "successful", tax_cents: 0,
                                         charge_processor_id: StripeChargeProcessor.charge_processor_id, merchant_account:,
                                         stripe_transaction_id: "ch_golden", **columns)
  purchase.save!(validate: false)
  purchase.update_columns(**columns)
  Purchase.find(purchase.id)
end

# Processor refund ids are unique per row and written back to re_golden01 (re_golden00 for a refund made earlier) in the golden.
def create_refund(purchase, columns = {})
  @refund_sequence = (@refund_sequence || 0) + 1
  refund = Refund.new(purchase:, link_id: purchase.link_id, seller_id: purchase.seller_id, processor_refund_id: "re_golden#{@refund_sequence}", status: "succeeded",
                      total_transaction_cents: purchase.total_transaction_cents, amount_cents: purchase.price_cents, fee_cents: purchase.fee_cents,
                      creator_tax_cents: 0, gumroad_tax_cents: 0, **columns)
  refund.save!(validate: false)
  refund
end

def amounts(bt) = bt.attributes.slice(*%w[issued_amount_currency issued_amount_gross_cents issued_amount_net_cents holding_amount_currency holding_amount_gross_cents holding_amount_net_cents])

RETENTION_CASES = {
  "a Canadian managed account, no processor fee on the sale" => { country: "CA", currency: "cad", sale: { price_cents: 1000, total_transaction_cents: 1000, fee_cents: 100 }, refund: { amount_cents: 1000 } },
  "a Canadian managed account, a partial refund" => { country: "CA", currency: "cad", sale: { price_cents: 1000, total_transaction_cents: 1000, fee_cents: 100 }, refund: { amount_cents: 333 } },
  "a US managed account with the processor fee recorded" => { country: "US", currency: "usd", sale: { price_cents: 1000, total_transaction_cents: 1000, fee_cents: 100, processor_fee_cents: 59, processor_fee_cents_currency: "usd" }, refund: { amount_cents: 400 } },
  "a US managed account with the processor fee in another currency" => { country: "US", currency: "usd", sale: { price_cents: 1000, total_transaction_cents: 1000, fee_cents: 100, processor_fee_cents: 59, processor_fee_cents_currency: "eur" }, refund: { amount_cents: 1000 } },
  "a managed account on a free sale" => { country: "US", currency: "usd", sale: { price_cents: 100, total_transaction_cents: 100, fee_cents: 0 }, refund: { amount_cents: 0 } },
  "a Connect account with Gumroad tax" => { connect: true, sale: { price_cents: 1000, total_transaction_cents: 1100, fee_cents: 100, gumroad_tax_cents: 100 }, refund: { amount_cents: 1000 } },
  "a Connect account with Gumroad tax and an affiliate, a partial refund" => { connect: true, sale: { price_cents: 1000, total_transaction_cents: 1100, fee_cents: 100, gumroad_tax_cents: 100, affiliate_credit_cents: 90 }, refund: { amount_cents: 333 } },
  "a Connect account with nothing to give back" => { connect: true, sale: { price_cents: 1000, total_transaction_cents: 1000, fee_cents: 100 }, refund: { amount_cents: 1000 } }
}.freeze

def run_retention(seller, product)
  RETENTION_CASES.map do |name, spec|
    merchant_account = if spec[:connect]
      FactoryBot.create(:merchant_account_stripe_connect, user: seller, charge_processor_merchant_id: next_account_id)
    else
      merchant_account_for(seller, country: spec[:country], currency: spec[:currency])
    end
    purchase = create_purchase(seller, product, merchant_account, spec[:sale])
    refund = create_refund(purchase, spec[:refund].merge(total_transaction_cents: spec[:refund][:amount_cents]))
    credit = Credit.create_for_refund_fee_retention!(refund:)
    refund.reload
    {
      "name" => name,
      "input" => {
        "sale" => spec[:sale].transform_keys(&:to_s), "refund_amount_cents" => spec[:refund][:amount_cents], "charged_using_gumroad_merchant_account" => purchase.charged_using_gumroad_merchant_account?,
        "holder_of_funds" => merchant_account.holder_of_funds, "merchant_currency" => merchant_account.currency
      },
      "credit_amount_cents" => credit&.amount_cents,
      "credit_merchant_account" => credit && (credit.merchant_account.user_id.nil? ? "gumroad" : "seller"),
      "retained_fee_cents" => refund.retained_fee_cents,
      "fee_retention_pending" => refund.fee_retention_pending,
      "balance_transaction" => credit && amounts(BalanceTransaction.where(credit:).sole)
    }
  end
end

# What a scripted answer looks like in the golden: an object as its hash, a list as the list, an error by class and message.
def serialise_answer(answer)
  return { "error" => { "class" => answer.class.name, "message" => answer.message } } if answer.is_a?(Exception)

  JSON.parse(answer.respond_to?(:to_hash) ? answer.to_hash.to_json : answer.to_json)
end

# The refund's id and everything derived from it are written back as <refund>, so the golden does not move with the database.
def scrub(value, refund)
  json = value.to_json.gsub(%("#{refund.id}"), '"<refund>"').gsub(/refund_fee_retention_(reversal_)?#{refund.id}(?![0-9])/, 'refund_fee_retention_\\1<refund>')
  JSON.parse(json.gsub(/"refund_id":#{refund.id}(?![0-9])/, '"refund_id":"<refund>"'))
end

COLLECTION_CASES = {
  "a reversible transfer on the first page" => {
    account: { country: "CA", currency: "cad" },
    answers: { "Transfer.list" => list(transfer("tr_a", amount: 5000)), "Transfer.create_reversal" => reversal("trr_a"),
               "Refund.retrieve" => obj(id: "pyr_golden01", balance_transaction: "txn_golden01"), "BalanceTransaction.retrieve" => obj(id: "txn_golden01", net: -3000) }
  },
  "an internal payout transfer is reversed before the sale transfers are listed" => {
    account: { country: "CA", currency: "cad" }, payments: [{ transfer: "tr_int1" }, { transfer: nil }],
    answers: { "Transfer.retrieve" => transfer("tr_int1", amount: 5000), "Transfer.create_reversal" => reversal("trr_int"),
               "Refund.retrieve" => obj(id: "pyr_golden01", balance_transaction: "txn_golden01"), "BalanceTransaction.retrieve" => obj(id: "txn_golden01", net: -3000) }
  },
  "an internal payout transfer that is spent falls through to the listed ones" => {
    account: { country: "CA", currency: "cad" }, payments: [{ transfer: "tr_int1" }],
    answers: { "Transfer.retrieve" => transfer("tr_int1", amount: 5000, amount_reversed: 4990), "Transfer.list" => list(transfer("tr_a")), "Transfer.create_reversal" => reversal("trr_a"),
               "Refund.retrieve" => obj(id: "pyr_golden01", balance_transaction: "txn_golden01"), "BalanceTransaction.retrieve" => obj(id: "txn_golden01", net: -3000) }
  },
  "an internal payout transfer Stripe cannot retrieve falls through to the listed ones" => {
    account: { country: "CA", currency: "cad" }, payments: [{ transfer: "tr_int1" }],
    answers: { "Transfer.retrieve" => api_error("An error occurred on our side."), "Transfer.list" => list(transfer("tr_a")), "Transfer.create_reversal" => reversal("trr_a"),
               "Refund.retrieve" => obj(id: "pyr_golden01", balance_transaction: "txn_golden01"), "BalanceTransaction.retrieve" => obj(id: "txn_golden01", net: -3000) }
  },
  "an internal payout transfer Stripe cannot retrieve and no listed transfer" => {
    account: { country: "CA", currency: "cad" }, payments: [{ transfer: "tr_int1" }],
    answers: { "Transfer.retrieve" => api_error("An error occurred on our side."), "Transfer.list" => [list, list] }
  },
  "a transfer that cannot hold the fee is skipped" => {
    account: { country: "CA", currency: "cad" },
    answers: { "Transfer.list" => list(transfer("tr_small", amount: 50), transfer("tr_b", amount: 5000)), "Transfer.create_reversal" => reversal("trr_b"),
               "Refund.retrieve" => obj(id: "pyr_golden01", balance_transaction: "txn_golden01"), "BalanceTransaction.retrieve" => obj(id: "txn_golden01", net: -3000) }
  },
  "the fee is converted to the currency of the transfer" => {
    account: { country: "CA", currency: "cad" },
    answers: { "Transfer.list" => list(transfer("tr_eur", amount: 80, currency: "eur"), transfer("tr_usd", amount: 5000)), "Transfer.create_reversal" => reversal("trr_c"),
               "Refund.retrieve" => obj(id: "pyr_golden01", balance_transaction: "txn_golden01"), "BalanceTransaction.retrieve" => obj(id: "txn_golden01", net: -3000) }
  },
  "the first transfer is refused and the second is reversed" => {
    account: { country: "CA", currency: "cad" },
    answers: { "Transfer.list" => [list(transfer("tr_a"), transfer("tr_b")), list(transfer("tr_a", amount_reversed: 5000), transfer("tr_b"))],
               "Transfer.create_reversal" => [invalid_request("Cannot create a reversal for more than the amount remaining to reverse (0)."), reversal("trr_b")],
               "Transfer.list_reversals" => list, "Refund.retrieve" => obj(id: "pyr_golden01", balance_transaction: "txn_golden01"), "BalanceTransaction.retrieve" => obj(id: "txn_golden01", net: -3000) }
  },
  "a refused reversal that Stripe did record" => {
    account: { country: "CA", currency: "cad" },
    answers: { "Transfer.list" => list(transfer("tr_a")),
               "Transfer.create_reversal" => invalid_request("Transfer tr_a is already fully reversed."),
               "Transfer.list_reversals" => list(reversal("trr_prior", refund_id: :refund)),
               "Refund.retrieve" => obj(id: "pyr_golden01", balance_transaction: "txn_golden01"), "BalanceTransaction.retrieve" => obj(id: "txn_golden01", net: -3000) }
  },
  "every transfer refuses the reversal" => {
    account: { country: "CA", currency: "cad" },
    answers: { "Transfer.list" => list(transfer("tr_a")),
               "Transfer.create_reversal" => invalid_request("Cannot create a reversal for more than the amount remaining to reverse (0)."),
               "Transfer.list_reversals" => list }
  },
  "no transfer to reverse" => { account: { country: "CA", currency: "cad" }, answers: { "Transfer.list" => list } },
  "a page of a hundred transfers none of which fits, then an empty one" => {
    account: { country: "CA", currency: "cad" },
    answers: { "Transfer.list" => [list(*Array.new(100) { |i| transfer("tr_s#{i}", amount: 10) }), list] }
  },
  "a lookup that fails" => { account: { country: "CA", currency: "cad" }, answers: { "Transfer.list" => api_error("An error occurred on our side.") } },
  "a reversal Stripe fails" => {
    account: { country: "CA", currency: "cad" },
    answers: { "Transfer.list" => list(transfer("tr_a")), "Transfer.create_reversal" => api_error("An error occurred on our side.") }
  },
  "a reversal refused for another reason" => {
    account: { country: "CA", currency: "cad" },
    answers: { "Transfer.list" => list(transfer("tr_a")), "Transfer.create_reversal" => invalid_request("No such transfer: 'tr_a'") }
  },
  "a reversal Stripe no longer supports" => {
    account: { country: "CA", currency: "cad" },
    answers: { "Transfer.list" => [list(transfer("tr_a")), list], "Transfer.create_reversal" => invalid_request("Reversals of this transfer are no longer supported."),
               "Transfer.create" => transfer("tr_grouped", amount: 5000) }
  },
  "a US account makes the grouped debit" => {
    account: { country: "US", currency: "usd" },
    answers: { "Transfer.list" => list, "Transfer.create" => transfer("tr_grouped", amount: 59, currency: "usd") }
  },
  "a US account adopts the grouped debit that exists" => {
    account: { country: "US", currency: "usd" },
    answers: { "Transfer.list" => list(transfer("tr_existing", amount: 59, currency: "usd")) }
  },
  "a US account whose debit Stripe refuses" => {
    account: { country: "US", currency: "usd" },
    answers: { "Transfer.list" => list, "Transfer.create" => invalid_request("Insufficient funds in Stripe account.") }
  },
  "a Canadian account when no collection is wanted and nothing exists" => {
    account: { country: "CA", currency: "cad" }, collect: false, answers: { "Transfer.list" => list }
  },
  "a Canadian account when no collection is wanted and a grouped debit exists" => {
    account: { country: "CA", currency: "cad" }, collect: false, answers: { "Transfer.list" => list(transfer("tr_existing", amount: 59, currency: "cad")) }
  },
  "a refund already collected" => {
    account: { country: "CA", currency: "cad" }, refund: { debited_stripe_transfer: "trr_done", fee_retention_collected_cents: 3000 }, answers: {}
  },
  "a refund whose collection is recorded without the cents, on a pinned transfer" => {
    account: { country: "CA", currency: "cad" }, refund: { debited_stripe_transfer: "trr_done", fee_retention_source_transfer: "tr_pin" },
    answers: { "Transfer.retrieve_reversal" => reversal("trr_done"), "Refund.retrieve" => obj(id: "pyr_golden01", balance_transaction: "txn_golden01"), "BalanceTransaction.retrieve" => obj(id: "txn_golden01", net: -2900) }
  },
  "a refund whose collection is recorded without the cents, on a grouped debit" => {
    account: { country: "US", currency: "usd" }, refund: { debited_stripe_transfer: "tr_done" }, answers: { "Transfer.retrieve" => transfer("tr_done", amount: 59, currency: "usd") }
  },
  "a refund already written off" => { account: { country: "CA", currency: "cad" }, refund: { fee_retention_written_off_at: "2026-11-01T00:00:00Z" }, answers: {} },
  "a pinned transfer that still has room" => {
    account: { country: "CA", currency: "cad" }, refund: { fee_retention_source_transfer: "tr_pin" },
    answers: { "Transfer.retrieve" => transfer("tr_pin", amount: 5000), "Transfer.list_reversals" => list, "Transfer.create_reversal" => reversal("trr_pin"),
               "Refund.retrieve" => obj(id: "pyr_golden01", balance_transaction: "txn_golden01"), "BalanceTransaction.retrieve" => obj(id: "txn_golden01", net: -3000) }
  },
  "a pinned transfer whose reversal Stripe already holds" => {
    account: { country: "CA", currency: "cad" }, refund: { fee_retention_source_transfer: "tr_pin" },
    answers: { "Transfer.retrieve" => transfer("tr_pin", amount: 5000, amount_reversed: 4990), "Transfer.list_reversals" => list(reversal("trr_prior", refund_id: :refund)),
               "Refund.retrieve" => obj(id: "pyr_golden01", balance_transaction: "txn_golden01"), "BalanceTransaction.retrieve" => obj(id: "txn_golden01", net: -2900) }
  },
  "a pinned transfer that is full and a grouped debit that exists" => {
    account: { country: "CA", currency: "cad" }, refund: { fee_retention_source_transfer: "tr_pin" },
    answers: { "Transfer.retrieve" => transfer("tr_pin", amount: 5000, amount_reversed: 4990), "Transfer.list_reversals" => list, "Transfer.list" => list(transfer("tr_existing", amount: 59, currency: "cad")) }
  },
  "a pinned transfer that is full and nothing else" => {
    account: { country: "CA", currency: "cad" }, refund: { fee_retention_source_transfer: "tr_pin" },
    answers: { "Transfer.retrieve" => transfer("tr_pin", amount: 5000, amount_reversed: 4990), "Transfer.list_reversals" => list, "Transfer.list" => list }
  },
  "a pinned transfer Stripe cannot retrieve" => {
    account: { country: "CA", currency: "cad" }, refund: { fee_retention_source_transfer: "tr_pin" }, answers: { "Transfer.retrieve" => api_error("An error occurred on our side.") }
  },
  "a Gumroad-held account" => { account: { country: "CA", currency: "cad" }, gumroad_held: true, answers: {} }
}.freeze

def run_collection(seller, product)
  COLLECTION_CASES.map do |name, spec|
    merchant_account = merchant_account_for(seller, **spec[:account])
    sale = { price_cents: 1000, total_transaction_cents: 1000, fee_cents: 100 }
    purchase = create_purchase(seller, product, merchant_account, sale)
    refund = create_refund(purchase)
    refund.update!(spec[:refund]) if spec[:refund]
    credit = Credit.new(user: seller, amount_cents: -59, merchant_account: spec[:gumroad_held] ? MerchantAccount.gumroad(StripeChargeProcessor.charge_processor_id) : merchant_account, fee_retention_refund: refund)
    credit.save!
    answers = spec[:answers].transform_values do |value|
      (value.is_a?(Array) ? value : [value]).map { |answer| answer.is_a?(Stripe::StripeObject) && answer.respond_to?(:metadata) && answer.metadata.to_h[:refund_id] == "refund" ? reversal(answer.id, refund_id: refund.id) : answer }
    end
    answers = answers.transform_values { |value| value.map { |a| a.is_a?(Stripe::ListObject) ? Stripe::ListObject.construct_from(object: "list", data: a.data.map { |d| d.respond_to?(:metadata) && d.metadata.to_h[:refund_id] == "refund" ? reversal(d.id, refund_id: refund.id) : d }, has_more: false) : a } }
    (spec[:payments] || []).each do |attributes|
      Payment.new(user: seller, state: "completed", processor: PayoutProcessorType::STRIPE, stripe_connect_account_id: merchant_account.charge_processor_merchant_id,
                  stripe_transfer_id: "po_golden", amount_cents: 100, currency: "usd", payout_period_end_date: Date.new(2026, 10, 1),
                  stripe_internal_transfer_id: attributes[:transfer]).save!(validate: false)
    end
    Trace.reset(answers)
    scripted = Trace::ANSWERS.transform_values { |queue| queue.map { serialise_answer(_1) } }
    outcome = begin
      { "returned" => StripeChargeProcessor.debit_stripe_account_for_refund_fee(credit: Credit.find(credit.id), collect: spec.fetch(:collect, true)) }
    rescue StandardError => e
      { "raised" => e.class.name, "message" => e.message }
    end
    refund.reload
    {
      "name" => name,
      "input" => {
        "account" => spec[:account].transform_keys(&:to_s), "refund" => (spec[:refund] || {}).transform_keys(&:to_s), "collect" => spec.fetch(:collect, true), "gumroad_held" => spec[:gumroad_held] == true,
        "holder_of_funds" => credit.merchant_account.holder_of_funds, "credit_amount_cents" => credit.amount_cents, "internal_transfer_ids" => (spec[:payments] || []).map { _1[:transfer] }
      },
      "answers" => scrub(scripted, refund),
      "events" => scrub(Trace::EVENTS, refund),
      "outcome" => outcome,
      "refund" => Trace.refund_snapshot(refund)
    }
  end
end

# A purchase with Gumroad tax refunded in full before, refunded again in part: the case reverse_excess_amount_from_stripe_transfer is for.
EXCESS_CASES = {
  "a USD transfer" => { transfer: { amount: 700 }, bt: { issued: -400, holding_currency: "usd", holding: -400 }, answers: { "Transfer.create_reversal" => reversal("trr_x", amount: 400, currency: "usd") } },
  "a CAD transfer to a CAD account" => { transfer: { amount: 700, currency: "cad" }, bt: { issued: -400, holding_currency: "cad", holding: -500 }, answers: { "Transfer.create_reversal" => reversal("trr_x", amount: 500) } },
  "a transfer in a third currency" => { transfer: { amount: 700, currency: "eur" }, bt: { issued: -400, holding_currency: "cad", holding: -500 }, answers: {} },
  "a reversal of this refund is already booked in part" => {
    transfer: { amount: 700, reversals: [{ id: "trr_p", amount: 150, currency: "usd", source_refund: "re_golden01" }] }, bt: { issued: -400, holding_currency: "usd", holding: -400 },
    answers: { "Transfer.create_reversal" => reversal("trr_x", amount: 250, currency: "usd") }
  },
  "a reversal of this refund already covers it" => {
    transfer: { amount: 700, reversals: [{ id: "trr_p", amount: 400, currency: "usd", source_refund: "re_golden01" }] }, bt: { issued: -400, holding_currency: "usd", holding: -400 }, answers: {}
  },
  "a reversal tagged with the refund by metadata" => {
    transfer: { amount: 700, reversals: [{ id: "trr_p", amount: 100, currency: "usd", source_refund: nil, metadata: { external_refund_reversal: "re_golden01" } }] }, bt: { issued: -400, holding_currency: "usd", holding: -400 },
    answers: { "Transfer.create_reversal" => reversal("trr_x", amount: 300, currency: "usd") }
  },
  "less room on the transfer than the excess" => {
    transfer: { amount: 700, amount_reversed: 500 }, bt: { issued: -400, holding_currency: "usd", holding: -400 }, answers: { "Transfer.create_reversal" => reversal("trr_x", amount: 200, currency: "usd") }
  },
  "no room on the transfer" => { transfer: { amount: 700, amount_reversed: 700 }, bt: { issued: -400, holding_currency: "usd", holding: -400 }, answers: {} },
  "a partial reversal of a CAD transfer" => {
    transfer: { amount: 700, currency: "cad", amount_reversed: 300 }, bt: { issued: -400, holding_currency: "cad", holding: -500 }, answers: { "Transfer.create_reversal" => reversal("trr_x", amount: 400) }
  },
  "an amount that is already fully reversed" => { transfer: { amount: 700 }, bt: { issued: -400, holding_currency: "usd", holding: -400 }, answers: { "Transfer.create_reversal" => invalid_request("Transfer tr_x is already fully reversed.") } },
  "a reversal refused for another reason" => { transfer: { amount: 700 }, bt: { issued: -400, holding_currency: "usd", holding: -400 }, answers: { "Transfer.create_reversal" => invalid_request("No such transfer: 'tr_x'") } },
  "a reversal Stripe fails" => { transfer: { amount: 700 }, bt: { issued: -400, holding_currency: "usd", holding: -400 }, answers: { "Transfer.create_reversal" => api_error("An error occurred on our side.") } },
  "a zero debit" => { transfer: { amount: 700 }, bt: { issued: 0, holding_currency: "usd", holding: 0 }, answers: {} },
  "no balance transaction for the seller" => { transfer: { amount: 700 }, bt: nil, answers: {} },
  "VAT not fully refunded" => { transfer: { amount: 700 }, bt: { issued: -400, holding_currency: "usd", holding: -400 }, prior_tax_cents: 40, answers: {} },
  "a Gumroad-held account" => { transfer: { amount: 700 }, bt: { issued: -400, holding_currency: "usd", holding: -400 }, gumroad_held: true, answers: {} }
}.freeze

def run_excess(seller, product, admin)
  EXCESS_CASES.map do |name, spec|
    merchant_account = merchant_account_for(seller, country: "CA", currency: "cad")
    purchase = create_purchase(seller, product, merchant_account, price_cents: 1000, total_transaction_cents: 1100, fee_cents: 100, gumroad_tax_cents: 100, stripe_partially_refunded: true)
    create_refund(purchase, total_transaction_cents: 100, amount_cents: 0, fee_cents: 0, gumroad_tax_cents: spec[:prior_tax_cents] || 100, processor_refund_id: "re_priorgolden#{rand(10**9)}")
    refund = create_refund(purchase, total_transaction_cents: 400, amount_cents: 400, fee_cents: 40, gumroad_tax_cents: 0)
    if spec[:bt]
      issued = BalanceTransaction::Amount.new(currency: "usd", gross_cents: spec[:bt][:issued], net_cents: spec[:bt][:issued])
      holding = BalanceTransaction::Amount.new(currency: spec[:bt][:holding_currency], gross_cents: spec[:bt][:holding], net_cents: spec[:bt][:holding])
      BalanceTransaction.create!(user: seller, merchant_account:, refund:, issued_amount: issued, holding_amount: holding, update_user_balance: false)
    end
    reversals = (spec[:transfer][:reversals] || []).map do |r|
      r = r.merge(source_refund: refund.processor_refund_id) if r[:source_refund]
      r = r.merge(metadata: { external_refund_reversal: refund.processor_refund_id }) if r.dig(:metadata, :external_refund_reversal)
      obj(r.merge(object: "transfer_reversal"))
    end
    answers = spec[:answers].merge(
      "Charge.retrieve" => obj(id: "ch_golden", transfer: "tr_golden"),
      "Transfer.retrieve" => transfer("tr_golden", **spec[:transfer].except(:reversals), reversals:),
      "Refund.retrieve" => obj(id: "pyr_golden01", balance_transaction: "txn_golden01"),
      "BalanceTransaction.retrieve" => obj(id: "txn_golden01", net: -(spec.dig(:bt, :holding) || 0).abs)
    )
    Trace.reset(answers)
    scripted = Trace::ANSWERS.transform_values { |queue| queue.map { serialise_answer(_1) } }
    purchase = Purchase.find(purchase.id)
    purchase.define_singleton_method(:merchant_account) { MerchantAccount.gumroad(StripeChargeProcessor.charge_processor_id) } if spec[:gumroad_held]
    credits_before = Credit.count
    outcome = begin
      { "returned" => purchase.send(:reverse_excess_amount_from_stripe_transfer, refund: Refund.find(refund.id)).then { _1.nil? ? nil : true } }
    rescue StandardError => e
      { "raised" => e.class.name, "message" => e.message }
    end
    credit = Credit.count > credits_before ? Credit.order(:id).last : nil
    {
      "name" => name,
      "input" => { "transfer" => JSON.parse(spec[:transfer].to_json), "balance_transaction" => spec[:bt] && spec[:bt].transform_keys(&:to_s), "prior_tax_cents" => spec[:prior_tax_cents] || 100, "gumroad_held" => spec[:gumroad_held] == true },
      "answers" => scripted,
      "events" => JSON.parse(Trace::EVENTS.to_json.gsub(/"idempotency_key":"[0-9a-f-]{36}"/, '"idempotency_key":"<uuid>"')),
      "outcome" => outcome,
      "credit" => credit && { "amount_cents" => credit.amount_cents, "balance_transaction" => amounts(BalanceTransaction.where(credit:).sole) }
    }
  end
end

DISPUTE_CASES = {
  "a full refund of the only purchase" => { purchases: [{ price: 1000, total: 1000 }], refunded: [true], transfers: [{ id: "tr_w", amount: 700, description: "Dispute dp_golden01 won" }] },
  "a partial refund" => { purchases: [{ price: 1000, total: 1000 }], refunded: [false], refunds: [{ total: 250, tax: 0 }], transfers: [{ id: "tr_w", amount: 700, description: "Dispute dp_golden01 won" }] },
  "a partial refund with some of the transfer already reversed" => {
    purchases: [{ price: 1000, total: 1000 }], refunded: [false], refunds: [{ total: 250, tax: 0 }], transfers: [{ id: "tr_w", amount: 700, amount_reversed: 100, description: "Dispute dp_golden01 won" }]
  },
  "a refund that is already reversed in full" => { purchases: [{ price: 1000, total: 1000 }], refunded: [true], transfers: [{ id: "tr_w", amount: 700, amount_reversed: 700, description: "Dispute dp_golden01 won" }] },
  "a refund of tax only" => { purchases: [{ price: 1000, total: 1100, tax: 100 }], refunded: [false], refunds: [{ total: 100, tax: 100 }], transfers: [{ id: "tr_w", amount: 700, description: "Dispute dp_golden01 won" }] },
  "a refund that did not debit the seller" => { purchases: [{ price: 1000, total: 1000 }], refunded: [true], refunds: [{ total: 1000, tax: 0, gumroad_funded: true }], transfers: [{ id: "tr_w", amount: 700, description: "Dispute dp_golden01 won" }] },
  "a transfer for another dispute" => { purchases: [{ price: 1000, total: 1000 }], refunded: [true], transfers: [{ id: "tr_w", amount: 700, description: "Dispute dp_other won" }] },
  "no transfer on the account" => { purchases: [{ price: 1000, total: 1000 }], refunded: [true], transfers: [] },
  "a dispute that was not won" => { purchases: [{ price: 1000, total: 1000 }], refunded: [true], unwon: true, transfers: [] },
  "a Gumroad-held account" => { purchases: [{ price: 1000, total: 1000 }], refunded: [true], gumroad_held: true, transfers: [] }
}.freeze

def run_dispute(seller, product)
  DISPUTE_CASES.map do |name, spec|
    merchant_account = merchant_account_for(seller, country: "CA", currency: "cad")
    purchase = create_purchase(seller, product, merchant_account, price_cents: spec[:purchases][0][:price], total_transaction_cents: spec[:purchases][0][:total], fee_cents: 100, tax_cents: 0, gumroad_tax_cents: spec[:purchases][0][:tax] || 0,
                                                                  stripe_refunded: spec[:refunded][0], stripe_partially_refunded: !spec[:refunded][0], chargeback_date: Time.utc(2026, 10, 1))
    purchase.update_attribute(:chargeback_reversed, true)
    dispute = FactoryBot.create(:dispute, purchase:, charge_processor_dispute_id: "dp_golden01")
    dispute.update_columns(state: "won", won_at: spec[:unwon] ? nil : Time.utc(2026, 10, 20))
    (spec[:refunds] || [{ total: spec[:purchases][0][:total], tax: 0 }]).each_with_index do |r, i|
      create_refund(purchase, total_transaction_cents: r[:total], amount_cents: r[:total] - r[:tax], fee_cents: 0, gumroad_tax_cents: r[:tax]).tap do |refund|
        refund.update!(gumroad_funded: true) if r[:gumroad_funded]
      end
    end
    refund = Refund.where(purchase_id: purchase.id).order(:id).last
    answers = { "Transfer.list" => list(*spec[:transfers].map { transfer(_1[:id], amount: _1[:amount], amount_reversed: _1[:amount_reversed] || 0, description: _1[:description]) }),
                "Transfer.create_reversal" => reversal("trr_w", amount: 1, currency: "usd") }
    Trace.reset(answers)
    scripted = Trace::ANSWERS.transform_values { |queue| queue.map { serialise_answer(_1) } }
    purchase = Purchase.find(purchase.id)
    purchase.define_singleton_method(:merchant_account) { MerchantAccount.gumroad(StripeChargeProcessor.charge_processor_id) } if spec[:gumroad_held]
    outcome = begin
      purchase.send(:reverse_the_transfer_made_for_dispute_win!, refund: Refund.find(refund.id))
      { "returned" => true }
    rescue StandardError => e
      { "raised" => e.class.name, "message" => e.message }
    end
    {
      "name" => name,
      "input" => JSON.parse(spec.except(:transfers).merge(transfers: spec[:transfers]).to_json),
      "answers" => scripted,
      "events" => JSON.parse(Trace::EVENTS.to_json),
      "outcome" => outcome
    }
  end
end

results = nil
ActiveRecord::Base.transaction do
  travel_to(NOW) do
    currencies = Redis::Namespace.new(:currencies, redis: $redis)
    RATES.each { |currency, rate| currencies.set(currency, rate) }
    seller = FactoryBot.create(:user)
    product = FactoryBot.create(:product, user: seller)
    admin = FactoryBot.create(:admin_user)
    Object.send(:remove_const, :GUMROAD_ADMIN_ID)
    Object.const_set(:GUMROAD_ADMIN_ID, admin.id)
    MerchantAccount.find_or_create_by!(user_id: nil, charge_processor_id: StripeChargeProcessor.charge_processor_id) { _1.charge_processor_alive_at = Time.current }
    results = {
      "now" => NOW.iso8601, "rates" => RATES,
      "retention" => run_retention(seller, product),
      "collection" => run_collection(seller, product),
      "excess" => run_excess(seller, product, admin),
      "dispute" => run_dispute(seller, product)
    }
  end
  raise ActiveRecord::Rollback
end

File.write(OUT, "#{JSON.pretty_generate(JSON.parse(JSON.generate(results).gsub(/acct_golden\d+/, ACCOUNT_ID).gsub(/re_priorgolden\d+/, "re_golden_prior").gsub(/re_golden\d+/, "re_golden01")))}\n")
puts "wrote #{OUT} (#{results.values.grep(Array).sum(&:size)} cases)"
