# frozen_string_literal: true

# Produces nextjs/src/server/models/__fixtures__/link-writes.golden.json: `Link#update(banned_at:)`,
# the save User::Risk runs on every product of a seller it suspends or reinstates, run by the real
# app/models/link.rb (validations, callbacks, PaperTrail, the after-commit search update) against a
# scratch database. Elasticsearch is a local socket that answers 200 (see support/rails_cases.rb).
# Also writes link-data.generated.json. Run it like user-writes.rb.
require_relative "support/rails_cases"
include RailsCases
capture_elasticsearch!

OUT = Rails.root.join("nextjs/src/server/models/__fixtures__/link-writes.golden.json")
NOW = Time.utc(2025, 11, 1, 12, 30, 45, 123_000)
SEEDED_AT = "2025-01-01 00:00:00"
TABLES = %w[users links prices versions variant_categories base_variants bundle_products product_installment_plans offer_codes
            product_cached_values purchases bank_accounts merchant_accounts].freeze

def user_row(id, **overrides)
  {
    id:, email: "seller#{id}@example.com", username: "seller#{id}", external_id: (1000 + id).to_s, recommendation_type: "own_products",
    user_risk_state: "suspended_for_fraud", flags: 0, json_data: nil, confirmed_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT
  }.merge(overrides)
end

