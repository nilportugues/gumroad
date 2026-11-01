# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/offer-code-pricing-vectors.golden.json: seeded random
# inputs to the price arithmetic of OfferCode, Subscription#current_subscription_price_cents and
# Purchase#minimum_paid_price_cents, each answered by the real Ruby methods, so the Node functions
# (models/offer-code.ts, purchase-pricing.ts, subscription-pricing.ts) are checked value for value,
# rounding and errors included. No query is sent: the associations the methods read are stubbed on
# unsaved records. Run it like subscription-reminder-jobs.rb (any scratch database will do):
#
#   RAILS_ENV=test DATABASE_NAME=gumroad_ws48 TEST_DATABASE_NAME=gumroad_ws48 DISABLE_TEST_REDIS_ISOLATION=1 \
#     REDIS_HOST=127.0.0.1:6379/9 SIDEKIQ_REDIS_HOST=127.0.0.1:6379/9 RPUSH_REDIS_HOST=127.0.0.1:6379/9 \
#     RACK_ATTACK_REDIS_HOST=127.0.0.1:6379/9 bundle exec rails runner nextjs/scripts/golden/offer-code-pricing-vectors.rb
require "json"
include ActiveSupport::Testing::TimeHelpers

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/offer-code-pricing-vectors.golden.json")
NOW = Time.utc(2025, 11, 1, 12, 30, 45, 123_000)
RNG = Random.new(48)

def pick(*options) = options[RNG.rand(options.size)]
def int(range) = RNG.rand(range)
def chance(p) = RNG.rand < p

# Runs the block; a Ruby error is part of the answer.
def answer
  { "value" => yield }
rescue StandardError => e
  { "error" => e.message }
end

COUNTS = Hash.new(0)
def vectors(name, count)
  Array.new(count) { yield }.tap { COUNTS[name] = count }
end

# --- OfferCode#amount_off and #original_price --------------------------------------------------------
amount_vectors = vectors("amounts", 1500) do
  percentage = pick(nil, int(-5..130), int(0..100), 100, 0, 50, 33, 7)
  cents = pick(nil, nil, int(-200..5000), 0, int(0..900_000))
  price = pick(int(-500..2_000_000), int(0..2000), 0, 999, 100, 1)
  code = OfferCode.new(amount_percentage: percentage, amount_cents: cents)
  {
    "amount_percentage" => percentage, "amount_cents" => cents, "price" => price,
    "amount_off" => answer { code.amount_off(price) },
    "original_price" => answer { code.original_price(price) },
  }
end

# --- OfferCode#months_since ---------------------------------------------------------------------------
months_vectors = vectors("months_since", 1500) do
  ts = pick(
    Time.utc(2010, 1, 1) + int(0..(16 * 365 * 86_400)),
    NOW - int(0..(70 * 86_400)),
    Time.utc(int(2019..2025), int(1..12), pick(28, 29, 30, 31, 1, 15), int(0..23), int(0..59), int(0..59)),
    NOW + int(1..(200 * 86_400)),
    nil,
  )
  { "timestamp" => ts && ts.utc.strftime("%Y-%m-%dT%H:%M:%S.000Z"), "months" => travel_to(NOW) { answer { OfferCode.new.months_since(ts&.in_time_zone) } } }
end

# --- OfferCode#normalized_ownership_duration_tiers and #matching_tier_for ----------------------------------
number_forms = lambda do |n|
  pick(n, n, n.to_s, " #{n}", "#{n}abc", n + 0.7, n + 0.0)
end
tier_vectors = vectors("tiers", 800) do
  count = int(1..6)
  months = (0..120).to_a.sample(count, random: RNG)
  tiers = months.map do |m|
    { pick("months", :months) => number_forms.(m), pick("amount_percentage", :amount_percentage) => number_forms.(int(0..100)) }.transform_keys(&:to_s)
  end
  code = OfferCode.new(ownership_duration_tiers: tiers)
  queries = Array.new(4) { int(0..130) }
  {
    "tiers" => tiers, "queries" => queries,
    "normalized" => answer { code.normalized_ownership_duration_tiers },
    "matches" => queries.map { |q| answer { code.matching_tier_for(q) } },
  }
