# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/create-licenses-for-existing-customers-worker.golden.json: CreateLicensesForExistingCustomersWorker
# run by the real app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). SecureRandom.uuid is a counter, so the
# serials the licenses get are reproducible. Run it like publish-scheduled-post.rb:
#
#   bundle exec rails runner nextjs/scripts/golden/create-licenses-for-existing-customers-worker.rb   (env as in publish-scheduled-post.rb)
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/create-licenses-for-existing-customers-worker.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[links purchases variant_categories base_variants base_variants_purchases rich_contents licenses versions].freeze
IS_LICENSED = Link.flag_mapping["flags"][:is_licensed]
IS_PHYSICAL = Link.flag_mapping["flags"][:is_physical]
SAME_CONTENT = Link.flag_mapping["flags"][:has_same_rich_content_for_all_variants]
ORIGINAL_SUBSCRIPTION = Purchase.flag_mapping["flags"][:is_original_subscription_purchase]
GIFT_SENDER = Purchase.flag_mapping["flags"][:is_gift_sender_purchase]

Rails.logger = ActiveSupport::Logger.new(nil)
$uuid = 0
SecureRandom.singleton_class.prepend(Module.new do
  def uuid
    format("00000000-0000-4000-8000-%012x", $uuid += 1)
  end
end)

