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

OUT = Pathname(ENV.fetch("OUT", Rails.root.join("nextjs/src/server/models/__fixtures__/refund-purchase-body.golden.json").to_s))
ONLY = ENV["ONLY"] && Regexp.new(ENV["ONLY"]) # regenerate only the cases whose name matches, into OUT
REFUNDING_USER_ID = 77
AFFILIATE_CREDIT_CENTS = 14

class StopGolden < StandardError; end

# A "full" case runs refund_purchase! to its end and marks each tail step; the others stop at the webhook, where the raise rolls back.
$full = false
TAIL_STEPS = %i[send_refunded_notification_webhook update_creator_analytics_cache send_to_elasticsearch enqueue_update_sales_related_products_infos_job
                disable_attached_license_if_fully_refunded!].freeze
Purchase.prepend(Module.new do
  TAIL_STEPS.each do |step|
    define_method(step) do |*args, **kwargs, &block|
      raise StopGolden if step == :send_refunded_notification_webhook && !$full
      return super(*args, **kwargs, &block) unless $full

      marker("tail", "#{step}:start")
      super(*args, **kwargs, &block).tap { marker("tail", "#{step}:end") }
    end
  end
  private :send_refunded_notification_webhook
end)
[CustomerMailer, ContactingCreatorMailer].each do |mailer|
  mailer.singleton_class.prepend(Module.new do
    %i[refund partial_refund purchase_refunded].each do |name|
      next unless mailer.respond_to?(name)

      define_method(name) do |*args|
        marker("tail", "#{mailer}.#{name}") if $full
        super(*args)
      end
    end
  end)
end

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

def seed_vat_refund(purchase, cents: 100)
  Refund.new(purchase:, link_id: purchase.link_id, seller_id: purchase.seller_id, processor_refund_id: "re_golden_vat", status: "succeeded",
             total_transaction_cents: cents, amount_cents: 0, fee_cents: 0, creator_tax_cents: 0, gumroad_tax_cents: cents,
             created_at: SEEDED_AT, updated_at: SEEDED_AT).tap { _1.save!(validate: false) }
end

# Another purchase of the same product, saved without validation like the sale itself.
def seed_sibling_purchase(purchase, **attributes)
  build(:purchase, link: purchase.link, seller: purchase.seller, price_cents: 0, displayed_price_cents: 0, total_transaction_cents: 0,
                   purchase_state: "successful", succeeded_at: SEEDED_AT, charge_processor_id: nil, created_at: SEEDED_AT, updated_at: SEEDED_AT, **attributes).tap { _1.save!(validate: false) }
end

# `gift: :missing` marks the sale as a gift's sender with no gift row, anything else adds the row and its giftee purchase.
def seed_gift(purchase, row: true)
  purchase.update_columns(flags: purchase.flags | Purchase.flag_mapping["flags"][:is_gift_sender_purchase])
  return unless row

  giftee = seed_sibling_purchase(purchase, purchase_state: "gift_receiver_purchase_successful", is_gift_receiver_purchase: true, stripe_transaction_id: nil, stripe_fingerprint: nil)
  Gift.new(link: purchase.link, gifter_purchase: purchase, giftee_purchase: giftee, gifter_email: purchase.email, giftee_email: giftee.email,
           state: "successful", created_at: SEEDED_AT, updated_at: SEEDED_AT).save!(validate: false)
end

# A membership's subscription row; `cancelled_at` makes it a pending cancellation, `free_trial_ends_at` a trial.
def seed_subscription(purchase, cancelled_at: nil, free_trial_ends_at: nil)
  buyer = create(:user, created_at: SEEDED_AT, updated_at: SEEDED_AT)
  subscription = create(:subscription, link: purchase.link, user: buyer, cancelled_at:, free_trial_ends_at:, created_at: SEEDED_AT, updated_at: SEEDED_AT)
  purchase.update_columns(subscription_id: subscription.id, flags: purchase.flags | Purchase.flag_mapping["flags"][:is_original_subscription_purchase])
end

def seed_bundle_product_purchase(purchase)
  purchase.update_columns(flags: purchase.flags | Purchase.flag_mapping["flags"][:is_bundle_purchase])
  product_purchase = seed_sibling_purchase(purchase, is_bundle_product_purchase: true, stripe_transaction_id: nil, stripe_fingerprint: nil)
  BundleProductPurchase.new(bundle_purchase: purchase, product_purchase:, created_at: SEEDED_AT, updated_at: SEEDED_AT).save!(validate: false)
end

