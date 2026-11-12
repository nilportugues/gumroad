# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/delete-product-files-worker.golden.json: DeleteProductFilesWorker run by the real app
# against a scratch database as a Sidekiq job (support/sidekiq_executor.rb), Elasticsearch answered by a local socket (capture_elasticsearch!)
# with the case's `es_body`. ProductFile#delete! is what Node hands back to Rails; those cases are recorded up to the call a marker
# exception stands in for. Run it like delete-product-files-archives-worker.rb (env as in publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases
capture_elasticsearch!

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/delete-product-files-worker.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[links product_files].freeze
DELETED = { deleted_at: "2026-11-01 00:00:00" }.freeze

Rails.logger = ActiveSupport::Logger.new(nil)

class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

ProductFile.prepend(Module.new do
  def delete!(*, **) = raise(HandBackMarker)
end)

def link_row(id, **overrides)
  { id:, name: "Product #{id}", user_id: 1, unique_permalink: "p#{id}", price_currency_type: "usd", flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def file_row(id, link: 1, **overrides)
  { id:, link_id: link, url: "https://example.com/file#{id}.pdf", flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def count_answer(value, relation: "eq") = { hits: { total: { value:, relation: }, max_score: nil, hits: [] }, took: 1, timed_out: false }

def run(name, args, seed: {}, es_body: count_answer(0))
  hands_back = false
  result = capture(name, now: NOW, tables: TABLES, seed:, sidekiq: true, job: "DeleteProductFilesWorker", args:, es_body:) do
    DeleteProductFilesWorker.new.perform(*args)
  rescue HandBackMarker
    hands_back = true
  end
  result.delete("rows")
  result.delete("seed")
  result.merge("hands_back" => hands_back)
end

cases = []
cases << run("a product that does not exist", [99])
cases << run("a product whose deletion was undone", [1], seed: { links: [link_row(1)], product_files: [file_row(1)] })
cases << run("a deleted product with sales", [1], seed: { links: [link_row(1, **DELETED)], product_files: [file_row(1)] }, es_body: count_answer(3))
cases << run("a deleted product with a single sale", [1], seed: { links: [link_row(1, **DELETED)], product_files: [file_row(1)] }, es_body: count_answer(1))
cases << run("a deleted product with a lower bound of sales", [1], seed: { links: [link_row(1, **DELETED)], product_files: [file_row(1)] }, es_body: count_answer(10_000, relation: "gte"))
cases << run("a deleted product with no sales and no files", [1], seed: { links: [link_row(1, **DELETED)] })
cases << run("a deleted product with no sales and a file", [1], seed: { links: [link_row(1, **DELETED)], product_files: [file_row(1)] })
cases << run("a deleted product with no sales and several files", [1], seed: { links: [link_row(1, **DELETED)], product_files: [file_row(2), file_row(1, deleted_at: SEEDED_AT)] })
cases << run("a deleted product whose files belong to another product", [1], seed: { links: [link_row(1, **DELETED), link_row(2)], product_files: [file_row(1, link: 2)] })
cases << run("a deleted product id given as a digit string", [1], seed: { links: [link_row(1, **DELETED)] })
cases << run("a deleted product id given as a digit string and a file", ["1"], seed: { links: [link_row(1, **DELETED)], product_files: [file_row(1)] })
cases << run("a product id of nil", [nil], seed: { links: [link_row(1, **DELETED)] })
cases << run("a product id given as a float", [1.0], seed: { links: [link_row(1, **DELETED)] })
cases << run("a product id given as a word", ["abc"], seed: { links: [link_row(1, **DELETED)] })
cases << run("two products with sales in the index", [2], seed: { links: [link_row(1, **DELETED), link_row(2, **DELETED)] }, es_body: count_answer(0))

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
