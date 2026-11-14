# frozen_string_literal: true

# Produces purchase-search.golden.json: PurchaseSearchService (the customers, sales and admin
# queries) run on the real app against the real Elasticsearch through the recording proxy, so each
# case holds the exact request bytes and the answer, including the fallback request a long email
# token triggers. The index is ws65-purchase, filled with a fixed set of purchases.
#
#   scratchpad/ws65-run.sh bin/rails runner nextjs/src/server/search/__fixtures__/generate-purchase-search-golden.rb
abort "Refusing to run outside the test environment" unless Rails.env.test?
abort "Refusing to run against #{ActiveRecord::Base.connection.current_database}" unless ActiveRecord::Base.connection.current_database == "gumroad_ws65"

require_relative "es_recording_proxy"
connect_recording_client!

Purchase.index_name("ws65-purchase")
Purchase.__elasticsearch__.create_index!(force: true)

NOW = "2026-09-15T10:00:00Z"
base = {
  "can_contact" => true, "country_or_ip_country" => "United States", "created_at" => NOW, "email" => "buyer@example.com", "email_domain" => "example.com",
  "full_name" => "Ada Lovelace", "not_chargedback_or_chargedback_reversed" => true, "not_refunded_except_subscriptions" => true,
  "not_subscription_or_original_subscription_purchase" => true, "successful_authorization_or_without_preorder" => true, "price_cents" => 1_000,
  "purchase_state" => "successful", "fee_cents" => 130, "stripe_refunded" => false, "selected_flags" => [], "variant_ids" => [], "product_id" => 10,
  "product_name" => "Ruby course", "product_description" => "Learn ruby", "seller_id" => 1, "seller_name" => "Seller One", "purchaser_id" => 50,
  "product_ids_from_same_seller_purchased_by_purchaser" => [10], "variant_ids_from_same_seller_purchased_by_purchaser" => [], "license_uses" => 0, "taxonomy_id" => 3
}
docs = [
  { "id" => 1 },
  { "id" => 2, "email" => "other@victoria.com.au", "email_domain" => "victoria.com.au", "full_name" => "Grace Hopper", "purchaser_id" => 51, "product_id" => 11, "product_name" => "Rails course", "price_cents" => 2_500, "created_at" => "2026-08-01T00:00:00Z", "country_or_ip_country" => "Canada", "variant_ids" => [7], "product_ids_from_same_seller_purchased_by_purchaser" => [11], "variant_ids_from_same_seller_purchased_by_purchaser" => [7] },
  { "id" => 3, "email" => "buyer@victoria.com", "email_domain" => "victoria.com", "full_name" => "Alan Turing", "seller_id" => 2, "seller_name" => "Seller Two", "purchaser_id" => 52, "product_id" => 12, "price_cents" => 0, "selected_flags" => ["is_gift_receiver_purchase"], "created_at" => "2026-09-20T00:00:00Z", "license_serial" => "ABCD1234-ABCD1234-ABCD1234-ABCD1234", "license_uses" => 3 },
  { "id" => 4, "price_cents" => 500, "stripe_refunded" => true, "not_refunded_except_subscriptions" => false, "purchase_state" => "successful", "selected_flags" => %w[is_archived was_product_recommended], "created_at" => "2026-07-01T00:00:00Z" },
  { "id" => 5, "purchase_state" => "failed", "price_cents" => 700, "can_contact" => false, "ip_country" => "France", "country_or_ip_country" => "France" },
  { "id" => 6, "subscription_id" => 9, "subscription_cancelled_at" => "2026-09-01T00:00:00Z", "subscription_deactivated_at" => "2026-09-02T00:00:00Z", "subscription_current_email" => "current@example.org", "subscription_current_email_domain" => "example.org", "not_subscription_or_original_subscription_purchase" => false, "affiliate_credit_affiliate_user_id" => 77, "affiliate_credit_amount_cents" => 100, "paypal_email" => "pay@example.com" },
  { "id" => 7, "selected_flags" => %w[is_bundle_product_purchase is_deleted_by_buyer is_additional_contribution is_access_revoked is_commission_completion_purchase is_gift_sender_purchase], "not_chargedback_or_chargedback_reversed" => false, "chargeback_date" => "2026-09-10T00:00:00Z", "direct_affiliate_credit_affiliate_user_id" => 78, "direct_affiliate_credit_amount_cents" => 50 },
]
docs.each { |doc| EsClient.index(index: Purchase.index_name, id: doc["id"], body: base.merge(doc)) }
EsClient.indices.refresh(index: Purchase.index_name)

