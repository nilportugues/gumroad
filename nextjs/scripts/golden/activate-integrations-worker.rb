# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/activate-integrations-worker.golden.json: ActivateIntegrationsWorker run by the real
# app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). Purchase#find_enabled_integration picks the variant's
# integration (a physical product's goes through the product); a Circle integration found means a CircleApi call, which Node hands
# back to Rails, so those cases are recorded up to it, which a marker exception stands in for.
# Run it like pdf-unstampable-notifier-job.rb (env as in publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/activate-integrations-worker.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[purchases links integrations product_integrations base_variants base_variants_purchases base_variant_integrations].freeze
IS_PHYSICAL = 1 << 7

Rails.logger = ActiveSupport::Logger.new(nil)

class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

CircleApi.prepend(Module.new do
  def add_member(*) = raise(HandBackMarker)
end)

def link_row(id, **overrides) = { id:, name: "Product #{id}", user_id: 1, unique_permalink: "p#{id}", price_currency_type: "usd", flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)

def purchase_row(id, link_id: 1, **overrides)
  { id:, link_id:, seller_id: 1, email: "buyer#{id}@example.com", purchase_state: "successful", price_cents: 100, flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def integration_row(id, type, **overrides) = { id:, type:, api_key: "key#{id}", flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)

def product_integration_row(id, product_id, integration_id, **overrides) = { id:, product_id:, integration_id:, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)

def variant_row(id, **overrides) = { id:, name: "Option #{id}", type: "Variant", variant_category_id: 1, link_id: nil, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)

def variant_integration_row(id, variant_id, integration_id, **overrides) = { id:, base_variant_id: variant_id, integration_id:, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)

def run(name, args, seed)
  hands_back = false
  result = capture(name, now: NOW, tables: TABLES, seed:, sidekiq: true, job: "ActivateIntegrationsWorker", args:) do
    ActivateIntegrationsWorker.new.perform(*args)
  rescue HandBackMarker
    hands_back = true
  end
  result.delete("rows")
  result.delete("seed")
  result.merge("hands_back" => hands_back)
end

def seed(**tables) = { links: [link_row(1)], purchases: [purchase_row(1)] }.merge(tables)

CIRCLE = "CircleIntegration"
DISCORD = "DiscordIntegration"
ZOOM = "ZoomIntegration"

cases = []
cases << run("a purchase that does not exist", [9], seed)
cases << run("a product with no integration", [1], seed)
cases << run("a product with a circle integration", [1], seed(integrations: [integration_row(1, CIRCLE)], product_integrations: [product_integration_row(1, 1, 1)]))
cases << run("a product whose circle integration was deleted", [1], seed(integrations: [integration_row(1, CIRCLE)], product_integrations: [product_integration_row(1, 1, 1, deleted_at: SEEDED_AT)]))
cases << run("a product with only a discord integration", [1], seed(integrations: [integration_row(1, DISCORD)], product_integrations: [product_integration_row(1, 1, 1)]))
cases << run("a product with a zoom and a circle integration", [1], seed(integrations: [integration_row(1, ZOOM), integration_row(2, CIRCLE)], product_integrations: [product_integration_row(1, 1, 1), product_integration_row(2, 1, 2)]))
cases << run("a circle integration of another product", [1], seed(links: [link_row(1), link_row(2)], integrations: [integration_row(1, CIRCLE)], product_integrations: [product_integration_row(1, 2, 1)]))
cases << run("a purchase of another product than the circle one", [2], seed(links: [link_row(1), link_row(2)], purchases: [purchase_row(1), purchase_row(2, link_id: 2)], integrations: [integration_row(1, CIRCLE)], product_integrations: [product_integration_row(1, 1, 1)]))
cases << run("a purchase whose product is gone", [1], seed(links: []))
cases << run("a variant with a circle integration", [1], seed(base_variants: [variant_row(1)], base_variants_purchases: [{ id: 1, purchase_id: 1, base_variant_id: 1 }], integrations: [integration_row(1, CIRCLE)], base_variant_integrations: [variant_integration_row(1, 1, 1)]))
cases << run("a variant with no integration under a product with a circle one", [1], seed(base_variants: [variant_row(1)], base_variants_purchases: [{ id: 1, purchase_id: 1, base_variant_id: 1 }], integrations: [integration_row(1, CIRCLE)], product_integrations: [product_integration_row(1, 1, 1)]))
cases << run("a variant whose circle integration was deleted", [1], seed(base_variants: [variant_row(1)], base_variants_purchases: [{ id: 1, purchase_id: 1, base_variant_id: 1 }], integrations: [integration_row(1, CIRCLE)], base_variant_integrations: [variant_integration_row(1, 1, 1, deleted_at: SEEDED_AT)]))
cases << run("a variant of a physical product reads the product", [1], seed(links: [link_row(1, flags: IS_PHYSICAL)], base_variants: [variant_row(1)], base_variants_purchases: [{ id: 1, purchase_id: 1, base_variant_id: 1 }], integrations: [integration_row(1, CIRCLE)], product_integrations: [product_integration_row(1, 1, 1)]))
cases << run("a variant of a physical product with a variant integration only", [1], seed(links: [link_row(1, flags: IS_PHYSICAL)], base_variants: [variant_row(1)], base_variants_purchases: [{ id: 1, purchase_id: 1, base_variant_id: 1 }], integrations: [integration_row(1, CIRCLE)], base_variant_integrations: [variant_integration_row(1, 1, 1)]))
cases << run("two variants, only the second with an integration", [1], seed(base_variants: [variant_row(1), variant_row(2)], base_variants_purchases: [{ id: 1, purchase_id: 1, base_variant_id: 1 }, { id: 2, purchase_id: 1, base_variant_id: 2 }], integrations: [integration_row(1, CIRCLE)], base_variant_integrations: [variant_integration_row(1, 2, 1)]))
cases << run("two variants, only the first with an integration", [1], seed(base_variants: [variant_row(1), variant_row(2)], base_variants_purchases: [{ id: 1, purchase_id: 1, base_variant_id: 1 }, { id: 2, purchase_id: 1, base_variant_id: 2 }], integrations: [integration_row(1, CIRCLE)], base_variant_integrations: [variant_integration_row(1, 1, 1)]))
cases << run("a sku purchase", [1], seed(base_variants: [variant_row(1, type: "Sku", variant_category_id: nil, link_id: 1)], base_variants_purchases: [{ id: 1, purchase_id: 1, base_variant_id: 1 }], integrations: [integration_row(1, CIRCLE)], base_variant_integrations: [variant_integration_row(1, 1, 1)]))
cases << run("a purchase id as a digit string", ["1"], seed)
cases << run("a purchase id of nil", [nil], seed)
cases << run("a purchase id as a float", [1.0], seed)
cases << run("a purchase id as a word", ["one"], seed)

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