def link_row(id, **overrides)
  { id:, user_id: 5, name: "Product #{id}", unique_permalink: "perm#{("a".ord + id).chr}", price_cents: 100, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def price_row(id, link_id, price_cents = 100, **overrides)
  { id:, link_id:, price_cents:, currency: "usd", created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

# Link flag bits (has_flags in app/models/link.rb).
IS_RECURRING_BILLING = 1 << 1
ARCHIVED = 1 << 4
IS_PHYSICAL = 1 << 7
QUANTITY_ENABLED = 1 << 13
IS_TIERED_MEMBERSHIP = 1 << 18
IS_BUNDLE = 1 << 25
IS_RENTAL = 1 # prices.flags

def ban(name, seed:, id: 9, banned_at: :now, setup: nil)
  capture(name, now: NOW, tables: TABLES, seed: { users: [user_row(5)] }.merge(seed), setup:) do
    product = Link.find(id)
    result = product.update(banned_at: banned_at == :now ? Time.current : banned_at)
    # Symbol errors by type: their messages read the attribute, which would add statements.
    raise "update returned false: #{product.errors.map { [_1.attribute.to_s, _1.raw_type.is_a?(Symbol) ? _1.raw_type.to_s : _1.raw_type] }.inspect}" unless result
  end
end

cases = []

cases << ban("a digital product with a price", seed: { links: [link_row(9)], prices: [price_row(1, 9)] })
cases << ban("a product without a price fails default_price_cents presence", seed: { links: [link_row(9)] })
cases << ban("unbanning a product", banned_at: nil, seed: { links: [link_row(9, banned_at: "2025-06-01 00:00:00")], prices: [price_row(1, 9)] })
cases << ban("a free product turns on customizable_price after the save", seed: { links: [link_row(9, price_cents: 0)], prices: [price_row(1, 9, 0)] })
cases << ban("a free product with paid versions", seed: {
  links: [link_row(9, price_cents: 0)], prices: [price_row(1, 9, 0)],
  variant_categories: [{ id: 2, link_id: 9, title: "Format" }],
  base_variants: [{ id: 3, variant_category_id: 2, name: "PDF", price_difference_cents: 500, created_at: SEEDED_AT, updated_at: SEEDED_AT }],
})
cases << ban("a version category without options fails validation", seed: {
  links: [link_row(9)], prices: [price_row(1, 9)], variant_categories: [{ id: 2, link_id: 9, title: "Format" }],
})
cases << ban("json_data, a custom permalink and a description", seed: {
  links: [link_row(9, custom_permalink: "my-thing", description: "<p>Hi</p>", json_data: '{"custom_receipt_text":"Thanks","sections":[]}', support_email: "help@example.com")],
  prices: [price_row(1, 9)],
})
cases << ban("a physical product without shipping fails validation", seed: { links: [link_row(9, flags: IS_PHYSICAL, native_type: "physical")], prices: [price_row(1, 9)] })
cases << ban("a physical product with shipping", seed: { links: [link_row(9, flags: IS_PHYSICAL, native_type: "physical", require_shipping: true)], prices: [price_row(1, 9)] })
TIERED = link_row(9, flags: IS_TIERED_MEMBERSHIP | IS_RECURRING_BILLING, native_type: "membership", subscription_duration: 0)
cases << ban("a tiered membership", seed: {
  links: [TIERED], variant_categories: [{ id: 2, link_id: 9, title: "Tier" }],
  base_variants: [{ id: 3, variant_category_id: 2, name: "Gold", created_at: SEEDED_AT, updated_at: SEEDED_AT }],
  prices: [price_row(1, 9, 0, recurrence: "monthly"), price_row(4, 9, 500, recurrence: "monthly", variant_id: 3)],
})
cases << ban("a tiered membership without tiers raises LinkInvalid", seed: {
  links: [TIERED], variant_categories: [{ id: 2, link_id: 9, title: "Tier" }], prices: [price_row(1, 9, 0, recurrence: "monthly")],
})
cases << ban("a tiered membership with two tier categories raises LinkInvalid", seed: {
  links: [TIERED], variant_categories: [{ id: 2, link_id: 9, title: "Tier" }, { id: 3, link_id: 9, title: "Other" }], prices: [price_row(1, 9, 0, recurrence: "monthly")],
})
cases << ban("an archived tiered membership skips the tier checks", seed: {
  links: [TIERED.merge(flags: TIERED[:flags] | ARCHIVED)], prices: [price_row(1, 9, 0, recurrence: "monthly")],
})
cases << ban("a recurring product with a duration in months", seed: {
  links: [link_row(9, flags: IS_RECURRING_BILLING, native_type: "membership", subscription_duration: 0, duration_in_months: 12)],
  prices: [price_row(1, 9, 100, recurrence: "monthly"), price_row(2, 9, 1000, recurrence: "yearly")],
})
cases << ban("a call with a duration", seed: {
  links: [link_row(9, native_type: "call")], prices: [price_row(1, 9)],
  variant_categories: [{ id: 2, link_id: 9, title: "Duration" }],
  base_variants: [{ id: 3, variant_category_id: 2, name: "30 minutes", duration_in_minutes: 30, created_at: SEEDED_AT, updated_at: SEEDED_AT }],
})
cases << ban("a published bundle", seed: {
  links: [link_row(9, flags: IS_BUNDLE, native_type: "bundle"), link_row(10)], prices: [price_row(1, 9), price_row(2, 10)],
  bundle_products: [{ id: 1, bundle_id: 9, product_id: 10, quantity: 1, created_at: SEEDED_AT, updated_at: SEEDED_AT }],
})
cases << ban("a rent-only product", seed: {
  links: [link_row(9, purchase_type: 1, preview_url: nil, rental_price_cents: 300)], prices: [price_row(1, 9, 300, flags: IS_RENTAL)],
})
cases << ban("a deleted and archived product", seed: { links: [link_row(9, deleted_at: "2025-03-01 00:00:00", flags: ARCHIVED)], prices: [price_row(1, 9)] })
cases << ban("a product with quantity enabled", seed: { links: [link_row(9, flags: QUANTITY_ENABLED)], prices: [price_row(1, 9)] })
cases << ban("a membership with quantity enabled fails validation", seed: { links: [link_row(9, flags: QUANTITY_ENABLED, native_type: "membership")], prices: [price_row(1, 9)] })
cases << ban("a commission", seed: { links: [link_row(9, native_type: "commission", price_cents: 200)], prices: [price_row(1, 9, 200)] })
cases << ban("a default offer code", seed: {
  links: [link_row(9, default_offer_code_id: 6)], prices: [price_row(1, 9)],
  offer_codes: [{ id: 6, user_id: 5, code: "SAVE", amount_cents: 10, universal: true, created_at: SEEDED_AT, updated_at: SEEDED_AT }],
})
cases << ban("an installment plan", seed: {
  links: [link_row(9, price_cents: 3000)], prices: [price_row(1, 9, 3000)],
  product_installment_plans: [{ id: 2, link_id: 9, number_of_installments: 3, recurrence: "monthly", created_at: SEEDED_AT, updated_at: SEEDED_AT }],
})
cases << ban("fresh cached values are expired", seed: {
  links: [link_row(9)], prices: [price_row(1, 9)],
  product_cached_values: [{ id: 4, product_id: 9, expired: false, created_at: SEEDED_AT, updated_at: SEEDED_AT }, { id: 5, product_id: 9, expired: true, created_at: SEEDED_AT, updated_at: SEEDED_AT }],
})
cases << ban("a product priced in euros by an unverified seller", setup: -> { $redis.set("currencies:EUR", "0.9") }, seed: {
  links: [link_row(9, price_currency_type: "eur")], prices: [price_row(1, 9, 100, currency: "eur")],
})
cases << ban("a price below the minimum fails validation", seed: { links: [link_row(9)], prices: [price_row(1, 9, 50)] })
cases << ban("a coffee product", seed: { links: [link_row(9, native_type: "coffee", price_cents: 0)], prices: [price_row(1, 9, 0)] })
cases << ban("a call without durations fails validation", seed: {
  links: [link_row(9, native_type: "call")], prices: [price_row(1, 9)], variant_categories: [{ id: 2, link_id: 9, title: "Duration" }],
})
cases << ban("a published bundle without products fails validation", seed: { links: [link_row(9, flags: IS_BUNDLE, native_type: "bundle")], prices: [price_row(1, 9)] })
cases << ban("a draft bundle without products", seed: { links: [link_row(9, flags: IS_BUNDLE, native_type: "bundle", draft: true)], prices: [price_row(1, 9)] })
cases << ban("an unverified seller above the price ceiling fails validation", seed: { links: [link_row(9)], prices: [price_row(1, 9, 600_000)] })
cases << ban("a verified seller above the price ceiling", seed: { users: [user_row(5, verified: true)], links: [link_row(9)], prices: [price_row(1, 9, 600_000)] })
cases << ban("a product whose seller is gone fails validation", seed: { links: [link_row(9, user_id: 77)], prices: [price_row(1, 9)] })
cases << ban("an invalid support email fails validation", seed: { links: [link_row(9, support_email: "not an email")], prices: [price_row(1, 9)] })
cases << ban("a suggested price below the price fails validation", seed: { links: [link_row(9, customizable_price: true, suggested_price_cents: 50)], prices: [price_row(1, 9)] })
cases << ban("a free trial without a subscription fails validation", seed: { links: [link_row(9, flags: 1 << 2, free_trial_duration_unit: 0, free_trial_duration_amount: 1)], prices: [price_row(1, 9)] })
cases << ban("buy and rent", seed: { links: [link_row(9, purchase_type: 2)], prices: [price_row(1, 9), price_row(2, 9, 200, flags: IS_RENTAL)] })
cases << ban("a custom permalink equal to the unique permalink", seed: { links: [link_row(9, custom_permalink: "permj")], prices: [price_row(1, 9)] })
cases << ban("a custom permalink another product uses", seed: {
  links: [link_row(9, custom_permalink: "taken"), link_row(10, unique_permalink: "taken")], prices: [price_row(1, 9), price_row(2, 10)],
})
cases << ban("an invalid unique permalink fails validation", seed: { links: [link_row(9, unique_permalink: "has1digit")], prices: [price_row(1, 9)] })
cases << ban("the seller reputation summary version is bumped after commit", setup: -> { Feature.activate(:seller_reputation_summary) }, seed: {
  links: [link_row(9)], prices: [price_row(1, 9)],
})

# The currency facts Link's price validations read, with the messages they format from them
# (Money's per-currency symbol placement and separators).
include CurrencyHelper
currencies = CURRENCY_CHOICES.to_h do |code, config|
  min = config["min_price"]
  [code, {
    "min_price" => min, "single_unit" => config.key?("single_unit"),
    "min_price_formatted" => MoneyFormatter.format(min, code.to_sym, no_cents_if_whole: true, symbol: true),
    "double_min_price_in_currency" => formatted_amount_in_currency(min * 2, code, no_cents_if_whole: true),
    "min_price_in_currency" => formatted_amount_in_currency(min, code, no_cents_if_whole: true),
  }]
end
DATA_OUT = Rails.root.join("nextjs/src/server/models/link-data.generated.json")
File.write(DATA_OUT, JSON.pretty_generate({ "currencies" => currencies }) + "\n")

# Time.now.to_f as travel_to stubs it, which is what Sidekiq stamps on payloads.
now_f = travel_to(NOW, with_usec: true) { Time.now.to_f }
File.write(OUT, JSON.pretty_generate({ "now" => now_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases) and #{DATA_OUT.relative_path_from(Rails.root)}"
