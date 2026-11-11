# frozen_string_literal: true

# Produces nextjs/src/server/models/__fixtures__/link-metrics.golden.json: the five Link metrics
# ProductCachedValue reads (successful_sales_count, remaining_for_sale_count, monthly_recurring_revenue,
# revenue_pending, total_usd_cents) run by the real app as a Sidekiq job would, over a seeded database and
# a real Elasticsearch purchases index (documents from Purchase#as_indexed_json) reached through the
# recording proxy: each entry holds the statements, the exact Elasticsearch requests with their answers and
# what the method returned. Run it like invalidate-product-cache-worker.rb with ELASTICSEARCH_HOST set,
# USE_DB_WORKER_REPLICAS=true and a DATABASE_NAME ending in _<lane>.
require_relative "support/rails_cases"
require_relative "support/link_metrics_universe"
require_relative "../../src/server/search/__fixtures__/es_recording_proxy"
include RailsCases
include LinkMetricsUniverse
connect_recording_client!

OUT = Rails.root.join("nextjs/src/server/models/__fixtures__/link-metrics.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
INDEX = "ws30m-purchase#{ENV.fetch("PARITY_ES_INDEX_SUFFIX", "")}"
Purchase.index_name(INDEX)
Purchase.__elasticsearch__.create_index!(force: true)
Rails.logger = ActiveSupport::Logger.new(nil)

SALES = %w[successful_sales_count monthly_recurring_revenue total_usd_cents revenue_pending].freeze
ALL = (%w[remaining_for_sale_count] + SALES).freeze
FUTURE = "2026-12-01 00:00:00"
PAST = "2026-10-01 00:00:00"

def seed(**tables) = { "users" => [user_row], **tables.transform_keys(&:to_s) }

scenarios = []

scenarios << { name: "no sales", seed: seed(links: [link_row(1)]), targets: { 1 => ALL } }

scenarios << {
  name: "purchase states and exclusions",
  seed: seed(
    links: [link_row(1), link_row(2)],
    purchases: [
      purchase_row(1, 1, price_cents: 500), purchase_row(2, 1), purchase_row(3, 1, price_cents: 2_500),
      purchase_row(4, 1, state: "test_successful", price_cents: 0), purchase_row(5, 1, state: "failed", failed: true),
      purchase_row(6, 1, price_cents: 1_000, stripe_refunded: true),
      purchase_row(7, 1, price_cents: 1_000, stripe_partially_refunded: true),
      purchase_row(8, 1, chargeback_date: BOUGHT_AT), purchase_row(9, 1, price_cents: 700, chargeback_date: BOUGHT_AT, flag_names: [:chargeback_reversed]),
      purchase_row(10, 1, state: "gift_receiver_purchase_successful", price_cents: 0, flag_names: [:is_gift_receiver_purchase]),
      purchase_row(11, 1, price_cents: 1_300, flag_names: [:is_gift_sender_purchase]),
      purchase_row(12, 1, state: "not_charged", price_cents: 900),
      purchase_row(13, 1, state: "preorder_authorization_successful", price_cents: 400, preorder_id: 1, flag_names: [:is_preorder_authorization]),
      purchase_row(14, 1, state: "preorder_concluded_successfully", price_cents: 450, preorder_id: 1),
      purchase_row(15, 1, price_cents: 300, flag_names: [:is_bundle_product_purchase]),
      purchase_row(16, 1, price_cents: 1_800, flag_names: [:is_commission_completion_purchase]),
      purchase_row(17, 2, price_cents: 5_000), purchase_row(18, 1, price_cents: 0),
      purchase_row(19, 1, state: "in_progress"), purchase_row(20, 1, state: "preorder_authorization_failed", preorder_id: 2)
    ],
    refunds: [refund_row(1, 6, 1_000), refund_row(2, 7, 400)]
  ),
  targets: { 1 => SALES, 2 => SALES }
}

scenarios << {
  name: "everything refunded or charged back",
  seed: seed(
    links: [link_row(1)],
    purchases: [
      purchase_row(1, 1, stripe_refunded: true), purchase_row(2, 1, chargeback_date: BOUGHT_AT),
      purchase_row(3, 1, price_cents: 800, stripe_partially_refunded: true), purchase_row(4, 1, price_cents: 600, stripe_partially_refunded: true)
    ],
    refunds: [refund_row(1, 1, 1_000), refund_row(2, 3, 800), refund_row(3, 4, 100), refund_row(4, 4, 200, status: "failed")]
  ),
  targets: { 1 => SALES }
}

scenarios << {
  name: "large numbers",
  seed: seed(
    links: [link_row(1)],
    purchases: [
      purchase_row(1, 1, price_cents: 2_000_000_000), purchase_row(2, 1, price_cents: 2_000_000_000), purchase_row(3, 1, price_cents: 2_000_000_000),
      purchase_row(4, 1, price_cents: 2_147_483_647, stripe_partially_refunded: true), purchase_row(5, 1, price_cents: 1)
    ],
    refunds: [refund_row(1, 4, 1_500_000_000)]
  ),
  targets: { 1 => SALES }
}

recurring = [:is_recurring_billing]
orig = [:is_original_subscription_purchase]
sub_prices = { 1 => ["monthly", 1_200], 2 => ["yearly", 12_000], 3 => ["monthly", 500], 4 => ["monthly", 700], 5 => ["quarterly", 900], 6 => ["monthly", 800], 7 => ["biannually", 1_200],
               8 => ["every_two_years", 3], 9 => ["quarterly", 1_001], 10 => ["monthly", 1_100], 12 => ["monthly", 650] }
scenarios << {
  name: "subscriptions",
  seed: seed(
    links: [link_row(1, flag_names: recurring, subscription_duration: 0), link_row(2, flag_names: recurring)],
    prices: sub_prices.map { |id, (recurrence, cents)| price_row(id, 1, recurrence, cents) },
    payment_options: (sub_prices.keys - [10]).map { payment_option_row(_1, _1, _1) },
    subscriptions: [
      subscription_row(1, 1, last_payment_option_id: 1), subscription_row(2, 1, last_payment_option_id: 2),
      subscription_row(3, 1, last_payment_option_id: 3, cancelled_at: FUTURE),
      subscription_row(4, 1, last_payment_option_id: 4, cancelled_at: PAST, deactivated_at: PAST),
      subscription_row(5, 1, last_payment_option_id: 5, failed_at: PAST, deactivated_at: PAST),
      subscription_row(6, 1, last_payment_option_id: 6, flag_names: [:is_test_subscription]),
      subscription_row(7, 1, last_payment_option_id: 7), subscription_row(8, 1, last_payment_option_id: 8), subscription_row(9, 1, last_payment_option_id: 9),
      subscription_row(10, 1), subscription_row(11, 1, last_payment_option_id: 12, cancelled_at: PAST),
      subscription_row(12, 2, last_payment_option_id: 12)
    ],
    purchases: [
      purchase_row(1, 1, price_cents: 1_200, subscription_id: 1, flag_names: orig),
      purchase_row(2, 1, price_cents: 1_200, subscription_id: 1), purchase_row(3, 1, price_cents: 1_200, subscription_id: 1),
      purchase_row(4, 1, price_cents: 12_000, subscription_id: 2, flag_names: orig),
      purchase_row(5, 1, price_cents: 500, subscription_id: 3, flag_names: orig),
      purchase_row(6, 1, price_cents: 700, subscription_id: 4, flag_names: orig),
      purchase_row(7, 1, price_cents: 900, subscription_id: 5, flag_names: orig),
      purchase_row(8, 1, state: "test_successful", price_cents: 0, subscription_id: 6, flag_names: orig),
      purchase_row(9, 1, price_cents: 600, subscription_id: 7, flag_names: orig + [:is_archived_original_subscription_purchase]),
      purchase_row(10, 1, price_cents: 1_200, subscription_id: 7, flag_names: orig),
      purchase_row(11, 1, price_cents: 3, subscription_id: 8, flag_names: orig),
      purchase_row(12, 1, price_cents: 1_001, subscription_id: 9, flag_names: orig, stripe_refunded: true),
      purchase_row(13, 1, price_cents: 1_100, subscription_id: 10, flag_names: orig),
      purchase_row(14, 1, price_cents: 650, subscription_id: 11, flag_names: orig),
      purchase_row(15, 2, price_cents: 650, subscription_id: 12, flag_names: orig),
      purchase_row(16, 1, price_cents: 1_000)
    ],
    refunds: [refund_row(1, 12, 1_001)]
  ),
  targets: { 1 => SALES, 2 => SALES }
}

big_subs = [1, 2, 3]
scenarios << {
  name: "subscriptions with large amounts",
  seed: seed(
    links: [link_row(1, flag_names: recurring)],
    prices: big_subs.map { price_row(_1, 1, "monthly", 2_000_000_000) },
    payment_options: big_subs.map { payment_option_row(_1, _1, _1) },
    subscriptions: big_subs.map { subscription_row(_1, 1, last_payment_option_id: _1) },
    purchases: big_subs.map { purchase_row(_1, 1, price_cents: 2_000_000_000, subscription_id: _1, flag_names: orig) }
  ),
  targets: { 1 => SALES }
}

fixed_subs = [
  subscription_row(1, 1, charge_occurrence_count: 6), subscription_row(2, 1, charge_occurrence_count: 6, cancelled_at: PAST),
  subscription_row(3, 1, charge_occurrence_count: 6, cancelled_at: FUTURE), subscription_row(4, 1, charge_occurrence_count: 6, failed_at: PAST),
  subscription_row(5, 1, charge_occurrence_count: 6, ended_at: PAST), subscription_row(6, 1, charge_occurrence_count: 6, flag_names: [:is_test_subscription]),
  subscription_row(7, 1), subscription_row(8, 1, charge_occurrence_count: 3), subscription_row(9, 1, charge_occurrence_count: 12),
  subscription_row(10, 2, charge_occurrence_count: 6), subscription_row(11, 4, charge_occurrence_count: 12),
  subscription_row(12, 5, charge_occurrence_count: 12), subscription_row(13, 5, charge_occurrence_count: 12),
  subscription_row(14, 7, charge_occurrence_count: 6)
]
fixed_originals = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 13].map { purchase_row(_1, _1 == 10 ? 2 : (_1 > 11 ? 5 : 1), price_cents: _1 > 11 ? 2_000_000_000 : 1_000 + _1, subscription_id: _1, flag_names: orig) }
scenarios << {
  name: "fixed-length subscriptions",
  seed: seed(
    links: [link_row(1, flag_names: recurring, duration_in_months: 6), link_row(2, flag_names: recurring), link_row(3, flag_names: recurring, duration_in_months: 0),
            link_row(4, flag_names: recurring, duration_in_months: 12), link_row(5, flag_names: recurring, duration_in_months: -1), link_row(6, flag_names: recurring, duration_in_months: 3), link_row(7, flag_names: recurring, duration_in_months: 6)],
    subscriptions: fixed_subs,
    purchases: fixed_originals + [
      purchase_row(30, 7, price_cents: nil, subscription_id: 14, flag_names: orig), purchase_row(20, 1, subscription_id: 1), purchase_row(21, 1, subscription_id: 1), purchase_row(22, 1, subscription_id: 1, state: "failed"),
      purchase_row(23, 1, subscription_id: 3), purchase_row(24, 1, subscription_id: 8), purchase_row(25, 1, subscription_id: 8), purchase_row(26, 1, subscription_id: 8),
      purchase_row(27, 1, subscription_id: 8), purchase_row(28, 1, subscription_id: 9, state: "test_successful")
    ]
  ),
  targets: { 1 => %w[revenue_pending], 2 => %w[revenue_pending], 3 => %w[revenue_pending], 4 => %w[revenue_pending], 5 => %w[revenue_pending], 6 => %w[revenue_pending], 7 => %w[revenue_pending] }
}