end

# --- ProductInstallmentPlan / InstallmentPlanSnapshot payments -------------------------------------------------
installment_vectors = vectors("installments", 1000) do
  total = pick(int(-50..10_000_000), int(0..100_000), int(1..60))
  n = int(1..12)
  {
    "total" => total, "number_of_installments" => n,
    "plan" => answer { ProductInstallmentPlan.new(number_of_installments: n).calculate_installment_payment_price_cents(total) },
    "snapshot" => answer { InstallmentPlanSnapshot.new(total_price_cents: total, number_of_installments: n).calculate_installment_payment_price_cents },
  }
end

# --- Subscription: the tiered pay-what-you-want pre-discount total, and the discounted renewal total ----------------
Orig = Struct.new(:displayed_price_cents, :purchase_offer_code_discount, :quantity, :unit, keyword_init: true) do
  def minimum_paid_price_cents_per_unit_before_discount = unit
end
Discount = Struct.new(:offer_code, :offer_code_is_percent, :offer_code_amount, :pre_discount_minimum_price_cents, keyword_init: true)

pwyw_vectors = vectors("tiered_pwyw", 1500) do
  percent = pick(int(0..100), 0, 100, int(100..130), int(1..99))
  pre_min = pick(int(0..100_000), 500, 999, 0)
  quantity = pick(1, 1, int(1..5))
  displayed = pick(int(0..300_000), pre_min * quantity, pre_min * quantity + 1)
  discount = Discount.new(offer_code: OfferCode.new(ownership_duration_tiers: [{ "months" => 0, "amount_percentage" => 10 }]), offer_code_is_percent: true, offer_code_amount: percent, pre_discount_minimum_price_cents: pre_min)
  subscription = Subscription.new
  subscription.define_singleton_method(:original_purchase) { Orig.new(displayed_price_cents: displayed, purchase_offer_code_discount: discount, quantity:) }
  { "percent" => percent, "pre_discount_minimum_price_cents" => pre_min, "quantity" => quantity, "displayed" => displayed,
    "total" => answer { subscription.send(:cached_tiered_pwyw_renewal_pre_discount_total_cents) } }
end

Auto = Subscription.const_get(:AutoRenewalDiscount)
CURRENCIES = %w[usd eur jpy gbp cad inr].freeze
discounted_vectors = vectors("discounted_totals", 2000) do
  is_percent = chance(0.5)
  amount = is_percent ? pick(int(1..100), 0, int(100..130), 50) : pick(int(1..5000), int(1..900_000), 1)
  once_per_cart = chance(0.4)
  code_is_cents = is_percent ? chance(0.15) : true
  code = OfferCode.new(amount_cents: code_is_cents ? 100 : nil, amount_percentage: code_is_cents ? nil : 10, once_per_cart:)
  quantity = pick(1, 1, int(1..5))
  unit = pick(int(0..300_000), 500, 999)
  pre = pick(int(0..300_000), unit * quantity, 0)
  currency = pick(*CURRENCIES)
  subscription = Subscription.new
  subscription.define_singleton_method(:original_purchase) { Orig.new(displayed_price_cents: pre, purchase_offer_code_discount: nil, quantity:, unit:) }
  subscription.define_singleton_method(:link) { Link.new(price_currency_type: currency) }
  auto = Auto.new(offer_code: code, offer_code_amount: amount, offer_code_is_percent: is_percent)
  { "is_percent" => is_percent, "amount" => amount, "once_per_cart" => once_per_cart, "code_is_cents" => code_is_cents, "quantity" => quantity, "unit" => unit, "pre" => pre, "currency" => currency,
    "total" => answer { subscription.send(:auto_renewal_discounted_total_cents, auto, pre) } }
