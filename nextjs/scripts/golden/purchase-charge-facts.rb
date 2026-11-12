# frozen_string_literal: true

# Writes nextjs/src/server/models/__fixtures__/purchase-charge-facts.golden.json: what the real Ruby answers for the facts
# `Purchase#calculate_fees` takes as inputs, so a Node paid checkout can resolve them before its first call to the processor.
#
#   high_volume       User#high_volume_seller_fee? over the feature flag, the stored month and the clock
#   merchant_account  User#merchant_account then Purchase#prepare_merchant_account (the account the charge uses), plus
#                     Purchase#charged_using_gumroad_merchant_account? and the Brazilian Connect test, over real rows
#   discover_fee      Purchase#charge_discover_fee? over the product, the recommendation type and the original purchase
#   card_type         the card_type of a Stripe token and of a Stripe payment method chargeable (where the Pix type comes from)
#
#   RAILS_ENV=test DATABASE_NAME=gumroad_test_24 TEST_DATABASE_NAME=gumroad_test_24 DISABLE_TEST_REDIS_ISOLATION=1 \
#     REDIS_HOST=redis:6379/50 SIDEKIQ_REDIS_HOST=redis:6379/51 RPUSH_REDIS_HOST=redis:6379/52 \
#     RACK_ATTACK_REDIS_HOST=redis:6379/53 DISABLE_SPRING=1 bundle exec rails runner nextjs/scripts/golden/purchase-charge-facts.rb
require "json"
require "factory_bot_rails"
require "active_support/testing/time_helpers"
include FactoryBot::Syntax::Methods
include ActiveSupport::Testing::TimeHelpers

FactoryBot.definition_file_paths << Rails.root.join("spec", "support", "factories")
FactoryBot.reload

OUT = Rails.root.join("nextjs/src/server/models/__fixtures__/purchase-charge-facts.golden.json")
Rails.logger = ActiveSupport::Logger.new(nil)
ActiveRecord::Base.connection.execute("SET FOREIGN_KEY_CHECKS = 0")
%w[merchant_accounts users links].each { |t| ActiveRecord::Base.connection.execute("DELETE FROM #{t}") }
Redis.new(url: "redis://#{ENV.fetch('REDIS_HOST')}").flushdb

STRIPE = StripeChargeProcessor.charge_processor_id
PAYPAL = PaypalChargeProcessor.charge_processor_id
HIGH_VOLUME = :high_volume_seller_fee

# ---- high volume seller fee
high_volume = []
[true, false].each do |active|
  [nil, "2026-11", "2026-10", "2026-12", "2025-11"].each do |month|
    [Time.utc(2026, 11, 15, 12), Time.utc(2026, 11, 30, 23, 59, 59), Time.utc(2026, 12, 1), Time.utc(2026, 10, 31, 23, 59, 59)].each do |now|
      seller = create(:user)
      active ? Feature.activate_user(HIGH_VOLUME, seller) : Feature.deactivate_user(HIGH_VOLUME, seller)
      seller.update_columns(json_data: month ? { "high_volume_fee_month" => month } : nil)
      seller.reload
      answer = travel_to(now) { seller.high_volume_seller_fee? }
      high_volume << { input: { feature_active: active, month:, now: now.iso8601 }, output: answer }
      Feature.deactivate_user(HIGH_VOLUME, seller)
    end
  end
end

# ---- merchant account
GUMROAD_ACCOUNT = MerchantAccount.new(user_id: nil, charge_processor_id: STRIPE, charge_processor_merchant_id: "acct_gumroad", charge_processor_alive_at: Time.current)
GUMROAD_ACCOUNT.save!(validate: false)
GUMROAD_PAYPAL = MerchantAccount.new(user_id: nil, charge_processor_id: PAYPAL, charge_processor_merchant_id: "gumroad_paypal", charge_processor_alive_at: Time.current)
GUMROAD_PAYPAL.save!(validate: false)
CROSS_BORDER = Compliance::Countries::THA.alpha2

def account(processor: STRIPE, connect: false, country: "US", alive: true, processor_deleted: false, deleted: false)
  { processor:, connect:, country:, alive:, processor_deleted:, deleted: }
end

ACCOUNT_SETS = {
  none: [],
  managed: [account],
  managed_cross_border: [account(country: CROSS_BORDER)],
  cross_border_then_managed: [account(country: CROSS_BORDER), account(country: "GB")],
  two_managed: [account(country: "GB"), account(country: "US")],
  connect: [account(connect: true)],
  connect_brazil: [account(connect: true, country: "BR")],
  managed_brazil: [account(country: "BR")],
  managed_and_connect: [account, account(connect: true, country: "CA")],
  connect_and_managed: [account(connect: true, country: "CA"), account],
  deleted: [account(deleted: true)],
  not_alive: [account(alive: false)],
  processor_deleted: [account(processor_deleted: true)],
  deleted_then_managed: [account(deleted: true), account(country: "GB")],
  paypal: [account(processor: PAYPAL)],
  paypal_cross_border: [account(processor: PAYPAL, country: CROSS_BORDER)],
  paypal_and_managed: [account(processor: PAYPAL), account],
  paypal_deleted_then_alive: [account(processor: PAYPAL, deleted: true), account(processor: PAYPAL, country: "GB")],
}.freeze

