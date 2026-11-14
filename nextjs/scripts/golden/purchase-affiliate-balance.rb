# frozen_string_literal: true

# Writes nextjs/src/server/models/__fixtures__/purchase-affiliate-balance.golden.json: Purchase#increment_sellers_balance! for a sale
# that credits a direct affiliate (the affiliate's BalanceTransaction and Balance, the AffiliateCredit row, then the seller's share
# net of that credit), run by the real class against a scratch database with every statement the mysql2 driver sent and every
# Sidekiq push recorded between the "increment" markers. Stripe is never reached: the affiliate's payout stays on Gumroad's account
# (`using_gumroad_merchant_account_for_affiliate_user?` is always true), so no transfer and no registration mail follow.
#
#   RAILS_ENV=test DATABASE_NAME=gumroad_test_24 TEST_DATABASE_NAME=gumroad_test_24 DISABLE_TEST_REDIS_ISOLATION=1 \
#     REDIS_HOST=redis:6379/50 SIDEKIQ_REDIS_HOST=redis:6379/51 RPUSH_REDIS_HOST=redis:6379/52 \
#     RACK_ATTACK_REDIS_HOST=redis:6379/53 DISABLE_SPRING=1 bundle exec rails runner nextjs/scripts/golden/purchase-affiliate-balance.rb
require_relative "support/paid_sale"

OUT = Rails.root.join("nextjs/src/server/models/__fixtures__/purchase-affiliate-balance.golden.json")

def run_case(name, seed:, flow_of_funds: flow, **extra)
  warn "case: #{name}"
  $random_seq = 0
  in_memory = nil
  result = capture(name, now: NOW, tables: $dirty, seed:, flow_of_funds: flow_of_funds.to_h_for_golden) do
    purchase = Purchase.find(1)
    purchase.link.user
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
  result.merge("purchase_success_balance_id" => in_memory)
end

class FlowOfFunds
  def to_h_for_golden
    amount = ->(a) { a && { "currency" => a.currency, "cents" => a.cents } }
    { "issued" => amount.(issued_amount), "settled" => amount.(settled_amount), "gumroad" => amount.(gumroad_amount),
      "gross" => amount.(merchant_account_gross_amount), "net" => amount.(merchant_account_net_amount) }
  end
end

AFFILIATE_CREDIT_CENTS = 14 # 3% of $5, as the purchase's credit is sized at checkout

def affiliate_user = create(:user, created_at: SEEDED_AT, updated_at: SEEDED_AT)

# Seeds a sale credited to an affiliate of the seller; yields (purchase, seller, merchant_account, affiliate).
def affiliate_sale(kind: :direct_affiliate, credit_cents: AFFILIATE_CREDIT_CENTS, **affiliate_attributes)
  sale do |purchase, seller, merchant_account|
    affiliate = create(kind, seller:, affiliate_user:, created_at: SEEDED_AT, updated_at: SEEDED_AT, **affiliate_attributes)
    purchase.update_columns(affiliate_id: affiliate.id, affiliate_credit_cents: credit_cents)
    yield purchase, seller, merchant_account, affiliate if block_given?
  end
end

def usd(gross, net) = BalanceTransaction::Amount.new(currency: "usd", gross_cents: gross, net_cents: net)