# --- stock ---
cats = []
variants = []
bundle_products = []
links = []
cat = ->(id, link_id, **o) { cats << category_row(id, link_id, **o) }
variant = ->(id, category_id, **o) { variants << variant_row(id, category_id, **o) }
tier = [:is_tiered_membership]

links << link_row(1)
links << link_row(2, max_purchase_count: 10, sales_count_for_inventory_cache: 3)
links << link_row(3, max_purchase_count: 5, sales_count_for_inventory_cache: 9)
links << link_row(4, max_purchase_count: 2_147_483_647)
links << link_row(5, max_purchase_count: 2_147_483_647, sales_count_for_inventory_cache: 2_147_483_647)
links << link_row(6, max_purchase_count: 0)
links << link_row(7, max_purchase_count: 4, sales_count_for_inventory_cache: 1); cat.(1, 7)
variant.(1, 1, max_purchase_count: 1, sales_count_for_inventory_cache: 1); variant.(2, 1)
links << link_row(8); cat.(2, 8); variant.(3, 2, max_purchase_count: 1, sales_count_for_inventory_cache: 1)
links << link_row(9, max_purchase_count: 6, sales_count_for_inventory_cache: 2); cat.(3, 9); variant.(4, 3, deleted_at: PAST, max_purchase_count: 1, sales_count_for_inventory_cache: 1)
links << link_row(10); cat.(4, 10, deleted_at: PAST); variant.(5, 4, max_purchase_count: 1, sales_count_for_inventory_cache: 1)
links << link_row(11, max_purchase_count: 8, sales_count_for_inventory_cache: 8); cat.(5, 11); cat.(6, 11)
variant.(6, 5, max_purchase_count: 1, sales_count_for_inventory_cache: 1); variant.(7, 6)
links << link_row(12, flag_names: tier); cat.(7, 12, title: "Tier"); variant.(8, 7, max_purchase_count: 5, sales_count_for_inventory_cache: 2)
links << link_row(13, flag_names: tier, max_purchase_count: 50); cat.(8, 13, title: "Tier"); variant.(9, 8)
links << link_row(14, flag_names: tier); cat.(9, 14, title: "Tier"); variant.(10, 9, max_purchase_count: 1, sales_count_for_inventory_cache: 1)
links << link_row(15, flag_names: tier, max_purchase_count: 9, sales_count_for_inventory_cache: 1); cat.(10, 15, title: "Tier")
variant.(11, 10, max_purchase_count: 5, sales_count_for_inventory_cache: 1); variant.(12, 10, deleted_at: PAST)
links << link_row(16, flag_names: tier); cat.(11, 16, title: "Tier"); variant.(13, 11); variant.(14, 11)
links << link_row(17, flag_names: tier); cat.(12, 17, title: "Tier"); variant.(15, 12, flag_names: [:closed_to_new_purchases])
links << link_row(18); cat.(13, 18); variant.(16, 13, flag_names: [:closed_to_new_purchases])
links << link_row(19); cat.(14, 19); variant.(17, 14, flag_names: [:closed_to_new_purchases]); variant.(18, 14)
links << link_row(20, max_purchase_count: 10, sales_count_for_inventory_cache: 4)
links << link_row(21)
links << link_row(22); cat.(15, 22); variant.(19, 15, max_purchase_count: 3, sales_count_for_inventory_cache: 1)
links << link_row(23); cat.(16, 23); variant.(20, 16, max_purchase_count: 1, sales_count_for_inventory_cache: 1)
links << bundle_row(24); bundle_products << bundle_product_row(1, 24, 20) << bundle_product_row(2, 24, 21)
links << bundle_row(25); bundle_products << bundle_product_row(3, 25, 22, variant_id: 19)
links << bundle_row(26); bundle_products << bundle_product_row(4, 26, 23)
links << bundle_row(27, max_purchase_count: 3, sales_count_for_inventory_cache: 1); bundle_products << bundle_product_row(5, 27, 20)
links << bundle_row(28); bundle_products << bundle_product_row(6, 28, 20, deleted_at: PAST)
links << bundle_row(29)
links << link_row(31, max_purchase_count: 10, sales_count_for_inventory_cache: 9, deleted_at: PAST)
links << bundle_row(30); bundle_products << bundle_product_row(7, 30, 31)
links << bundle_row(32, max_purchase_count: 100); bundle_products << bundle_product_row(8, 32, 20)
links << bundle_row(33); bundle_products << bundle_product_row(9, 33, 20) << bundle_product_row(10, 33, 22, variant_id: 19) << bundle_product_row(11, 33, 31)
links << bundle_row(34); bundle_products << bundle_product_row(12, 34, 20, variant_id: 999)
links << bundle_row(35); bundle_products << bundle_product_row(13, 35, 22, variant_id: 21)
variant.(21, 15, type: "Sku", max_purchase_count: 3)
scenarios << {
  name: "stock",
  seed: seed(links:, variant_categories: cats, base_variants: variants, bundle_products:),
  targets: links.to_h { [_1[:id], %w[remaining_for_sale_count]] }
}

