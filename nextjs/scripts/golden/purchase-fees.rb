# frozen_string_literal: true

# Writes nextjs/src/server/models/__fixtures__/purchase-fees.golden.json: what the real `Purchase#calculate_fees` answers for a
# one-time purchase, over a grid of prices and of the facts it reads. The facts that live in other records (the seller's fee
# flags, the merchant account, whether the product counts as recommended) are fixed per case on an unsaved Purchase, so the arithmetic
# under test is Ruby's own and no row is read or written.
#
#   RAILS_ENV=test DATABASE_NAME=gumroad_test_24 TEST_DATABASE_NAME=gumroad_test_24 DISABLE_TEST_REDIS_ISOLATION=1 \
#     REDIS_HOST=redis:6379/50 SIDEKIQ_REDIS_HOST=redis:6379/51 RPUSH_REDIS_HOST=redis:6379/52 \
#     RACK_ATTACK_REDIS_HOST=redis:6379/53 DISABLE_SPRING=1 bundle exec rails runner nextjs/scripts/golden/purchase-fees.rb
require "json"

OUT = Rails.root.join("nextjs/src/server/models/__fixtures__/purchase-fees.golden.json")

PRICES = [1, 49, 99, 100, 250, 499, 500, 501, 1_234, 5_000, 12_345, 1_000_001].freeze
SELLER_FACTS = [
  { waive: false, high_volume: false },
  { waive: true, high_volume: false },
  { waive: false, high_volume: true },
].freeze

def fee_case(price_cents:, waive:, high_volume:, gumroad_account:, discover:, custom_fee:, seller_custom_fee:, brazilian:, pix:)
  seller = Struct.new(:waive, :high_volume, :custom_fee_per_thousand) do
    def waive_gumroad_fee_on_new_sales? = waive
    def high_volume_seller_fee? = high_volume
  end.new(waive, high_volume, seller_custom_fee)
  merchant = Struct.new(:brazilian) { def is_a_brazilian_stripe_connect_account? = brazilian }.new(brazilian)

  purchase = Purchase.new(price_cents:)
  purchase.define_singleton_method(:seller) { seller }
  purchase.define_singleton_method(:merchant_account) { merchant }
  purchase.define_singleton_method(:charged_using_gumroad_merchant_account?) { gumroad_account }
  purchase.define_singleton_method(:charge_discover_fee?) { discover }
  purchase.define_singleton_method(:card_type) { pix ? CardType::PIX : "visa" }
  purchase.custom_fee_per_thousand = custom_fee
  purchase.send(:calculate_fees)

  { fee_cents: purchase.fee_cents, was_discover_fee_charged: purchase.was_discover_fee_charged? }
end

cases = []
PRICES.each do |price_cents|
  SELLER_FACTS.each do |seller|
    [true, false].each do |gumroad_account|
      [false, true].each do |discover|
        [[nil, nil], [0, nil], [50, nil], [300, nil], [nil, 20], [nil, 300]].each do |custom_fee, seller_custom_fee|
          next if price_cents > 5_000 && (custom_fee || seller_custom_fee)

          [[false, false], [true, false], [false, true]].each do |brazilian, pix|
            input = { price_cents:, **seller, gumroad_account:, discover:, custom_fee:, seller_custom_fee:, brazilian:, pix: }
            cases << { input:, output: fee_case(**input) }
          end
        end
      end
    end
  end
end
cases << { input: { price_cents: 0, waive: false, high_volume: false, gumroad_account: true, discover: false, custom_fee: nil, seller_custom_fee: nil, brazilian: false, pix: false },
           output: fee_case(price_cents: 0, waive: false, high_volume: false, gumroad_account: true, discover: false, custom_fee: nil, seller_custom_fee: nil, brazilian: false, pix: false) }

constants = %i[GUMROAD_FLAT_FEE_PER_THOUSAND GUMROAD_DISCOVER_FEE_PER_THOUSAND GUMROAD_DISCOVER_EXTRA_FEE_PER_THOUSAND GUMROAD_FIXED_FEE_CENTS
               PROCESSOR_FEE_PER_THOUSAND PROCESSOR_FIXED_FEE_CENTS PIX_IOF_FEE_PER_THOUSAND].index_with { Purchase.const_get(_1) }
constants[:HIGH_VOLUME_FEE_PER_THOUSAND] = User::HIGH_VOLUME_FEE_PER_THOUSAND

File.write(OUT, "{\n  \"constants\": #{constants.to_json},\n  \"cases\": [\n#{cases.map { "    #{_1.to_json}" }.join(",\n")}\n  ]\n}\n")
puts "wrote #{cases.size} cases to #{OUT}"