cases = []
cases << run_case("a sale credits the affiliate's share and the seller keeps the rest", seed: affiliate_sale)
cases << run_case("a sale lands on the affiliate's open balance of the same day", seed: affiliate_sale { |_, _, ma, affiliate|
  Balance.create!(user: affiliate.affiliate_user, merchant_account: ma, date: SEEDED_AT.to_date, currency: "usd", holding_currency: "usd", amount_cents: 1000, holding_amount_cents: 1000)
})
cases << run_case("an affiliate with a booked transaction on the purchase reuses its balance", seed: affiliate_sale { |purchase, _, ma, affiliate|
  balance = Balance.create!(user: affiliate.affiliate_user, merchant_account: ma, date: SEEDED_AT.to_date - 3, currency: "usd", holding_currency: "usd", amount_cents: 14, holding_amount_cents: 14)
  BalanceTransaction.create!(user: affiliate.affiliate_user, merchant_account: ma, purchase:, update_user_balance: false, issued_amount: usd(14, 14), holding_amount: usd(14, 14))
                    .update_columns(balance_id: balance.id)
})
cases << run_case("an affiliate credit already recorded is not credited again", seed: affiliate_sale { |purchase, seller, ma, affiliate|
  balance = Balance.create!(user: affiliate.affiliate_user, merchant_account: ma, date: SEEDED_AT.to_date, currency: "usd", holding_currency: "usd", amount_cents: 14, holding_amount_cents: 14)
  AffiliateCredit.create!(purchase:, affiliate:, affiliate_amount_cents: 14, affiliate_fee_cents: 5, affiliate_balance: balance)
})
cases << run_case("a seller who bears the affiliate fee pays it out of the credit's fee", seed: affiliate_sale { |_, seller, _, _| seller.update_columns(flags: seller.flags | (1 << 14)) })
cases << run_case("a product-specific rate sizes the credit's basis points", seed: affiliate_sale(apply_to_all_products: false) { |purchase, _, _, affiliate|
  ProductAffiliate.create!(affiliate:, product: purchase.link, affiliate_basis_points: 500, created_at: SEEDED_AT, updated_at: SEEDED_AT)
})
cases << run_case("an affiliate on all products needs no product rate", seed: affiliate_sale(apply_to_all_products: true))
cases << run_case("a collaborator's credit", seed: affiliate_sale(kind: :collaborator))
cases << run_case("a sale whose affiliate credit is zero is not credited", seed: affiliate_sale(credit_cents: 0))
# A collaborator shares the fee whatever the seller's fee flag says, and looks up the product's rate even on all products.
cases << run_case("a collaborator on all products still looks up the product's rate", seed: affiliate_sale(kind: :collaborator, apply_to_all_products: true))
cases << run_case("a collaborator with a product-specific rate", seed: affiliate_sale(kind: :collaborator, apply_to_all_products: false) { |purchase, _, _, affiliate|
  ProductAffiliate.create!(affiliate:, product: purchase.link, affiliate_basis_points: 500, created_at: SEEDED_AT, updated_at: SEEDED_AT)
})
cases << run_case("a collaborator's fee share is taken although the seller bears the affiliate fee", seed: affiliate_sale(kind: :collaborator) { |_, seller, _, _| seller.update_columns(flags: seller.flags | (1 << 14)) })
cases << run_case("a collaborator's credit already recorded is not credited again", seed: affiliate_sale(kind: :collaborator) { |purchase, _, ma, affiliate|
  balance = Balance.create!(user: affiliate.affiliate_user, merchant_account: ma, date: SEEDED_AT.to_date, currency: "usd", holding_currency: "usd", amount_cents: 14, holding_amount_cents: 14)
  AffiliateCredit.create!(purchase:, affiliate:, affiliate_amount_cents: 14, affiliate_fee_cents: 5, affiliate_balance: balance)
})
# Recorded only: a direct affiliate credited beside the collaborator. Node hands it back, so these cases pin what a port must do.
DIRECT_ON_COLLAB_CENTS = 10
def collab_with_direct_sale(**direct_attributes)
  affiliate_sale(kind: :collaborator) do |purchase, seller, _, _|
    direct = create(:direct_affiliate, seller:, affiliate_user:, created_at: SEEDED_AT, updated_at: SEEDED_AT, **direct_attributes)
    purchase.direct_affiliate_id = direct.id
    purchase.direct_affiliate_credit_cents = DIRECT_ON_COLLAB_CENTS
    purchase.affiliate_credit_cents += DIRECT_ON_COLLAB_CENTS
    purchase.save!(validate: false)
  end
end
cases << run_case("a collaborator and a direct affiliate on one sale", seed: collab_with_direct_sale)
cases << run_case("a collaborator and a direct affiliate that is not on all products", seed: collab_with_direct_sale(apply_to_all_products: false))

File.write(OUT, JSON.pretty_generate({ "now" => NOW.iso8601(3), "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
