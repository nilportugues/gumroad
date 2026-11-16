# frozen_string_literal: true

# Writes nextjs/src/server/models/__fixtures__/refund-vat-exclusive-credit.golden.json: Credit.create_for_vat_exclusive_refund!(refund:) as the
# real class runs it for a Stripe Connect sale (the negative credit on Gumroad's account that takes back the Gumroad share of a VAT that was
# refunded apart from the sale: its comment, its balance transaction and the Balance it lands on), against a scratch database, with every
# statement the mysql2 driver sent recorded between the "vat" markers. Nothing here reaches Stripe.
#
#   RAILS_ENV=test DATABASE_NAME=gumroad_test_28 TEST_DATABASE_NAME=gumroad_test_28 DISABLE_TEST_REDIS_ISOLATION=1 \
#     REDIS_HOST=redis:6379/45 SIDEKIQ_REDIS_HOST=redis:6379/46 RPUSH_REDIS_HOST=redis:6379/47 \
#     RACK_ATTACK_REDIS_HOST=redis:6379/48 DISABLE_SPRING=1 bundle exec rails runner nextjs/scripts/golden/refund-vat-exclusive-credit.rb
require_relative "support/paid_sale"

OUT = Rails.root.join("nextjs/src/server/models/__fixtures__/refund-vat-exclusive-credit.golden.json")
SALE_DAY = Date.new(2026, 11, 1)

# The refund refund_purchase! appended: inserted, nothing else of the method has run.
def seed_refund(purchase, amount_cents:, total_transaction_cents: amount_cents, gumroad_tax_cents: 0)
  Refund.new(purchase:, link_id: purchase.link_id, seller_id: purchase.seller_id, processor_refund_id: "re_golden01", status: "succeeded",
             total_transaction_cents:, amount_cents:, fee_cents: 0, creator_tax_cents: 0, gumroad_tax_cents:,
             created_at: SEEDED_AT, updated_at: SEEDED_AT).save!(validate: false)
end

# The purchase save recomputes fee_cents and resets affiliate_credit_cents, so the figures under test are written after it.
def vat_sale(refund: {}, fee_cents: 145, affiliate_credit_cents: 0, **options)
  sale(account: :seller_connect, **options) do |purchase, seller, merchant_account|
    purchase.update_columns(fee_cents:, affiliate_credit_cents:)
    MerchantAccount.create!(charge_processor_id: "stripe", charge_processor_merchant_id: "acct_platform", charge_processor_alive_at: SEEDED_AT)
    seed_refund(purchase, **{ amount_cents: 500 }.merge(refund))
    yield purchase, seller, merchant_account if block_given?
  end
end

def run_case(name, seed:)
  warn "case: #{name}"
  $random_seq = 0
  created = nil
  result = capture(name, now: NOW, tables: $dirty, seed:) do
    purchase = Purchase.find(1)
    purchase.link.user
    purchase.seller
    purchase.merchant_account
    refund = Refund.find(1)
    refund.purchase = purchase # refund_purchase! appended it to this purchase
    marker("vat", "start")
    begin
      created = Credit.create_for_vat_exclusive_refund!(refund:)
    ensure
      marker("vat", "end")
    end
  end
  c = ActiveRecord::Base.connection
  $dirty = ALL_TABLES.reject { c.select_value("SELECT 1 FROM #{c.quote_table_name(_1)} LIMIT 1").nil? }
  result.merge("credit_id" => created&.id, "credit_balance_id" => created&.balance_id, "credit_amount_cents" => created&.amount_cents)
end

warn "seeding"
vat = { gumroad_tax_cents: 100, total_transaction_cents: 600 }
cases = []
cases << run_case("a VAT refunded apart from the sale takes back the Gumroad share it did not return", seed: vat_sale(**vat))
cases << run_case("the affiliate share counts in the Gumroad amount", seed: vat_sale(affiliate_credit_cents: 50, **vat))
cases << run_case("a partial refund takes back its share", seed: vat_sale(refund: { amount_cents: 200 }, **vat))
cases << run_case("a refund that returned the VAT writes nothing", seed: vat_sale(refund: { amount_cents: 500, total_transaction_cents: 600, gumroad_tax_cents: 100 }, **vat))
cases << run_case("a sale that charged no VAT writes nothing", seed: vat_sale)
cases << run_case("a refund of nothing writes a credit of zero", seed: vat_sale(refund: { amount_cents: 500, total_transaction_cents: 0 }, **vat))
cases << run_case("the credit lands on the oldest open balance", seed: vat_sale(**vat) { |_, seller, _|
  platform = MerchantAccount.gumroad("stripe")
  unpaid_balance(seller, platform, date: SALE_DAY + 1)
  unpaid_balance(seller, platform, date: SALE_DAY - 2)
})

File.write(OUT, JSON.pretty_generate({ "now" => NOW.iso8601(3), "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