merchant_account = []
ACCOUNT_SETS.each do |set_name, specs|
  [true, false].each do |linked|
    [STRIPE, PAYPAL].each do |processor|
      [false, true].each do |recurring_upi|
        seller = create(:user)
        seller.update!(check_merchant_account_is_linked: linked)
        rows = specs.map do |spec|
          row = MerchantAccount.new(user_id: seller.id, charge_processor_id: spec[:processor], country: spec[:country],
                                    charge_processor_merchant_id: "acct_#{SecureRandom.hex(4)}",
                                    charge_processor_alive_at: spec[:alive] ? Time.current : nil,
                                    charge_processor_deleted_at: spec[:processor_deleted] ? Time.current : nil,
                                    deleted_at: spec[:deleted] ? Time.current : nil)
          row.json_data = { "meta" => { "stripe_connect" => "true" } } if spec[:connect]
          row.save!(validate: false)
          row
        end
        seller.reload
        seller_picked = seller.merchant_account(processor)

        affiliate = nil
        [false, true].each do |has_affiliate|
          purchase = Purchase.new
          purchase.define_singleton_method(:seller) { seller }
          purchase.define_singleton_method(:credit_card) { recurring_upi ? Struct.new(:x) { def recurring_upi? = true }.new(1) : nil }
          purchase.define_singleton_method(:affiliate) { has_affiliate ? Object.new : nil }
          purchase.define_singleton_method(:calculate_fees) { nil }
          purchase.charge_processor_id = processor
          purchase.send(:prepare_merchant_account, processor)
          chosen = purchase.merchant_account
          chosen_ref = if chosen.nil? then nil
                       elsif chosen.id == GUMROAD_ACCOUNT.id then "gumroad_stripe"
                       elsif chosen.id == GUMROAD_PAYPAL.id then "gumroad_paypal"
                       else rows.index { |r| r.id == chosen.id }
          end
          merchant_account << {
            input: { accounts: specs, linked:, processor:, recurring_upi:, has_affiliate: },
            output: {
              seller_account: seller_picked ? rows.index { |r| r.id == seller_picked.id } : nil,
              chosen: chosen_ref,
              charged_using_gumroad_merchant_account: purchase.charged_using_gumroad_merchant_account?,
              brazilian_connect: chosen&.is_a_brazilian_stripe_connect_account? || false,
              error_code: purchase.error_code,
              error_messages: purchase.errors.full_messages,
            },
          }
        end
      end
    end
  end
end

# ---- charge_discover_fee?
FREE_AND_OTHER = [nil, "", "discover", "search", "receipt", "library", "more_like_this", "products_for_you", "staff_picks", "recently_viewed",
                  "discover_wishlist", "product", "wishlist", "unknown"].freeze
discover_fee = []
[true, false].each do |recommendable|
  [true, false].each do |not_original|
    [nil, true, false].each do |original_discover|
      [true, false].each do |recommended|
        FREE_AND_OTHER.each do |recommended_by|
          link = Struct.new(:recommendable) { def recommendable? = recommendable }.new(recommendable)
          original = original_discover.nil? ? nil : Struct.new(:d) { def was_discover_fee_charged? = d }.new(original_discover)
          purchase = Purchase.new(was_product_recommended: recommended, recommended_by:)
          purchase.define_singleton_method(:link) { link }
          purchase.define_singleton_method(:not_is_original_subscription_purchase?) { not_original }
          purchase.define_singleton_method(:original_purchase) { original }
          discover_fee << {
            input: { recommendable:, not_original_subscription_purchase: not_original, original_discover_fee_charged: original_discover, recommended:, recommended_by: },
            output: purchase.charge_discover_fee?,
          }
        end
      end
    end
  end
end

# ---- card_type
BRANDS = ["visa", "amex", "mastercard", "discover", "jcb", "diners", "unionpay", "link", "Visa", "American Express", "MasterCard",
          "Discover", "JCB", "Diners Club", "UnionPay", "weird", "", nil].freeze
METHOD_TYPES = ["card", "pix", "upi", "ideal", "bancontact", "klarna", "alipay", "link", "sepa_debit", "", nil].freeze
card_type = { token: [], payment_method: [] }
BRANDS.each do |brand|
  token = StripeChargeableToken.allocate
  token.instance_variable_set(:@token, Stripe::Token.construct_from(card: brand.nil? ? {} : { brand: }))
  card_type[:token] << { input: { brand: }, output: token.card_type }
end
BRANDS.each do |brand|
  METHOD_TYPES.each do |type|
    [true, false].each do |card_block|
      attrs = {}
      attrs[:type] = type unless type.nil?
      attrs[:card] = brand.nil? ? {} : { brand: } if card_block
      chargeable = StripeChargeablePaymentMethod.allocate
      chargeable.instance_variable_set(:@payment_method, Stripe::PaymentMethod.construct_from(attrs))
      # Stripe always sends `type`; a payload without it makes Ruby raise NoMethodError, which no real payment method does.
      answer = begin
        chargeable.card_type
      rescue NoMethodError
        next
      end
      card_type[:payment_method] << { input: { brand:, type:, card_block: }, output: answer }
    end
  end
end
no_method = StripeChargeablePaymentMethod.allocate
card_type[:payment_method] << { input: { no_payment_method: true }, output: no_method.card_type }

File.write(OUT, JSON.pretty_generate(
  constants: { cross_border_country: CROSS_BORDER, free_recommendation_types: %w[library more_like_this wishlist recently_viewed] },
  high_volume:, merchant_account:, discover_fee:, card_type:
) + "\n")
puts "wrote #{OUT} (#{high_volume.size} high volume, #{merchant_account.size} merchant account, #{discover_fee.size} discover, #{card_type[:token].size + card_type[:payment_method].size} card type)"
