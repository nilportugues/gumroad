# frozen_string_literal: true

# Produces creator-analytics.golden.json: CreatorAnalytics::Sales (the aggregations behind the analytics
# charts and the dashboard's best sellers) and CreatorAnalytics::Churn::ElasticsearchFetcher run on the real
# app against the real Elasticsearch through the recording proxy, so each case holds the exact request
# bytes and the answer. The index is ws70-purchase, filled with a fixed set of purchase documents.
#
#   scratchpad/ws70-run.sh bin/rails runner nextjs/src/server/search/__fixtures__/generate-creator-analytics-golden.rb
abort "Refusing to run outside the test environment" unless Rails.env.test?
abort "Refusing to run against #{ActiveRecord::Base.connection.current_database}" unless ActiveRecord::Base.connection.current_database == "gumroad_ws70"

require_relative "es_recording_proxy"
connect_recording_client!

Purchase.index_name("ws70-purchase")
Purchase.__elasticsearch__.create_index!(force: true)

base = {
  "can_contact" => true, "country_or_ip_country" => "United States", "email" => "buyer@example.com", "email_domain" => "example.com", "full_name" => "Ada Lovelace",
  "not_chargedback_or_chargedback_reversed" => true, "not_refunded_except_subscriptions" => true, "not_subscription_or_original_subscription_purchase" => true,
  "successful_authorization_or_without_preorder" => true, "price_cents" => 1_000, "purchase_state" => "successful", "fee_cents" => 130, "amount_refunded_cents" => 0,
  "stripe_refunded" => false, "selected_flags" => [], "variant_ids" => [], "seller_id" => 42, "seller_name" => "Seller", "purchaser_id" => 50, "license_uses" => 0,
  "ip_country" => "United States", "ip_state" => "CA", "referrer_domain" => "direct", "product_ids_from_same_seller_purchased_by_purchaser" => [1], "variant_ids_from_same_seller_purchased_by_purchaser" => []
}

# Around the Pacific and Sydney midnights, in whole days and in the New York fall-back hour.
stamps = %w[
  2026-08-31T06:59:59Z 2026-08-31T07:00:00Z 2026-09-01T06:59:59Z 2026-09-01T07:00:00Z 2026-09-02T12:00:00Z 2026-09-02T13:30:00Z 2026-09-03T01:00:00Z 2026-09-03T23:59:59Z
  2026-09-04T14:00:00Z 2026-09-05T00:00:00Z 2026-09-05T15:30:00Z 2026-09-06T03:00:00Z 2026-09-07T06:59:59Z 2026-09-07T07:00:00Z 2026-09-08T00:00:00Z
  2026-11-01T04:30:00Z 2026-11-01T05:30:00Z 2026-11-01T06:30:00Z 2026-11-01T07:30:00Z 2026-11-02T10:00:00Z
]
countries = [["United States", "CA"], ["United States", "NY"], ["Canada", nil], ["France", nil], [nil, nil]]
referrers = %w[direct google.com twitter.com direct recommended_by_gumroad]
docs = stamps.each_with_index.map do |stamp, index|
  country, state = countries[index % countries.size]
  { "id" => index + 1, "product_id" => (index.even? ? 1 : 2), "created_at" => stamp, "price_cents" => 500 + 100 * index, "ip_country" => country, "ip_state" => state,
    "referrer_domain" => referrers[index % referrers.size], "subscription_id" => 100 + index, "selected_flags" => ["is_original_subscription_purchase"],
    "monthly_recurring_revenue" => 400 + 10 * index }
