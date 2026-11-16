# frozen_string_literal: true

# Writes nextjs/src/server/models/__fixtures__/balance-transaction-amounts.golden.json: the issued and holding amounts the real
# `BalanceTransaction::Amount` factories answer for a seller's sale and an affiliate's credit, over the shapes of FlowOfFunds a
# charge produces (platform, direct, destination, buyer-currency) and who holds the funds.
#
#   RAILS_ENV=test DATABASE_NAME=gumroad_test_24 TEST_DATABASE_NAME=gumroad_test_24 DISABLE_TEST_REDIS_ISOLATION=1 \
#     REDIS_HOST=redis:6379/50 SIDEKIQ_REDIS_HOST=redis:6379/51 RPUSH_REDIS_HOST=redis:6379/52 \
#     RACK_ATTACK_REDIS_HOST=redis:6379/53 DISABLE_SPRING=1 bundle exec rails runner nextjs/scripts/golden/balance-transaction-amounts.rb
require "json"

OUT = Rails.root.join("nextjs/src/server/models/__fixtures__/balance-transaction-amounts.golden.json")

def amount(currency, cents) = currency && FlowOfFunds::Amount.new(currency:, cents:)
def amount_json(value) = value && { currency: value.currency, cents: value.cents }

FLOWS = {
  platform_usd: { issued: ["usd", 500], settled: ["usd", 500], gumroad: ["usd", 500], gross: nil, net: nil },
  platform_eur_settled_usd: { issued: ["eur", 460], settled: ["usd", 500], gumroad: ["usd", 500], gross: nil, net: nil },
  platform_eur_settled_eur: { issued: ["eur", 460], settled: ["eur", 460], gumroad: ["eur", 460], gross: nil, net: nil },
  direct_usd: { issued: ["usd", 500], settled: ["usd", 500], gumroad: ["usd", 145], gross: ["usd", 500], net: ["usd", 355] },
  direct_cad: { issued: ["usd", 500], settled: ["cad", 700], gumroad: ["usd", 145], gross: ["cad", 700], net: ["cad", 497] },
  destination_gbp: { issued: ["eur", 460], settled: ["usd", 500], gumroad: ["eur", 130], gross: ["gbp", 400], net: ["gbp", 330] },
  settled_missing: { issued: ["usd", 500], settled: nil, gumroad: ["usd", 500], gross: nil, net: nil },
}.freeze

CANONICAL = [nil, ["usd", 500], ["usd", 507]].freeze

amounts = []
FLOWS.each do |name, spec|
  flow = FlowOfFunds.new(issued_amount: amount(*spec[:issued]), settled_amount: spec[:settled] && amount(*spec[:settled]), gumroad_amount: amount(*spec[:gumroad]),
                         merchant_account_gross_amount: spec[:gross] && amount(*spec[:gross]), merchant_account_net_amount: spec[:net] && amount(*spec[:net]))
  CANONICAL.each do |canonical|
    [nil, true, false].each do |gumroad_held|
      [0, 310, 355, -20].each do |net|
        merchant_account = gumroad_held.nil? ? nil : Struct.new(:held) { def holder_of_funds = held ? HolderOfFunds::GUMROAD : HolderOfFunds::STRIPE }.new(gumroad_held)
        canonical_amount = canonical && amount(*canonical)
        issued = BalanceTransaction::Amount.create_issued_amount_for_seller(flow_of_funds: flow, issued_net_cents: net, canonical_issued_amount: canonical_amount)
        holding = BalanceTransaction::Amount.create_holding_amount_for_seller(flow_of_funds: flow, issued_net_cents: net, canonical_issued_amount: canonical_amount, merchant_account:)
        amounts << {
          input: { flow: name, flow_of_funds: spec, canonical_issued_amount: canonical, gumroad_held:, issued_net_cents: net },
          output: { issued: { currency: issued.currency, gross_cents: issued.gross_cents, net_cents: issued.net_cents },
                    holding: { currency: holding.currency, gross_cents: holding.gross_cents, net_cents: holding.net_cents } },
        }
      end
    end
  end
end

affiliate = []
[1, 25, 99_999].each do |cents|
  [nil, "eur", "usd"].each do |currency|
    args = { issued_affiliate_cents: cents }
    args[:currency] = currency if currency
    issued = BalanceTransaction::Amount.create_issued_amount_for_affiliate(**args)
    holding = BalanceTransaction::Amount.create_holding_amount_for_affiliate(**args)
    affiliate << { input: { issued_affiliate_cents: cents, currency: }, output: {
      issued: { currency: issued.currency, gross_cents: issued.gross_cents, net_cents: issued.net_cents },
      holding: { currency: holding.currency, gross_cents: holding.gross_cents, net_cents: holding.net_cents }
    } }
  end
end

File.write(OUT, JSON.pretty_generate(seller: amounts, affiliate:) + "\n")
puts "wrote #{OUT} (#{amounts.size} seller, #{affiliate.size} affiliate)"