def time(value) = Time.utc(*value)

# JSON option values: {"$time" => [y, m, d, h]} is a Time; any_products_or_variants has symbol keys in Ruby.
def build_options(spec)
  spec.to_h do |key, value|
    value = time(value["$time"]) if value.is_a?(Hash) && value.key?("$time")
    value = value.deep_symbolize_keys if key == "any_products_or_variants"
    value = value&.deep_symbolize_keys if key == "aggs"
    value = value.map { _1.is_a?(Hash) ? _1.deep_symbolize_keys : _1 } if key == "sort"
    [key.to_sym, value]
  end
end

cases = []
add = lambda do |name, options|
  EsProxy.log.clear
  EsProxy.on = true
  built = build_options(options)
  outcome = begin
    service = PurchaseSearchService.new(built)
    response = service.process
    { "total" => response.results.total, "ids" => response.response["hits"]["hits"].map { _1["_id"] } }
  rescue StandardError => e
    { "error" => { "class" => e.class.name, "message" => e.message } }
  ensure
    EsProxy.on = false
  end
  exchanges = EsProxy.log.map { _1.except("response").merge("response" => JSON.parse(_1["response"]).except("took")) }
  body = begin
    PurchaseSearchService.new(built).then { Elasticsearch::Client.new(host: "http://localhost:1").transport.send(:__convert_to_json, _1.body) }
  rescue StandardError
    nil
  end
  cases << { "name" => name, "options" => options, "outcome" => outcome, "body" => body, "exchanges" => exchanges }
end

add.call("defaults", {})
add.call("seller id", { "seller" => 1 })
add.call("seller list", { "seller" => [1, 2], "size" => 10 })
add.call("purchaser", { "purchaser" => [50, 51] })
add.call("id", { "id" => [1, 3] })
add.call("product", { "product" => 10 })
add.call("exclude product", { "exclude_product" => [10, 11] })
add.call("exclude purchasers of product", { "exclude_purchasers_of_product" => [10] })
add.call("variant", { "variant" => [7] })
add.call("exclude variant", { "exclude_variant" => 7 })
add.call("exclude purchasers of variant", { "exclude_purchasers_of_variant" => [7] })
add.call("exclude purchase", { "exclude_purchase" => [1, 2] })
add.call("any products or variants", { "any_products_or_variants" => { "products" => [10], "variants" => [7] } })
add.call("any products only", { "any_products_or_variants" => { "products" => [10] } })
add.call("any products or variants empty", { "any_products_or_variants" => { "products" => [], "variants" => nil } })
add.call("affiliate user", { "affiliate_user" => 77 })
add.call("revenue sharing user", { "revenue_sharing_user" => [1, 77] })
add.call("taxonomy", { "taxonomy" => [3] })
add.call("blank filters are skipped", { "seller" => [], "purchaser" => nil, "product" => "", "id" => [] })
%w[exclude_non_original_subscription_purchases exclude_deactivated_subscriptions exclude_cancelled_or_pending_cancellation_subscriptions exclude_refunded
   exclude_refunded_except_subscriptions exclude_unreversed_chargedback exclude_cant_contact exclude_giftees exclude_gifters exclude_non_successful_preorder_authorizations
   exclude_bundle_product_purchases exclude_commission_completion_purchases exclude_deleted_by_buyer exclude_additional_contributions exclude_access_revoked
   exclude_not_charged_non_free_trial_purchases].each do |flag|
  add.call(flag, { flag => true })