end

# --- Purchase#minimum_paid_price_cents (not a recurring charge) ------------------------------------------------
Fake = Struct.new(:nth, :snapshot, :plan) do
  def purchases = self
  def successful = self
  def count = nth
  def last_payment_option = self
  def installment_plan_snapshot = snapshot
  def installment_plan = plan
end

price_vectors = vectors("minimum_paid_price", 4000) do
  loop do
    v = {
      "quantity" => pick(1, 1, int(1..4)),
      "unit" => pick(int(0..500_000), int(-300..5000), 999, 3001, 0),
      "code" => pick(nil, nil, "percent", "cents"),
      "code_amount" => pick(int(0..100), int(0..130), int(0..900_000), int(0..5000), 100, 0),
      "once_per_cart" => chance(0.4),
      "applies" => chance(0.85),
      "currency" => pick(*CURRENCIES),
      "completion" => chance(0.1),
      "commission_product" => chance(0.1),
      "installment" => chance(0.45),
      "ppp" => chance(0.2),
      "ppp_enabled" => chance(0.5),
      "nth" => int(0..5),
      "number_of_installments" => int(1..6),
      "snapshot" => chance(0.4),
      "snapshot_total" => int(1..200_000),
      "snapshot_installments" => int(1..6),
      "plan" => chance(0.95),
    }
    # The factor of a PPP-discounted price needs Redis and the country list, which Node hands back.
    next if v["ppp"] && v["ppp_enabled"] && v["code"].nil?

    code = case v["code"]
           when "percent" then OfferCode.new(amount_percentage: v["code_amount"], once_per_cart: v["once_per_cart"])
           when "cents" then OfferCode.new(amount_cents: v["code_amount"], once_per_cart: v["once_per_cart"])
    end
    purchase = Purchase.new(quantity: v["quantity"], is_original_subscription_purchase: true, is_installment_payment: v["installment"], is_commission_completion_purchase: v["completion"],
                            is_purchasing_power_parity_discounted: v["ppp"])
    link = Link.new(price_currency_type: v["currency"], native_type: v["commission_product"] ? "commission" : "digital")
    link.define_singleton_method(:purchasing_power_parity_enabled?) { v["ppp_enabled"] }
    snapshot = v["snapshot"] ? InstallmentPlanSnapshot.new(total_price_cents: v["snapshot_total"], number_of_installments: v["snapshot_installments"]) : nil
    plan = v["plan"] ? ProductInstallmentPlan.new(number_of_installments: v["number_of_installments"]) : nil
    subscription = Fake.new(v["nth"], snapshot, plan)
    purchase.define_singleton_method(:link) { link }
    purchase.define_singleton_method(:subscription) { subscription }
    purchase.define_singleton_method(:minimum_paid_price_cents_per_unit_before_discount) { v["unit"] }
    purchase.define_singleton_method(:offer_code_for_pricing) { code }
    purchase.define_singleton_method(:offer_code_applies_to_selected_variant?) { v["applies"] }
    purchase.define_singleton_method(:purchasing_power_parity_factor) { 0.35 }
    break v.merge("price" => answer { purchase.minimum_paid_price_cents })
  end
end

families = { "amounts" => amount_vectors, "months_since" => months_vectors, "tiers" => tier_vectors, "installments" => installment_vectors,
             "tiered_pwyw" => pwyw_vectors, "discounted_totals" => discounted_vectors, "minimum_paid_price" => price_vectors }
# One vector per line.
File.write(OUT, "{\n\"now\": #{NOW.to_f.to_json},\n#{families.map { |name, rows| "\"#{name}\": [\n#{rows.map(&:to_json).join(",\n")}\n]" }.join(",\n")}\n}\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{COUNTS.map { |name, n| "#{n} #{name}" }.join(", ")})"
