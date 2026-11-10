# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/delete-product-files-archives-worker.golden.json: DeleteProductFilesArchivesWorker run by
# the real app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). The first ProductFilesArchive#mark_deleted!
# is what Node hands back to Rails; those cases are recorded up to the call a marker exception stands in for. Run it like
# delete-wishlist-products-job.rb:
#
#   bundle exec rails runner nextjs/scripts/golden/delete-product-files-archives-worker.rb   (env as in publish-scheduled-post.rb)
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/delete-product-files-archives-worker.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[links variant_categories base_variants product_files_archives].freeze

Rails.logger = ActiveSupport::Logger.new(nil)

class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

ProductFilesArchive.prepend(Module.new do
  def mark_deleted!(*, **) = raise(HandBackMarker)
end)

def link_row(id, **overrides)
  { id:, name: "Product #{id}", user_id: 1, unique_permalink: "p#{id}", price_currency_type: "usd", flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def category_row(id, link_id, **overrides)
  { id:, link_id:, title: "Versions", flags: 0 }.merge(overrides)
end

def variant_row(id, category_id, **overrides)
  { id:, variant_category_id: category_id, name: "Variant #{id}", type: "Variant", flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def archive_row(id, **overrides)
  { id:, product_files_archive_state: "ready", created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

DELETED = { deleted_at: "2026-11-01 00:00:00" }.freeze

def run(name, args, seed: {})
  hands_back = false
  result = capture(name, now: NOW, tables: TABLES, seed:, sidekiq: true, job: "DeleteProductFilesArchivesWorker", args:) do
    DeleteProductFilesArchivesWorker.new.perform(*args)
  rescue HandBackMarker
    hands_back = true
  end
  result.delete("rows")
  result.delete("seed")
  result.merge("hands_back" => hands_back)
end

cases = []
cases << run("no arguments", [])
cases << run("both arguments nil", [nil, nil])
cases << run("the product does not exist", [99])
cases << run("a product whose deletion was undone", [1], seed: { links: [link_row(1)], product_files_archives: [archive_row(1, link_id: 1)] })
cases << run("a deleted product without archives or variants", [1], seed: { links: [link_row(1, **DELETED)] })
cases << run("a deleted product with only deleted archives", [1], seed: { links: [link_row(1, **DELETED)], product_files_archives: [archive_row(1, link_id: 1, **DELETED)] })
cases << run("a deleted product whose only archive belongs to another product", [1], seed: { links: [link_row(1, **DELETED), link_row(2)], product_files_archives: [archive_row(1, link_id: 2)] })
cases << run("a deleted product with a live archive", [1], seed: { links: [link_row(1, **DELETED)], product_files_archives: [archive_row(1, link_id: 1)] })
cases << run("the id as digits", ["1"], seed: { links: [link_row(1, **DELETED)], product_files_archives: [archive_row(1, link_id: 1)] })

two_variants = { links: [link_row(1, **DELETED)], variant_categories: [category_row(1, 1)], base_variants: [variant_row(1, 1), variant_row(2, 1)] }
cases << run("a deleted product whose variants have no archives", [1], seed: two_variants)
cases << run("a deleted product whose second variant has a live archive", [1], seed: two_variants.merge(product_files_archives: [archive_row(1, variant_id: 2)]))
cases << run("a deleted product whose variants have only deleted archives", [1], seed: two_variants.merge(product_files_archives: [archive_row(1, variant_id: 1, **DELETED), archive_row(2, variant_id: 2, **DELETED)]))
cases << run("a deleted product with a deleted variant carrying a live archive", [1], seed: { links: [link_row(1, **DELETED)], variant_categories: [category_row(1, 1)], base_variants: [variant_row(1, 1, **DELETED)], product_files_archives: [archive_row(1, variant_id: 1)] })
cases << run("a deleted product with a variant in a deleted category", [1], seed: { links: [link_row(1, **DELETED)], variant_categories: [category_row(1, 1, **DELETED)], base_variants: [variant_row(1, 1)], product_files_archives: [archive_row(1, variant_id: 1)] })
cases << run("a deleted product with a SKU carrying a live archive", [1], seed: { links: [link_row(1, **DELETED)], variant_categories: [category_row(1, 1)], base_variants: [variant_row(1, 1, type: "Sku")], product_files_archives: [archive_row(1, variant_id: 1)] })

alive_variant = { links: [link_row(1)], variant_categories: [category_row(1, 1)], base_variants: [variant_row(1, 1)] }
cases << run("the variant does not exist", [nil, 99])
cases << run("the variant does not exist, with a product", [1, 99], seed: { links: [link_row(1)] })
cases << run("a variant whose deletion was undone", [nil, 1], seed: alive_variant.merge(product_files_archives: [archive_row(1, variant_id: 1)]))
cases << run("a variant whose deletion was undone, with a product", [1, 1], seed: alive_variant)
cases << run("a variant with a product that does not exist", [99, 1], seed: alive_variant)
cases << run("a deleted variant without archives", [nil, 1], seed: alive_variant.merge(base_variants: [variant_row(1, 1, **DELETED)]))
cases << run("a deleted variant without archives, with a product", [1, 1], seed: alive_variant.merge(base_variants: [variant_row(1, 1, **DELETED)]))
cases << run("a deleted variant with a live archive", [nil, 1], seed: alive_variant.merge(base_variants: [variant_row(1, 1, **DELETED)], product_files_archives: [archive_row(1, variant_id: 1)]))
cases << run("a deleted variant with a live archive, product alive", [1, 1], seed: alive_variant.merge(base_variants: [variant_row(1, 1, **DELETED)], product_files_archives: [archive_row(1, variant_id: 1)]))
cases << run("a deleted variant with only deleted archives", [nil, 1], seed: alive_variant.merge(base_variants: [variant_row(1, 1, **DELETED)], product_files_archives: [archive_row(1, variant_id: 1, **DELETED)]))
cases << run("a deleted variant whose product link is missing", [nil, 1], seed: { variant_categories: [category_row(1, 99)], base_variants: [variant_row(1, 1, **DELETED)] })
cases << run("the variant id as digits", [nil, "1"], seed: alive_variant.merge(base_variants: [variant_row(1, 1, **DELETED)], product_files_archives: [archive_row(1, variant_id: 1)]))
cases << run("the variant of a deleted product, ignoring the product's own archives", [1, 1], seed: { links: [link_row(1, **DELETED)], variant_categories: [category_row(1, 1)], base_variants: [variant_row(1, 1)], product_files_archives: [archive_row(1, link_id: 1)] })

cases << run("a variant without a category", [nil, 1], seed: { base_variants: [variant_row(1, nil, **DELETED)] })
cases << run("a variant without a category, with a product", [1, 1], seed: { links: [link_row(1)], base_variants: [variant_row(1, nil, **DELETED)] })
cases << run("a variant whose category row is missing", [nil, 1], seed: { base_variants: [variant_row(1, 99, **DELETED)] })
cases << run("a variant whose category has no product", [nil, 1], seed: { variant_categories: [category_row(1, nil)], base_variants: [variant_row(1, 1, **DELETED)] })
cases << run("a SKU without a category", [nil, 1], seed: { base_variants: [variant_row(1, nil, type: "Sku", **DELETED)] })
cases << run("a SKU whose deletion was undone, with a product", [1, 1], seed: { links: [link_row(1)], base_variants: [variant_row(1, nil, type: "Sku")] })

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