end
add.call("a boolean set to false", { "exclude_refunded" => false })
add.call("for library", { "for_library" => true, "purchaser" => 50 })
add.call("price greater than", { "price_greater_than" => 600 })
add.call("price greater than zero", { "price_greater_than" => 0 })
add.call("price less than", { "price_less_than" => 2_000 })
add.call("license uses", { "license_uses_greater_than_or_equal_to" => 1 })
add.call("license uses zero", { "license_uses_greater_than_or_equal_to" => 0 })
add.call("created after", { "created_after" => { "$time" => [2026, 8, 1] } })
add.call("created on or after", { "created_on_or_after" => { "$time" => [2026, 8, 1, 12] } })
add.call("created before", { "created_before" => { "$time" => [2026, 9, 1] } })
add.call("created on or before", { "created_on_or_before" => { "$time" => [2026, 9, 1, 23, 59, 59] } })
add.call("country", { "country" => %w[Canada France] })
add.call("email is downcased", { "email" => "Buyer@Example.COM" })
add.call("state", { "state" => ["successful", "gift_receiver_purchase_successful"] })
add.call("archived", { "archived" => true })
add.call("not archived", { "archived" => false })
add.call("recommended", { "recommended" => true })
add.call("not recommended", { "recommended" => false })
add.call("seller query", { "seller" => 1, "seller_query" => "Ada" })
add.call("seller query with spaces", { "seller" => 1, "seller_query" => "  Ada Lovelace  " })
add.call("seller query quoted", { "seller" => 1, "seller_query" => "\"Ada Lovelace\"" })
add.call("seller query with an at sign", { "seller" => 1, "seller_query" => "buyer@example.com" })
add.call("seller query license key", { "seller" => 1, "seller_query" => "abcd1234-abcd1234-abcd1234-abcd1234" })
add.call("seller query blank", { "seller" => 1, "seller_query" => "   " })
add.call("seller query with a long token that matches by prefix", { "seller_query" => "buyer@victoria.com.au.example.org.zzzz" })
add.call("seller query with a long token that finds nothing at all", { "seller_query" => "nobody@nowhere-at-all-really.example" })
add.call("seller query with a long token and a hit already", { "seller_query" => "buyer@example.com thisisaverylongtokenindeed" })
add.call("seller query fallback skipped when totals are not tracked", { "seller_query" => "nobody@nowhere-at-all-really.example", "track_total_hits" => false })
add.call("buyer query", { "buyer_query" => "Ruby" })
add.call("native params", { "from" => 2, "size" => 3, "sort" => [{ "created_at" => "desc" }, { "id" => "desc" }], "_source" => true, "track_total_hits" => true })
add.call("sort and source only", { "sort" => [{ "id" => "asc" }], "_source" => ["email"] })
add.call("aggregations", { "seller" => 1, "size" => 0, "aggs" => { "price_total" => { "sum" => { "field" => "price_cents" } }, "by_state" => { "terms" => { "field" => "purchase_state" } } } })
add.call("nil native params are skipped", { "from" => nil, "size" => nil, "aggs" => nil, "_source" => nil })
add.call("a customers page", { "seller" => 1, "exclude_refunded" => true, "exclude_non_original_subscription_purchases" => true, "state" => ["successful"], "product" => [10, 11], "price_greater_than" => 0, "created_after" => { "$time" => [2026, 8, 1] }, "country" => "Canada", "email" => "other@victoria.com.au", "seller_query" => "grace", "from" => 0, "size" => 20, "sort" => [{ "created_at" => "desc" }, { "id" => "desc" }], "track_total_hits" => true })

library = Purchase::ALL_SUCCESS_STATES
File.write(File.join(__dir__, "purchase-search.golden.json"), JSON.pretty_generate("index" => Purchase.index_name, "all_success_states" => library, "cases" => cases) + "\n")
puts "wrote #{cases.size} cases"
