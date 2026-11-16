# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/delete-product-rich-content-worker.golden.json: DeleteProductRichContentWorker run by
# the real app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). Run it like
# delete-product-files-archives-worker.rb:
#
#   bundle exec rails runner nextjs/scripts/golden/delete-product-rich-content-worker.rb   (env as in publish-scheduled-post.rb)
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/delete-product-rich-content-worker.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[links variant_categories base_variants rich_contents versions].freeze

Rails.logger = ActiveSupport::Logger.new(nil)

def link_row(id, **overrides)
  { id:, name: "Product #{id}", user_id: 1, unique_permalink: "p#{id}", price_currency_type: "usd", flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def category_row(id, link_id, **overrides)
  { id:, link_id:, title: "Versions", flags: 0 }.merge(overrides)
end

def variant_row(id, category_id, **overrides)
  { id:, variant_category_id: category_id, name: "Variant #{id}", type: "Variant", flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

PARAGRAPH = '[{"type":"paragraph","content":[{"type":"text","text":"Hello <b>there</b> & welcome"}]}]'

def content_row(id, entity_id, entity_type: "Link", description: PARAGRAPH, **overrides)
  { id:, entity_id:, entity_type:, description:, title: "Page #{id}", position: id, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

DELETED = { deleted_at: "2026-11-01 00:00:00" }.freeze

def run(name, args, seed: {})
  result = capture(name, now: NOW, tables: TABLES, seed:, sidekiq: true, job: "DeleteProductRichContentWorker", args:) do
    DeleteProductRichContentWorker.new.perform(*args)
  end
  result.delete("rows")
  result.delete("seed")
  result
end

cases = []
cases << run("no arguments", [])
cases << run("too many arguments", [1, nil, 3])
cases << run("the product does not exist", [99])
cases << run("an alive product without rich content", [1], seed: { links: [link_row(1)] })
cases << run("a deleted product without rich content", [1], seed: { links: [link_row(1, **DELETED)] })
cases << run("an alive product with rich content", [1], seed: { links: [link_row(1)], rich_contents: [content_row(1, 1)] })
cases << run("a deleted product with rich content", [1], seed: { links: [link_row(1, **DELETED)], rich_contents: [content_row(1, 1)] })
cases << run("the id as digits", ["1"], seed: { links: [link_row(1, **DELETED)], rich_contents: [content_row(1, 1)] })
cases << run("a blank variant id counts as none", [1, ""], seed: { links: [link_row(1, **DELETED)], rich_contents: [content_row(1, 1)] })
cases << run("a deleted product with only deleted rich content", [1], seed: { links: [link_row(1, **DELETED)], rich_contents: [content_row(1, 1, **DELETED)] })
cases << run("a deleted product with rich content of another product", [1], seed: { links: [link_row(1, **DELETED), link_row(2)], rich_contents: [content_row(1, 2)] })
cases << run("a deleted product with rich content of a variant with the same id", [1], seed: { links: [link_row(1, **DELETED)], variant_categories: [category_row(1, 1)], base_variants: [variant_row(1, 1)], rich_contents: [content_row(1, 1, entity_type: "BaseVariant")] })
cases << run("a deleted product with three pages, some already deleted", [1], seed: { links: [link_row(1, **DELETED)], rich_contents: [content_row(1, 1), content_row(2, 1, **DELETED), content_row(3, 1, position: 0)] })
cases << run("a page without a title", [1], seed: { links: [link_row(1, **DELETED)], rich_contents: [content_row(1, 1, title: nil)] })
cases << run("a page with an empty description", [1], seed: { links: [link_row(1, **DELETED)], rich_contents: [content_row(1, 1, description: "[]")] })
cases << run("a page with a nested description", [1], seed: { links: [link_row(1, **DELETED)], rich_contents: [content_row(1, 1, description: '[{"type":"orderedList","attrs":{"start":1},"content":[{"type":"listItem","content":[{"type":"paragraph","marks":[{"type":"bold"}],"content":[{"type":"text","text":"é "}]}]}]}]')] })
cases << run("a page whose description is not an array", [1], seed: { links: [link_row(1, **DELETED)], rich_contents: [content_row(1, 1, description: '{"type":"paragraph"}')] })
cases << run("a page whose description is a JSON string", [1], seed: { links: [link_row(1, **DELETED)], rich_contents: [content_row(1, 1, description: '"abc"')] })
cases << run("a page whose description is a JSON string holding an array", [1], seed: { links: [link_row(1, **DELETED)], rich_contents: [content_row(1, 1, description: '"[]"')] })
cases << run("a page whose description is JSON null", [1], seed: { links: [link_row(1, **DELETED)], rich_contents: [content_row(1, 1, description: "null")] })
cases << run("a page whose description is a number", [1], seed: { links: [link_row(1, **DELETED)], rich_contents: [content_row(1, 1, description: "5")] })
cases << run("a page whose description is an empty object", [1], seed: { links: [link_row(1, **DELETED)], rich_contents: [content_row(1, 1, description: "{}")] })
cases << run("a page whose text is null", [1], seed: { links: [link_row(1, **DELETED)], rich_contents: [content_row(1, 1, description: '[{"type":"text","text":null}]')] })
cases << run("a page with a float and a deep nesting", [1], seed: { links: [link_row(1, **DELETED)], rich_contents: [content_row(1, 1, description: '[{"type":"image","attrs":{"width":1.5,"nested":{"a":[1,2,{"b":null}]}},"content":[{"type":"x","content":[]}]}]')] })
cases << run("a page whose node type is not a string", [1], seed: { links: [link_row(1, **DELETED)], rich_contents: [content_row(1, 1, description: '[{"type":5}]')] })
cases << run("a page whose node attrs is not an object", [1], seed: { links: [link_row(1, **DELETED)], rich_contents: [content_row(1, 1, description: '[{"type":"paragraph","attrs":[]}]')] })
cases << run("a page whose node content holds a bad node", [1], seed: { links: [link_row(1, **DELETED)], rich_contents: [content_row(1, 1, description: '[{"type":"paragraph","content":[{"text":7}]}]')] })
cases << run("a page whose mark has no type", [1], seed: { links: [link_row(1, **DELETED)], rich_contents: [content_row(1, 1, description: '[{"type":"paragraph","marks":[{"attrs":{}}]}]')] })
cases << run("a page whose item is not an object", [1], seed: { links: [link_row(1, **DELETED)], rich_contents: [content_row(1, 1, description: '["text"]')] })
cases << run("a page that is invalid after a valid one", [1], seed: { links: [link_row(1, **DELETED)], rich_contents: [content_row(1, 1), content_row(2, 1, description: '[{"type":5}]'), content_row(3, 1)] })

two_variants = { links: [link_row(1, **DELETED)], variant_categories: [category_row(1, 1)], base_variants: [variant_row(1, 1), variant_row(2, 1)] }
cases << run("a deleted product whose variants have no rich content", [1], seed: two_variants)
cases << run("a deleted product with rich content on the product and its variants", [1], seed: two_variants.merge(rich_contents: [content_row(1, 1), content_row(2, 1, entity_type: "BaseVariant"), content_row(3, 2, entity_type: "BaseVariant")]))
cases << run("a deleted product whose second variant has rich content", [1], seed: two_variants.merge(rich_contents: [content_row(1, 2, entity_type: "BaseVariant")]))
cases << run("an alive product whose variants have rich content", [1], seed: two_variants.merge(links: [link_row(1)], rich_contents: [content_row(1, 1, entity_type: "BaseVariant")]))
cases << run("a deleted product with a deleted variant carrying rich content", [1], seed: { links: [link_row(1, **DELETED)], variant_categories: [category_row(1, 1)], base_variants: [variant_row(1, 1, **DELETED)], rich_contents: [content_row(1, 1, entity_type: "BaseVariant")] })
cases << run("a deleted product with a variant in a deleted category", [1], seed: { links: [link_row(1, **DELETED)], variant_categories: [category_row(1, 1, **DELETED)], base_variants: [variant_row(1, 1)], rich_contents: [content_row(1, 1, entity_type: "BaseVariant")] })
cases << run("a deleted product with a SKU carrying rich content", [1], seed: { links: [link_row(1, **DELETED)], variant_categories: [category_row(1, 1)], base_variants: [variant_row(1, 1, type: "Sku")], rich_contents: [content_row(1, 1, entity_type: "BaseVariant")] })

alive_variant = { links: [link_row(1)], variant_categories: [category_row(1, 1)], base_variants: [variant_row(1, 1)] }
deleted_variant = alive_variant.merge(base_variants: [variant_row(1, 1, **DELETED)])
cases << run("the variant does not exist", [1, 99], seed: { links: [link_row(1)] })
cases << run("the product does not exist, with a variant", [99, 1], seed: alive_variant)
cases << run("an alive variant with rich content", [1, 1], seed: alive_variant.merge(rich_contents: [content_row(1, 1, entity_type: "BaseVariant")]))
cases << run("a deleted variant without rich content", [1, 1], seed: deleted_variant)
cases << run("a deleted variant with rich content", [1, 1], seed: deleted_variant.merge(rich_contents: [content_row(1, 1, entity_type: "BaseVariant"), content_row(2, 1, entity_type: "BaseVariant", **DELETED)]))
cases << run("a deleted variant leaves the product's rich content alone", [1, 1], seed: deleted_variant.merge(links: [link_row(1, **DELETED)], rich_contents: [content_row(1, 1), content_row(2, 1, entity_type: "BaseVariant")]))
cases << run("the variant id as digits", [1, "1"], seed: deleted_variant.merge(rich_contents: [content_row(1, 1, entity_type: "BaseVariant")]))
cases << run("a deleted SKU with rich content", [1, 1], seed: deleted_variant.merge(base_variants: [variant_row(1, 1, type: "Sku", **DELETED)], rich_contents: [content_row(1, 1, entity_type: "BaseVariant")]))
cases << run("a deleted variant with an invalid page", [1, 1], seed: deleted_variant.merge(rich_contents: [content_row(1, 1, entity_type: "BaseVariant", description: '[{"type":5}]')]))
cases << run("the variant of another product", [2, 1], seed: deleted_variant.merge(links: [link_row(1), link_row(2)], rich_contents: [content_row(1, 1, entity_type: "BaseVariant")]))

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
