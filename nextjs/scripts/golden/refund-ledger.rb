# frozen_string_literal: true

# Produces nextjs/src/server/models/__fixtures__/refund-ledger.golden.json: the arithmetic of a refund, run by the real Purchase on rows
# inserted inside a transaction that is rolled back. For each case it records
#   - Purchase#refund!'s choice between a full refund, a partial one and a refusal (refund_and_save! is stubbed to note its arguments),
#   - the Refund Purchase#build_refund builds (full, rest-of-a-partial, partial) and the flags refund_purchase! sets,
#   - how decrement_balance_for_refund_or_chargeback! splits the refund between the seller and the affiliate (the two balance writers
#     are stubbed to note their arguments, so no balance row is touched).
# No Stripe call is made. Run it against any scratch test database:
#
#   RAILS_ENV=test DISABLE_SPRING=1 DISABLE_TEST_REDIS_ISOLATION=1 bundle exec rails runner nextjs/scripts/golden/refund-ledger.rb
require "json"
require "factory_bot_rails"

OUT = Rails.root.join("nextjs/src/server/models/__fixtures__/refund-ledger.golden.json")
REFUNDING_USER_ID = 4242
Rails.logger = ActiveSupport::Logger.new(nil)
FactoryBot.definition_file_paths = [Rails.root.join("spec/support/factories").to_s]
FactoryBot.find_definitions

PRICE_ONLY = { price_cents: 100, total_transaction_cents: 100, fee_cents: 30 }.freeze

# name => purchase columns, prior refunds, affiliate credit, and what to ask of it
CASES = {
  "a plain sale" => { purchase: PRICE_ONLY },
  "a sale with seller tax" => { purchase: { price_cents: 1000, total_transaction_cents: 1100, fee_cents: 129, tax_cents: 100 } },
  "a sale with Gumroad tax" => { purchase: { price_cents: 1000, total_transaction_cents: 1100, fee_cents: 129, gumroad_tax_cents: 100 } },
  "a sale with an odd fee" => { purchase: { price_cents: 333, total_transaction_cents: 333, fee_cents: 77 } },
  "a sale refunded in part before" => {
    purchase: PRICE_ONLY.merge(stripe_partially_refunded: true),
    prior: [{ total_transaction_cents: 40, amount_cents: 40, fee_cents: 12, creator_tax_cents: 0, gumroad_tax_cents: 0 }]
  },
  "a sale refunded in part twice before" => {
    purchase: PRICE_ONLY.merge(stripe_partially_refunded: true),
    prior: [{ total_transaction_cents: 25, amount_cents: 25, fee_cents: 7, creator_tax_cents: 0, gumroad_tax_cents: 0 },
            { total_transaction_cents: 25, amount_cents: 25, fee_cents: 7, creator_tax_cents: 0, gumroad_tax_cents: 0 }]
  },
  "a sale with Gumroad tax refunded separately before" => {
    purchase: { price_cents: 1000, total_transaction_cents: 1100, fee_cents: 129, gumroad_tax_cents: 100 },
    prior: [{ total_transaction_cents: 100, amount_cents: 0, fee_cents: 0, creator_tax_cents: 0, gumroad_tax_cents: 100 }]
  },
  "a sale with most of the Gumroad tax refunded separately before" => {
    purchase: { price_cents: 1000, total_transaction_cents: 1100, fee_cents: 129, gumroad_tax_cents: 100 },
    prior: [{ total_transaction_cents: 90, amount_cents: 0, fee_cents: 0, creator_tax_cents: 0, gumroad_tax_cents: 90 }]
  },
  "a sale with a failed refund that was reversed" => {
    purchase: PRICE_ONLY,
    prior: [{ total_transaction_cents: 100, amount_cents: 100, fee_cents: 30, creator_tax_cents: 0, gumroad_tax_cents: 0, status: "failed", json_data: { balance_reversed_on_failure: true } }]
  },
  "a sale with a failed refund that was not reversed" => {
    purchase: PRICE_ONLY.merge(stripe_partially_refunded: true),
    prior: [{ total_transaction_cents: 60, amount_cents: 60, fee_cents: 18, creator_tax_cents: 0, gumroad_tax_cents: 0, status: "failed" }]
  },
  "an affiliate sale" => {
    purchase: { price_cents: 1000, total_transaction_cents: 1000, fee_cents: 129, affiliate_credit_cents: 174 },
    credit: { amount_cents: 174, fee_cents: 26, basis_points: 2000 }
  },
  "an affiliate sale refunded in part before" => {
    purchase: { price_cents: 1000, total_transaction_cents: 1000, fee_cents: 129, affiliate_credit_cents: 174, stripe_partially_refunded: true },
    credit: { amount_cents: 174, fee_cents: 26, basis_points: 2000 },
    prior: [{ total_transaction_cents: 300, amount_cents: 300, fee_cents: 38, creator_tax_cents: 0, gumroad_tax_cents: 0 }]
  },
  "an affiliate sale whose credit has no fee" => {
    purchase: { price_cents: 500, total_transaction_cents: 500, fee_cents: 0, affiliate_credit_cents: 75 },
    credit: { amount_cents: 75, fee_cents: 0, basis_points: 1500 }
  }
}.freeze