# A sold purchase, booked the way checkout books it (the real increment_sellers_balance!), with `prior` refunds on it ([amount, fee] pairs;
# the sale then reads as partially refunded). `affiliate:` credits a direct affiliate of the seller.
def refundable_sale(prior: [], prior_vat: false, vat_left: 0, affiliate: false, account: :gumroad, gift: nil, subscription: nil, bundle: 0, license: false, **options)
  sale(account:, **options) do |purchase, seller, merchant_account|
    if affiliate
      direct = create(:direct_affiliate, seller:, affiliate_user: create(:user, created_at: SEEDED_AT, updated_at: SEEDED_AT), created_at: SEEDED_AT, updated_at: SEEDED_AT)
      purchase.update_columns(affiliate_id: direct.id, affiliate_credit_cents: AFFILIATE_CREDIT_CENTS)
    end
    purchase.flow_of_funds = flow
    purchase.increment_sellers_balance! unless account == :seller_connect
    purchase = Purchase.find(purchase.id)
    prior.each { |amount_cents, fee_cents| seed_refund(purchase, amount_cents:, fee_cents:) }
    if prior_vat
      # the credit for a refund that carries no VAT is booked to Gumroad's own account
      MerchantAccount.create!(charge_processor_id: "stripe", charge_processor_merchant_id: "acct_platform", charge_processor_alive_at: SEEDED_AT) unless account == :gumroad
      seed_vat_refund(purchase, cents: 100 - vat_left)
    end
    purchase.update_columns(stripe_partially_refunded: true) if prior.any?
    seed_gift(purchase, row: gift != :missing) if gift
    seed_subscription(purchase, **subscription) if subscription
    bundle.times { seed_bundle_product_purchase(purchase) }
    License.new(purchase:, link: purchase.link, serial: "GOLDEN-LICENSE-SERIAL", created_at: SEEDED_AT, updated_at: SEEDED_AT).save!(validate: false) if license
    yield purchase, seller, merchant_account if block_given?
  end
end

StripeRefund = Struct.new(:id, :status)

def run_case(name, seed:, issued: 500, stripe_refund: nil, is_for_fraud: false, note: nil, gumroad_funded: false, balance_reconciliation_needed: false, full: false)
  return if ONLY && name !~ ONLY

  warn "case: #{name}"
  $random_seq = 0
  $full = full
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
               "stripe_refund" => stripe_refund && { "id" => stripe_refund.id, "status" => stripe_refund.status }, "full" => full)
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

cases << run_case("a partial refund of a sale that charged a Gumroad VAT", seed: refundable_sale(account: :seller_connect, gumroad_tax_cents: 100, total_transaction_cents: 600), issued: 300)
cases << run_case("a partial refund of a sale that charged a Gumroad VAT, held by Gumroad", seed: refundable_sale(gumroad_tax_cents: 100, total_transaction_cents: 600), issued: 300)
cases << run_case("the rest of a sale whose VAT was refunded on its own", seed: refundable_sale(account: :seller_connect, gumroad_tax_cents: 100, total_transaction_cents: 600, prior_vat: true), issued: 500)
cases << run_case("a partial refund of a sale whose VAT was refunded on its own", seed: refundable_sale(account: :seller_connect, gumroad_tax_cents: 100, total_transaction_cents: 600, prior_vat: true), issued: 200)
cases << run_case("a partial refund of a sale whose VAT was refunded on its own, held by Gumroad", seed: refundable_sale(gumroad_tax_cents: 100, total_transaction_cents: 600, prior_vat: true), issued: 200)
cases << run_case("a partial refund of a sale whose VAT was refunded on its own, on an account Gumroad manages", seed: refundable_sale(account: :seller_managed, gumroad_tax_cents: 100, total_transaction_cents: 600, prior_vat: true), issued: 200)
cases << run_case("a refund for fraud of a sale whose VAT was refunded on its own, on an account Gumroad manages", seed: refundable_sale(account: :seller_managed, gumroad_tax_cents: 100, total_transaction_cents: 600, prior_vat: true), issued: 200, is_for_fraud: true)
cases << run_case("the rest of a sale whose VAT was refunded on its own, on an account Gumroad manages, for fraud", seed: refundable_sale(account: :seller_managed, gumroad_tax_cents: 100, total_transaction_cents: 600, prior_vat: true), issued: 500, is_for_fraud: true)
cases << run_case("a refund Gumroad funds of a sale whose VAT was refunded on its own, on an account Gumroad manages", seed: refundable_sale(account: :seller_managed, gumroad_tax_cents: 100, total_transaction_cents: 600, prior_vat: true), issued: 200, gumroad_funded: true, note: "Goodwill")
cases << run_case("a partial refund of a sale with one cent of VAT left", seed: refundable_sale(account: :seller_connect, gumroad_tax_cents: 100, total_transaction_cents: 600, prior_vat: true, vat_left: 1), issued: 200)
cases << run_case("a refund Gumroad funds of a sale whose VAT was refunded on its own, on a Connect account", seed: refundable_sale(account: :seller_connect, gumroad_tax_cents: 100, total_transaction_cents: 600, prior_vat: true), issued: 200, gumroad_funded: true, note: "Goodwill")
cases << run_case("a partial refund for fraud on an account Gumroad manages", seed: refundable_sale(account: :seller_managed), issued: 200, is_for_fraud: true)
cases << run_case("a refund of one cent", seed: refundable_sale, issued: 1)
cases << run_case("a refund Gumroad funds on a Connect sale books no VAT credit", seed: refundable_sale(account: :seller_connect, gumroad_tax_cents: 100, total_transaction_cents: 600), issued: 600, gumroad_funded: true, note: "Goodwill")
cases << run_case("a refund that needs a balance reconciliation on a Connect sale books no VAT credit", seed: refundable_sale(account: :seller_connect, gumroad_tax_cents: 100, total_transaction_cents: 600), issued: 600, balance_reconciliation_needed: true)