# --- run ---
def encode_result(value)
  case value
  when Float then { "class" => "Float", "value" => value.to_s }
  when nil then { "class" => "NilClass", "value" => nil }
  else { "class" => value.class.name, "value" => value }
  end
end

def exchanges
  EsProxy.log.map { |entry| entry.except("response").merge("response" => JSON.parse(entry["response"]).except("took")) }
end

def record_metric(scenario, product_id, metric)
  purchase_ids = scenario[:seed].fetch("purchases", []).map { _1[:id] }
  result = nil
  recorded = []
  entry = capture("#{scenario[:name]}: product #{product_id} #{metric}", now: NOW, tables: TABLES, seed: scenario[:seed], setup: -> { reindex_purchases!(purchase_ids) },
                  sidekiq: true, scenario: scenario[:name], product_id:, metric:) do
    EsProxy.log.clear
    EsProxy.on = true
    result = Link.find(product_id).public_send(metric)
  ensure
    EsProxy.on = false
    recorded = exchanges
  end
  entry.merge("result" => encode_result(result), "exchanges" => recorded).except("seed", "rows", "redis", "redis_before", "cache")
end

cases = scenarios.flat_map { |scenario| scenario[:targets].flat_map { |id, metrics| metrics.map { |metric| record_metric(scenario, id, metric) } } }
File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "index" => INDEX, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
EsClient.indices.delete(index: INDEX)
