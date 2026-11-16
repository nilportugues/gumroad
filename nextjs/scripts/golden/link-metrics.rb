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
require_relative "support/link_metrics_scenarios"
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


scenarios = LinkMetricsScenarios.build

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