cases << run_case("a refund of a gift's sender marks the giftee's purchase refunded", seed: refundable_sale(gift: true))
cases << run_case("a partial refund of a gift's sender marks the giftee's purchase partially refunded", seed: refundable_sale(gift: true), issued: 200)
cases << run_case("a refund of a gift's sender with no gift row", seed: refundable_sale(gift: :missing))
cases << run_case("a refund of a membership's first charge", seed: refundable_sale(subscription: {}))
cases << run_case("a partial refund of a membership's first charge", seed: refundable_sale(subscription: {}), issued: 200)
cases << run_case("a refund of a membership charge in its free trial", seed: refundable_sale(subscription: { free_trial_ends_at: SEEDED_AT + 7.days }))
cases << run_case("a refund of a membership charge pending cancellation", seed: refundable_sale(subscription: { cancelled_at: SEEDED_AT + 7.days }))
cases << run_case("a refund of a bundle marks its product purchases refunded", seed: refundable_sale(bundle: 2))
cases << run_case("a partial refund of a bundle marks its product purchases partially refunded", seed: refundable_sale(bundle: 2), issued: 200)

# The same method to its end (webhook, mail, analytics cache, index, related products, fraud check, licence), committed.
TAIL_OUT = OUT.dirname.join("refund-purchase-tail.golden.json")
tail_cases = []
tail_cases << run_case("a full refund to the end", seed: refundable_sale, full: true)
tail_cases << run_case("a partial refund to the end", seed: refundable_sale, issued: 200, full: true)
tail_cases << run_case("the rest of a partially refunded sale to the end", seed: refundable_sale(prior: [[200, 58]]), issued: 300, full: true)
tail_cases << run_case("a refund for fraud to the end", seed: refundable_sale, is_for_fraud: true, full: true)
tail_cases << run_case("a refund of a sale with a licence to the end", seed: refundable_sale(license: true), full: true)
tail_cases << run_case("a partial refund of a sale with a licence to the end", seed: refundable_sale(license: true), issued: 200, full: true)
tail_cases << run_case("a refund of a gift's sender to the end", seed: refundable_sale(gift: true, license: true), full: true)
tail_cases << run_case("a refund of a bundle to the end", seed: refundable_sale(bundle: 2), full: true)
tail_cases << run_case("a refund Gumroad funds to the end", seed: refundable_sale, gumroad_funded: true, note: "Goodwill", full: true)
tail_cases << run_case("a refund of a sale on the seller's own Connect account to the end", seed: refundable_sale(account: :seller_connect), full: true)
tail_cases << run_case("a refund of a membership's first charge to the end", seed: refundable_sale(subscription: {}), full: true)
tail_cases << run_case("a refund of a membership charge in its free trial to the end", seed: refundable_sale(subscription: { free_trial_ends_at: SEEDED_AT + 7.days }), full: true)

File.write(OUT, JSON.pretty_generate({ "now" => NOW.iso8601(3), "cases" => cases.compact }) + "\n")
File.write(TAIL_OUT, JSON.pretty_generate({ "now" => NOW.iso8601(3), "cases" => tail_cases.compact }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.compact.size} cases) and #{TAIL_OUT.relative_path_from(Rails.root)} (#{tail_cases.compact.size} cases)"
