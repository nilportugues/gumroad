# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/update-taxonomy-stats-job.golden.json: UpdateTaxonomyStatsJob run by the real app
# against a scratch database as a Sidekiq job (support/sidekiq_executor.rb), Elasticsearch captured (EsCapture) and answered with
# the case's `es_bodies` in order (the aggregation search, then the recent sales search, for each root). Run it like
# backfill-price-checker-index-fields-job.rb (env as in publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases
capture_elasticsearch!

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/update-taxonomy-stats-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[taxonomies taxonomy_hierarchies taxonomy_stats].freeze

Rails.logger = ActiveSupport::Logger.new(nil)

# Every node of a closure_tree: the self row and one row per ancestor.
def tree(*edges)
  parents = edges.to_h { |id, parent| [id, parent] }
  taxonomies = parents.map { |id, parent| { id:, parent_id: parent, slug: "slug-#{id}" } }
  hierarchies = parents.keys.flat_map do |id|
    chain = [id]
    chain << parents[chain.last] while parents[chain.last]
    chain.each_with_index.map { |ancestor, generations| { ancestor_id: ancestor, descendant_id: id, generations: } }
  end
  { taxonomies:, taxonomy_hierarchies: hierarchies }
end

def stat_row(id, taxonomy_id, **overrides)
  { id:, taxonomy_id:, creators_count: 1, products_count: 2, sales_count: 3, recent_sales_count: 4, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def totals(sales, creators, products)
  { "hits" => { "total" => { "value" => sales, "relation" => "eq" }, "hits" => [] },
    "aggregations" => { "creators_count" => { "value" => creators }, "products_count" => { "value" => products } } }
end

def recent(sales) = { "hits" => { "total" => { "value" => sales, "relation" => "eq" }, "hits" => [] } }

def run(name, seed, *bodies)
  result = capture(name, now: NOW, tables: TABLES, seed:, sidekiq: true, job: "UpdateTaxonomyStatsJob", args: [], es_bodies: bodies) do
    UpdateTaxonomyStatsJob.new.perform
  end
  result.delete("rows")
  result.delete("seed")
  result
end

ONE_ROOT = tree([1, nil])
TWO_LEVELS = tree([1, nil], [2, 1], [3, 2])
TWO_ROOTS = tree([1, nil], [2, 1], [3, nil], [4, 3], [5, 3])

cases = []
cases << run("no taxonomies", {})
cases << run("a root with no descendants", ONE_ROOT, totals(10, 4, 6), recent(2))
cases << run("a root with children and a grandchild", TWO_LEVELS, totals(10, 4, 6), recent(2))
cases << run("two roots with their subtrees", TWO_ROOTS, totals(10, 4, 6), recent(2), totals(7, 3, 5), recent(1))
cases << run("a stat that already holds the same numbers", ONE_ROOT.merge(taxonomy_stats: [stat_row(1, 1, creators_count: 4, products_count: 6, sales_count: 10, recent_sales_count: 2)]), totals(10, 4, 6), recent(2))
cases << run("a stat that changes in one column", ONE_ROOT.merge(taxonomy_stats: [stat_row(1, 1, creators_count: 4, products_count: 6, sales_count: 10, recent_sales_count: 9)]), totals(10, 4, 6), recent(2))
cases << run("a stat that changes in every column", ONE_ROOT.merge(taxonomy_stats: [stat_row(1, 1)]), totals(10, 4, 6), recent(2))
cases << run("a stat with no recent sales count", ONE_ROOT.merge(taxonomy_stats: [stat_row(1, 1, recent_sales_count: nil)]), totals(10, 4, 6), recent(0))
cases << run("two stats for one taxonomy use the first", ONE_ROOT.merge(taxonomy_stats: [stat_row(1, 1), stat_row(2, 1)]), totals(10, 4, 6), recent(2))
cases << run("a stat of another taxonomy is left alone", TWO_ROOTS.merge(taxonomy_stats: [stat_row(1, 3)]), totals(10, 4, 6), recent(2), totals(7, 3, 5), recent(1))
cases << run("no sales at all", ONE_ROOT, totals(0, 0, 0), recent(0))
cases << run("cardinalities that are floats", ONE_ROOT, totals(10, 4.0, 6.5), recent(2))
cases << run("cardinalities that are null", ONE_ROOT, totals(10, nil, nil), recent(2))
cases << run("an answer without aggregations", ONE_ROOT, { "hits" => { "total" => { "value" => 10 }, "hits" => [] } }, recent(2))
cases << run("an answer without a total", ONE_ROOT, { "hits" => { "hits" => [] }, "aggregations" => { "creators_count" => { "value" => 4 }, "products_count" => { "value" => 6 } } }, recent(2))
cases << run("an answer whose total is a number", ONE_ROOT, { "hits" => { "total" => 10, "hits" => [] }, "aggregations" => { "creators_count" => { "value" => 4 }, "products_count" => { "value" => 6 } } }, recent(2))
cases << run("a recent sales answer without a total", ONE_ROOT, totals(10, 4, 6), { "hits" => { "hits" => [] } })
cases << run("a failing second root keeps the first", TWO_ROOTS, totals(10, 4, 6), recent(2), { "hits" => { "hits" => [] } })

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