def link_row(id = 1, **overrides) = { id:, user_id: 1, name: "Product #{id}", unique_permalink: "p#{id}", flags: IS_LICENSED, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
def sale(id, link: 1, **overrides) = { id:, seller_id: 1, link_id: link, email: "buyer#{id}@example.com", price_cents: 500, purchase_state: "successful", flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
def category(id, link: 1, **overrides) = { id:, link_id: link, title: "Category #{id}" }.merge(overrides)
def variant(id, category: 1, link: 1, **overrides) = { id:, variant_category_id: category, link_id: link, name: "Variant #{id}", type: "Variant", created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
def chosen(purchase, variant) = { purchase_id: purchase, base_variant_id: variant }
def page(id, entity, type: "BaseVariant", nodes: [], title: nil, **overrides) = { id:, entity_id: entity, entity_type: type, description: nodes.to_json, title:, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
def key_node = { "type" => "licenseKey" }
def text_node(text = "Hello") = { "type" => "paragraph", "content" => [{ "type" => "text", "text" => text }] }
def license(id, purchase, link: 1, serial: "AAAAAAAA-BBBBBBBB-CCCCCCCC-DDDDDDDD") = { id:, link_id: link, purchase_id: purchase, serial:, uses: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }

def run(name, seed, args = [1])
  $uuid = 0
  result = capture(name, now: NOW, tables: TABLES, seed:, sidekiq: true, job: "CreateLicensesForExistingCustomersWorker", args:) do
    CreateLicensesForExistingCustomersWorker.new.perform(*args)
  end
  result.delete("seed")
  result
end

cases = []
cases << run("a product that does not exist", {}, [99])
cases << run("a product id of nil", { links: [link_row] }, [nil])
cases << run("a product id given as a digit string", { links: [link_row], purchases: [sale(1)] }, ["1"])
cases << run("a product id given as a float", { links: [link_row] }, [1.0])
cases << run("a product id given as a word", { links: [link_row] }, ["abc"])
cases << run("a product with no sales", { links: [link_row] })
cases << run("a product with one sale", { links: [link_row], purchases: [sale(1)] })
cases << run("a sale that already has a license", { links: [link_row], purchases: [sale(1)], licenses: [license(1, 1)] })
cases << run("a license of another product's sale", { links: [link_row, link_row(2)], purchases: [sale(1)], licenses: [license(1, 1, link: 2)] })
cases << run("three sales, one licensed", { links: [link_row], purchases: [sale(1), sale(2), sale(3)], licenses: [license(1, 2)] })
cases << run("a sale of another product", { links: [link_row, link_row(2)], purchases: [sale(1, link: 2)] })
cases << run("a failed sale", { links: [link_row], purchases: [sale(1, purchase_state: "failed")] })
cases << run("a gift receiver sale", { links: [link_row], purchases: [sale(1, purchase_state: "gift_receiver_purchase_successful")] })
cases << run("a gift sender sale", { links: [link_row], purchases: [sale(1, flags: GIFT_SENDER)] })
cases << run("a recurring charge", { links: [link_row], purchases: [sale(1, subscription_id: 5)] })
cases << run("an original subscription sale", { links: [link_row], purchases: [sale(1, subscription_id: 5, flags: ORIGINAL_SUBSCRIPTION)] })
cases << run("a product that is not licensed", { links: [link_row(1, flags: 0)], purchases: [sale(1)] })
cases << run("a physical product with a variant", { links: [link_row(1, flags: IS_LICENSED | IS_PHYSICAL)], purchases: [sale(1)], variant_categories: [category(1)], base_variants: [variant(1)], base_variants_purchases: [chosen(1, 1)] })
cases << run("a sale of a variant with no page", { links: [link_row], purchases: [sale(1)], variant_categories: [category(1)], base_variants: [variant(1)], base_variants_purchases: [chosen(1, 1)] })
cases << run("a sale of a variant whose page has a license key", { links: [link_row], purchases: [sale(1)], variant_categories: [category(1)], base_variants: [variant(1)], base_variants_purchases: [chosen(1, 1)], rich_contents: [page(1, 1, nodes: [key_node])] })
cases << run("a sale of a variant whose page has none", { links: [link_row], purchases: [sale(1)], variant_categories: [category(1)], base_variants: [variant(1)], base_variants_purchases: [chosen(1, 1)], rich_contents: [page(1, 1, nodes: [text_node])] })
cases << run("a sale of a variant whose page nests a license key", { links: [link_row], purchases: [sale(1)], variant_categories: [category(1)], base_variants: [variant(1)], base_variants_purchases: [chosen(1, 1)], rich_contents: [page(1, 1, nodes: [{ "type" => "bulletList", "content" => [{ "type" => "listItem", "content" => [key_node] }] }])] })
cases << run("a sale of a variant with a deleted page", { links: [link_row], purchases: [sale(1)], variant_categories: [category(1)], base_variants: [variant(1)], base_variants_purchases: [chosen(1, 1)], rich_contents: [page(1, 1, nodes: [text_node], deleted_at: SEEDED_AT)] })
cases << run("a sale of two variants, one with the key", { links: [link_row], purchases: [sale(1)], variant_categories: [category(1)], base_variants: [variant(1), variant(2)], base_variants_purchases: [chosen(1, 1), chosen(1, 2)], rich_contents: [page(1, 1, nodes: [text_node]), page(2, 2, nodes: [key_node])] })
cases << run("a sale of a deleted variant", { links: [link_row], purchases: [sale(1)], variant_categories: [category(1)], base_variants: [variant(1, deleted_at: SEEDED_AT), variant(2)], base_variants_purchases: [chosen(1, 1)], rich_contents: [page(1, 1, nodes: [text_node])] })
cases << run("a product with variants and product level content", { links: [link_row(1, flags: IS_LICENSED | SAME_CONTENT)], purchases: [sale(1)], variant_categories: [category(1)], base_variants: [variant(1)], base_variants_purchases: [chosen(1, 1)], rich_contents: [page(1, 1, nodes: [text_node]), page(2, 1, type: "Link", nodes: [text_node])] })
cases << run("a product sharing a page with hidden variant pages", { links: [link_row(1, flags: IS_LICENSED | SAME_CONTENT)], purchases: [sale(1)], variant_categories: [category(1)], base_variants: [variant(1)], base_variants_purchases: [chosen(1, 1)], rich_contents: [page(1, 1, nodes: [text_node])] })
cases << run("a product sharing a page with hidden variant pages with a key", { links: [link_row(1, flags: IS_LICENSED | SAME_CONTENT)], purchases: [sale(1)], variant_categories: [category(1)], base_variants: [variant(1)], base_variants_purchases: [chosen(1, 1)], rich_contents: [page(1, 1, nodes: [key_node])] })
cases << run("a product sharing an empty page with hidden variant pages", { links: [link_row(1, flags: IS_LICENSED | SAME_CONTENT)], purchases: [sale(1)], variant_categories: [category(1)], base_variants: [variant(1)], base_variants_purchases: [chosen(1, 1)], rich_contents: [page(1, 1, nodes: [text_node]), page(2, 1, type: "Link", nodes: [])] })
cases << run("a product sharing a titled page with hidden variant pages", { links: [link_row(1, flags: IS_LICENSED | SAME_CONTENT)], purchases: [sale(1)], variant_categories: [category(1)], base_variants: [variant(1)], base_variants_purchases: [chosen(1, 1)], rich_contents: [page(1, 1, nodes: [text_node]), page(2, 1, type: "Link", nodes: [], title: "Title")] })
cases << run("a sale with no variant of a product with variants", { links: [link_row], purchases: [sale(1)], variant_categories: [category(1)], base_variants: [variant(1)], rich_contents: [page(1, 1, nodes: [text_node])] })
cases << run("a sale with a variant of a deleted category", { links: [link_row], purchases: [sale(1)], variant_categories: [category(1, deleted_at: SEEDED_AT)], base_variants: [variant(1)], base_variants_purchases: [chosen(1, 1)], rich_contents: [page(1, 1, nodes: [text_node])] })
cases << run("two sales of variants", { links: [link_row], purchases: [sale(1), sale(2)], variant_categories: [category(1)], base_variants: [variant(1), variant(2)], base_variants_purchases: [chosen(1, 1), chosen(2, 2)], rich_contents: [page(1, 1, nodes: [text_node]), page(2, 2, nodes: [key_node])] })
cases << run("a sale of a variant of a sku product", { links: [link_row], purchases: [sale(1)], variant_categories: [category(1)], base_variants: [variant(1, type: "Sku")], base_variants_purchases: [chosen(1, 1)] })

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