end
docs += [
  # Refunded, partially refunded and charged back; the totals subtract what was already refunded.
  { "id" => 101, "product_id" => 1, "created_at" => "2026-09-02T18:00:00Z", "price_cents" => 2_000, "amount_refunded_cents" => 2_000, "stripe_refunded" => true },
  { "id" => 102, "product_id" => 1, "created_at" => "2026-09-02T19:00:00Z", "price_cents" => 3_000, "amount_refunded_cents" => 1_000 },
  { "id" => 103, "product_id" => 2, "created_at" => "2026-09-03T19:00:00Z", "price_cents" => 4_000, "amount_refunded_cents" => 500, "not_chargedback_or_chargedback_reversed" => false },
  # Subscriptions: cancelled and deactivated at different times, an active one, a recurring charge.
  { "id" => 201, "product_id" => 3, "created_at" => "2026-08-01T10:00:00Z", "subscription_id" => 1, "selected_flags" => ["is_original_subscription_purchase"], "monthly_recurring_revenue" => 900,
    "subscription_cancelled_at" => "2026-09-02T09:00:00Z", "subscription_deactivated_at" => "2026-09-02T09:00:00Z" },
  { "id" => 202, "product_id" => 3, "created_at" => "2026-08-10T10:00:00Z", "subscription_id" => 2, "selected_flags" => ["is_original_subscription_purchase"], "monthly_recurring_revenue" => 900 },
  { "id" => 203, "product_id" => 3, "created_at" => "2026-09-03T10:00:00Z", "subscription_id" => 3, "selected_flags" => ["is_original_subscription_purchase"], "monthly_recurring_revenue" => 1_500,
    "subscription_cancelled_at" => "2026-09-05T08:00:00Z" },
  { "id" => 204, "product_id" => 4, "created_at" => "2026-07-20T10:00:00Z", "subscription_id" => 4, "selected_flags" => ["is_original_subscription_purchase"], "monthly_recurring_revenue" => 700,
    "subscription_cancelled_at" => "2026-08-30T08:00:00Z", "subscription_deactivated_at" => "2026-10-01T08:00:00Z" },
  { "id" => 205, "product_id" => 3, "created_at" => "2026-09-04T10:00:00Z", "subscription_id" => 1, "not_subscription_or_original_subscription_purchase" => false },
  # Not counted: another seller, a failed charge, a gift receiver.
  { "id" => 301, "product_id" => 1, "seller_id" => 43, "created_at" => "2026-09-02T12:00:00Z" },
  { "id" => 302, "product_id" => 1, "purchase_state" => "failed", "created_at" => "2026-09-02T12:00:00Z" },
  { "id" => 303, "product_id" => 1, "created_at" => "2026-09-02T12:00:00Z", "selected_flags" => ["is_gift_receiver_purchase"] },
]
docs.each { |doc| EsClient.index(index: Purchase.index_name, id: doc["id"], body: base.merge(doc)) }
EsClient.indices.refresh(index: Purchase.index_name)

ProductRef = Struct.new(:id)
WindowRef = Struct.new(:start_date, :end_date, :timezone_id)

def seller_in(timezone)
  User.new(timezone:).tap { _1.id = 42 }
end

def exchanges_log = EsProxy.log.map { _1.except("response").merge("response" => JSON.parse(_1["response"]).except("took")) }

def record
  EsProxy.log.clear
  EsProxy.on = true
  value = yield
  [value, exchanges_log]
rescue StandardError => e
  [{ "error" => { "class" => e.class.name, "message" => e.message } }, exchanges_log]
ensure
  EsProxy.on = false
end

# Hash#to_a keeps the array keys a JSON object cannot.
def entries(hash) = hash.map { |key, value| { "key" => key.map(&:to_s), "value" => value.transform_keys(&:to_s).transform_values { _1.is_a?(Hash) ? _1.transform_keys(&:to_s) : _1 } } }

cases = []

sales = lambda do |name, timezone, from, to, method, interval: "day", product_ids: nil|
  seller = seller_in(timezone)
  dates = (Date.parse(from)..Date.parse(to)).to_a
  products = product_ids&.map { ProductRef.new(_1) }
  outcome, exchanges = record { entries(CreatorAnalytics::Sales.new(user: seller, dates:, products:, interval:).public_send(method)) }
  cases << { "kind" => "sales", "name" => name, "timezone" => timezone, "from" => from, "to" => to, "method" => method, "interval" => interval, "product_ids" => product_ids, "outcome" => outcome, "exchanges" => exchanges }
