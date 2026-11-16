# frozen_string_literal: true

# Writes nextjs/src/server/models/__fixtures__/refund-fee-retention-credit.golden.json: Credit.create_for_refund_fee_retention!(refund:) as the
# real class runs it right after refund_purchase! appended the refund (the credit that keeps the processor fee, or credits a Stripe Connect
# seller the application fee; the retained fee the refund records; its balance transaction and the Balance it lands on), against a scratch
# database, with every statement the mysql2 driver sent recorded between the "retention" markers. Stripe is never reached: the collection
# of a retained fee is Refund#recover_pending_fee_retention!, after commit, and is not run here.
#
#   RAILS_ENV=test DATABASE_NAME=gumroad_test_28 TEST_DATABASE_NAME=gumroad_test_28 DISABLE_TEST_REDIS_ISOLATION=1 \
#     REDIS_HOST=redis:6379/45 SIDEKIQ_REDIS_HOST=redis:6379/46 RPUSH_REDIS_HOST=redis:6379/47 \
#     RACK_ATTACK_REDIS_HOST=redis:6379/48 DISABLE_SPRING=1 bundle exec rails runner nextjs/scripts/golden/refund-fee-retention-credit.rb
require_relative "support/paid_sale"

OUT = Rails.root.join("nextjs/src/server/models/__fixtures__/refund-fee-retention-credit.golden.json")
SALE_DAY = Date.new(2026, 11, 1)

# The refund refund_purchase! appended: inserted, nothing else of the method has run.
def seed_refund(purchase, amount_cents: 500)
  Refund.new(purchase:, link_id: purchase.link_id, seller_id: purchase.seller_id, processor_refund_id: "re_golden01", status: "succeeded",
             total_transaction_cents: amount_cents, amount_cents:, fee_cents: 0, creator_tax_cents: 0, gumroad_tax_cents: 0,
             created_at: SEEDED_AT, updated_at: SEEDED_AT).save!(validate: false)
end

# The purchase save resets affiliate_credit_cents, so the share under test is written after it.
def retention_sale(refund_amount_cents: 500, platform: false, affiliate_credit_cents: 0, **options)
  sale(**options) do |purchase, seller, merchant_account|
    purchase.update_columns(affiliate_credit_cents:)
    MerchantAccount.create!(charge_processor_id: "stripe", charge_processor_merchant_id: "acct_platform", charge_processor_alive_at: SEEDED_AT) if platform
    seed_refund(purchase, amount_cents: refund_amount_cents)
    yield purchase, seller, merchant_account if block_given?
  end
end

def run_case(name, seed:, setup: nil)
  warn "case: #{name}"
  $random_seq = 0
  created = nil
  result = capture(name, now: NOW, tables: $dirty, seed:, setup:) do
    purchase = Purchase.find(1)
    purchase.link.user
    purchase.seller
    refund = Refund.find(1)
    refund.purchase = purchase # refund_purchase! appended it to this purchase
    marker("retention", "start")
    begin
      created = Credit.create_for_refund_fee_retention!(refund:)
    ensure
      marker("retention", "end")
    end
  end
  c = ActiveRecord::Base.connection
  $dirty = ALL_TABLES.reject { c.select_value("SELECT 1 FROM #{c.quote_table_name(_1)} LIMIT 1").nil? }
  result.merge("credit_id" => created&.id, "credit_balance_id" => created&.balance_id)
end

cad_rate = -> { Redis::Namespace.new(:currencies, redis: $redis).set("CAD", "1.35") }

warn "seeding"
cases = []
cases << run_case("a fee on a Gumroad-held sale is retained from the recorded processor fee", seed: retention_sale(processor_fee_cents: 45, processor_fee_cents_currency: "usd"))
cases << run_case("a fee on a Gumroad-held sale is retained from the standard rate when no processor fee was recorded", seed: retention_sale)
cases << run_case("a fee on a partial refund is retained in proportion", seed: retention_sale(refund_amount_cents: 200, processor_fee_cents: 45, processor_fee_cents_currency: "usd"))
cases << run_case("a fee that rounds to nothing is retained as zero", seed: retention_sale(refund_amount_cents: 1, processor_fee_cents: 1, processor_fee_cents_currency: "usd"))
cases << run_case("a retained fee lands on the oldest open balance", seed: retention_sale(processor_fee_cents: 45, processor_fee_cents_currency: "usd") { |_, seller, ma|
  unpaid_balance(seller, ma, date: SALE_DAY + 1)
  unpaid_balance(seller, ma, date: SALE_DAY - 2)
})
cases << run_case("a retained fee does not land on a paid balance", seed: retention_sale(processor_fee_cents: 45, processor_fee_cents_currency: "usd") { |_, seller, ma|
  unpaid_balance(seller, ma, date: SALE_DAY, state: "paid")
})
cases << run_case("a fee on a sale held in an account managed for the seller waits for its collection", seed: retention_sale(account: :seller_managed, processor_fee_cents: 45, processor_fee_cents_currency: "usd"))
cases << run_case("a zero fee on a managed account is not pending", seed: retention_sale(account: :seller_managed, refund_amount_cents: 1, processor_fee_cents: 1, processor_fee_cents_currency: "usd"))
cases << run_case("a fee on a managed account held in another currency is booked in it", seed: retention_sale(account: :seller_managed, managed_currency: "cad", processor_fee_cents: 45, processor_fee_cents_currency: "usd") { |_, seller, ma|
  Balance.create!(user: seller, merchant_account: ma, date: SALE_DAY, currency: "usd", holding_currency: "cad", amount_cents: 1000, holding_amount_cents: 1350)
}, setup: cad_rate)
cases << run_case("a Connect seller is credited the Gumroad tax of the refund", seed: retention_sale(account: :seller_connect, platform: true, gumroad_tax_cents: 100))
cases << run_case("a Connect seller is credited the affiliate share of a partial refund", seed: retention_sale(account: :seller_connect, platform: true, refund_amount_cents: 200, affiliate_credit_cents: 50))
cases << run_case("a Connect seller is credited the tax and the affiliate share together", seed: retention_sale(account: :seller_connect, platform: true, gumroad_tax_cents: 100, affiliate_credit_cents: 50) { |_, seller, _|
  unpaid_balance(seller, MerchantAccount.gumroad("stripe"), date: SALE_DAY)
})
cases << run_case("a Connect sale with no tax and no affiliate share writes nothing", seed: retention_sale(account: :seller_connect, platform: true))

File.write(OUT, JSON.pretty_generate({ "now" => NOW.iso8601(3), "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