# gross refund amounts asked of each case's build_refund / decrement, and the `amount` strings asked of refund!
GROSS_AMOUNTS = [1, 33, 40, 50, 60, 99, 100, 250, 1000, 1100].freeze
AMOUNT_STRINGS = [nil, "", "0.40", "0.5", "1", "1.00", "1.01", "10.10", "7.77", "0.01", "100", "0"].freeze

def refund_attributes(refund)
  return nil if refund.nil?

  %i[total_transaction_cents amount_cents fee_cents creator_tax_cents gumroad_tax_cents refunding_user_id].index_with { |name| refund.public_send(name) }
end

def create_purchase(seller, product, merchant_account, spec)
  purchase = FactoryBot.build(:purchase, link: product, seller:, email: "buyer@example.com", purchase_state: "successful", tax_cents: 0,
                                         charge_processor_id: StripeChargeProcessor.charge_processor_id, merchant_account:,
                                         stripe_transaction_id: "ch_golden", **spec[:purchase])
  purchase.save!(validate: false)
  purchase.update_columns(**spec[:purchase])
  (spec[:prior] || []).each do |attributes|
    json_data = attributes[:json_data]
    refund = Refund.new(purchase:, link_id: product.id, seller_id: seller.id, **attributes.except(:json_data))
    refund.json_data = json_data if json_data
    refund.save!(validate: false)
  end
  if spec[:credit]
    affiliate_user = FactoryBot.create(:affiliate_user)
    affiliate = FactoryBot.create(:direct_affiliate, seller:, affiliate_user:)
    purchase.update_columns(affiliate_id: affiliate.id)
    AffiliateCredit.new(purchase:, affiliate:, affiliate_user:, seller:, link: product, **spec[:credit]).save!(validate: false)
  end
  Purchase.find(purchase.id)
end

# refund_purchase!'s first lines: the flags, then the refund built from them.
def build(purchase, gross)
  purchase.stripe_refunded = (purchase.gross_amount_refunded_cents + gross) >= purchase.total_transaction_cents
  purchase.stripe_partially_refunded = !purchase.stripe_refunded
  refund = purchase.build_refund(gross_refund_amount: gross, refunding_user_id: REFUNDING_USER_ID)
  [refund, { "stripe_refunded" => purchase.stripe_refunded, "stripe_partially_refunded" => purchase.stripe_partially_refunded }]
end

def split(purchase, refund)
  calls = []
  purchase.define_singleton_method(:process_refund_or_chargeback_for_affiliate_credit_balance) do |_flow, refund: nil, dispute: nil, refund_cents: 0, fee_cents: 0, credit: nil|
    calls << { "writer" => "affiliate", "refund_cents" => refund_cents, "fee_cents" => fee_cents }
  end
  purchase.define_singleton_method(:process_refund_or_chargeback_for_purchase_balance) do |_flow, refund: nil, dispute: nil, refund_cents: 0|
    calls << { "writer" => "seller", "refund_cents" => refund_cents }
  end
  purchase.decrement_balance_for_refund_or_chargeback!(nil, refund:)
  calls
end

def dispatch(purchase, amount)
  seen = nil
  purchase.define_singleton_method(:refund_and_save!) do |user_id, amount_cents: nil, is_for_fraud: false, reason: nil|
    seen = { "amount_cents" => amount_cents }
    true
  end
  result = purchase.refund!(refunding_user_id: REFUNDING_USER_ID, amount:)
  { "result" => result, "refund_and_save" => seen, "errors" => purchase.errors.full_messages }
end

results = []
ActiveRecord::Base.transaction do
  seller = FactoryBot.create(:user)
  product = FactoryBot.create(:product, user: seller)
  merchant_account = MerchantAccount.find_or_create_by!(user_id: nil, charge_processor_id: StripeChargeProcessor.charge_processor_id) { _1.charge_processor_alive_at = Time.current }

  CASES.each do |name, spec|
    purchase = create_purchase(seller, product, merchant_account, spec)
    input = {
      "purchase" => purchase.attributes.slice("price_cents", "total_transaction_cents", "fee_cents", "tax_cents", "gumroad_tax_cents", "affiliate_credit_cents", "stripe_partially_refunded"),
      "prior_refunds" => purchase.refunds.order(:id).map { |r| r.attributes.slice("total_transaction_cents", "amount_cents", "fee_cents", "creator_tax_cents", "gumroad_tax_cents", "status").merge("balance_reversed_on_failure" => r.balance_reversed_on_failure == true) },
      "affiliate_credit" => purchase.affiliate_credit&.attributes&.slice("amount_cents", "fee_cents", "basis_points")
    }
    builds = GROSS_AMOUNTS.map do |gross|
      fresh = Purchase.find(purchase.id)
      refund, flags = build(fresh, gross)
      entry = { "gross" => gross, "refund" => refund_attributes(refund), "flags" => flags }
      entry["split"] = split(fresh, refund) if refund
      entry
    end
    dispatches = AMOUNT_STRINGS.map { |amount| { "amount" => amount }.merge(dispatch(Purchase.find(purchase.id), amount)) }
    results << { "name" => name, "input" => input, "builds" => builds, "dispatches" => dispatches,
                 "refundable" => { "amount" => purchase.amount_refundable_cents, "gross" => purchase.gross_amount_refundable_cents } }
  end
  raise ActiveRecord::Rollback
end

File.write(OUT, JSON.pretty_generate({ "refunding_user_id" => REFUNDING_USER_ID, "cases" => results }) + "\n")
puts "wrote #{results.size} cases to #{OUT}"