end

sales.call("by product and date, every product", "Pacific Time (US & Canada)", "2026-08-31", "2026-09-07", "by_product_and_date")
sales.call("by product and date, listed products", "Pacific Time (US & Canada)", "2026-08-31", "2026-09-07", "by_product_and_date", product_ids: [1, 3])
sales.call("by product and date, a single day", "UTC", "2026-09-02", "2026-09-02", "by_product_and_date")
sales.call("by product and date, Sydney", "Sydney", "2026-09-01", "2026-09-08", "by_product_and_date")
sales.call("by product and date, Tokyo", "Tokyo", "2026-09-02", "2026-09-06", "by_product_and_date", product_ids: [1, 2, 3, 4])
sales.call("by product and date, nothing in range", "UTC", "2025-01-01", "2025-01-03", "by_product_and_date")
sales.call("by country and state", "Pacific Time (US & Canada)", "2026-08-31", "2026-09-08", "by_product_and_country_and_state")
sales.call("by country and state, listed products", "UTC", "2026-08-31", "2026-11-02", "by_product_and_country_and_state", product_ids: [2])
sales.call("by referrer and date", "Pacific Time (US & Canada)", "2026-08-31", "2026-09-07", "by_product_and_referrer_and_date")
sales.call("by referrer and date, listed products", "London", "2026-09-01", "2026-09-06", "by_product_and_referrer_and_date", product_ids: [1])
sales.call("by product and date, hourly across the New York fall-back", "Eastern Time (US & Canada)", "2026-10-31", "2026-11-02", "by_product_and_date", interval: "hour")
sales.call("by referrer and date, hourly", "Pacific Time (US & Canada)", "2026-09-02", "2026-09-04", "by_product_and_referrer_and_date", interval: "hour", product_ids: [1, 2])
sales.call("a hourly range that is too long", "UTC", "2026-09-01", "2026-09-30", "by_product_and_date", interval: "hour")

fetcher = lambda do |name, timezone, from, to, product_ids|
  seller = seller_in(timezone)
  window = WindowRef.new(Date.parse(from), Date.parse(to), seller.timezone_id)
  service = CreatorAnalytics::Churn::ElasticsearchFetcher.new(seller:, products: product_ids.map { ProductRef.new(_1) }, date_window: window)
  {
    "churn_events" => entries(service.churn_events),
    "new_subscriptions" => service.new_subscriptions.map { |key, count| { "key" => key.map(&:to_s), "value" => count } },
    "initial_active_counts" => service.initial_active_counts.map { |id, count| { "key" => [id.to_s], "value" => count } },
  }.then { |result| result }
end

[
  ["Pacific, all subscription products", "Pacific Time (US & Canada)", "2026-08-31", "2026-09-07", [3, 4]],
  ["UTC, one product", "UTC", "2026-09-01", "2026-09-05", [3]],
  ["Sydney", "Sydney", "2026-09-02", "2026-09-06", [3, 4]],
  ["no products", "UTC", "2026-09-01", "2026-09-05", []],
  ["a window before any subscription", "UTC", "2025-01-01", "2025-01-10", [3, 4]],
].each do |name, timezone, from, to, product_ids|
  outcome, exchanges = record { fetcher.call(name, timezone, from, to, product_ids) }
  cases << { "kind" => "churn", "name" => name, "timezone" => timezone, "from" => from, "to" => to, "product_ids" => product_ids, "outcome" => outcome, "exchanges" => exchanges }
end

File.write(File.join(__dir__, "creator-analytics.golden.json"), JSON.pretty_generate("index" => Purchase.index_name, "cases" => cases) + "\n")
puts "wrote #{cases.size} cases"
