# frozen_string_literal: true

# Rows and Elasticsearch documents for the Link metrics goldens (link-metrics.rb and
# cache-product-data-worker.rb): a seeded database of sellers, products, purchases, subscriptions and
# stock, plus a purchases index filled from the real Purchase#as_indexed_json, so the Ruby methods
# and Elasticsearch answer over the same data. Needs RailsCases and es_recording_proxy.rb loaded.
module LinkMetricsUniverse
  SEEDED_AT = "2026-01-01 00:00:00"
  BOUGHT_AT = "2026-01-02 10:00:00"
  TABLES = %w[
    users links purchases subscriptions payment_options prices variant_categories base_variants bundle_products
    refunds product_cached_values versions base_variants_purchases
  ].freeze

  module_function

  def bits(model, *names) = names.sum { model.flag_mapping["flags"].fetch(_1) }

  def user_row(id = 1, **o)
    { id:, email: "seller#{id}@example.com", name: "Seller #{id}", recommendation_type: "own_products", created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(o)
  end

  def link_row(id, flag_names: [], **o)
    flags = bits(Link, *flag_names)
    { id:, user_id: 1, name: "Product #{id}", unique_permalink: "p#{id}", price_cents: 1_000, price_currency_type: "usd", flags:, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(o)
  end

  def bundle_row(id, flag_names: [], **o) = link_row(id, flag_names: [:is_bundle, *flag_names], **o)

  def purchase_row(id, link_id, state: "successful", flag_names: [], **o)
    { id:, link_id:, seller_id: 1, email: "buyer#{id}@example.com", price_cents: 1_000, fee_cents: 0, purchase_state: state, stripe_refunded: false, quantity: 1,
      flags: bits(Purchase, *flag_names), created_at: BOUGHT_AT, updated_at: BOUGHT_AT }.merge(o)
  end

  def refund_row(id, purchase_id, amount_cents, **o)
    { id:, purchase_id:, link_id: 1, seller_id: 1, amount_cents:, created_at: BOUGHT_AT, updated_at: BOUGHT_AT }.merge(o)
  end

  def subscription_row(id, link_id, flag_names: [], **o)
    { id:, link_id:, user_id: nil, seller_id: 1, flags: bits(Subscription, *flag_names), created_at: BOUGHT_AT, updated_at: BOUGHT_AT }.merge(o)
  end

  def price_row(id, link_id, recurrence, price_cents = 1_000)
    { id:, link_id:, price_cents:, recurrence:, created_at: SEEDED_AT, updated_at: SEEDED_AT }
  end

  def payment_option_row(id, subscription_id, price_id)
    { id:, subscription_id:, price_id:, created_at: SEEDED_AT, updated_at: SEEDED_AT }
  end

  def category_row(id, link_id, title: "Versions", **o) = { id:, link_id:, title:, flags: 0 }.merge(o)

  def variant_row(id, category_id, flag_names: [], **o)
    { id:, variant_category_id: category_id, name: "Variant #{id}", type: "Variant", flags: bits(BaseVariant, *flag_names), sales_count_for_inventory_cache: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(o)
  end

  def bundle_product_row(id, bundle_id, product_id, **o)
    { id:, bundle_id:, product_id:, quantity: 1, position: id, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(o)
  end

  def cached_row(id, product_id, expired: false, **o)
    { id:, product_id:, expired:, successful_sales_count: 3, remaining_for_sale_count: nil, monthly_recurring_revenue: "0.0", revenue_pending: "0.0", total_usd_cents: 500,
      created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(o)
  end

  # Empties the purchases index and indexes every seeded purchase the way the app does.
  def reindex_purchases!(purchase_ids)
    EsClient.delete_by_query(index: Purchase.index_name, body: { query: { match_all: {} } }, refresh: true, conflicts: "proceed")
    purchase_ids.each { |id| EsClient.index(index: Purchase.index_name, id:, body: Purchase.find(id).as_indexed_json) }
    EsClient.indices.refresh(index: Purchase.index_name)
  end
end
