# frozen_string_literal: true

# Row builders shared by the integration worker goldens (activate/deactivate/update-on-tier-change).
SEEDED_AT = "2026-01-01 00:00:00"
IS_PHYSICAL = 1 << 7
KEEP_INACTIVE_MEMBERS = 1
CIRCLE = "CircleIntegration"
DISCORD = "DiscordIntegration"
ZOOM = "ZoomIntegration"
INTEGRATION_TABLES = %w[purchases links integrations product_integrations base_variants base_variants_purchases base_variant_integrations purchase_integrations subscriptions].freeze

class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

# A Discord member removal is what Node hands back; those cases are recorded up to it. Circle's calls are answered by WebMock
# (the including generator calls `capture_http!`): `http` holds each request Rails sent, `http_responses` each answer it got.
DiscordApi.prepend(Module.new do
  def remove_member(*) = raise(HandBackMarker)
end)
CIRCLE_DETAILS = { community_id: "100", space_group_id: "200" }.freeze
def circle_answer(status = 200, body = {}) = { status:, body: body.to_json, headers: { "Content-Type" => "application/json" } }

def link_row(id, **overrides) = { id:, name: "Product #{id}", user_id: 1, unique_permalink: "p#{id}", price_currency_type: "usd", flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)

def purchase_row(id, link_id: 1, **overrides)
  { id:, link_id:, seller_id: 1, email: "buyer#{id}@example.com", purchase_state: "successful", price_cents: 100, flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def integration_row(id, type, **overrides)
  json = type == CIRCLE ? { json_data: CIRCLE_DETAILS.to_json } : {}
  { id:, type:, api_key: "key#{id}", flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(json).merge(overrides)
end

def product_integration_row(id, product_id, integration_id, **overrides) = { id:, product_id:, integration_id:, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)

def variant_row(id, **overrides) = { id:, name: "Option #{id}", type: "Variant", variant_category_id: 1, link_id: nil, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)

def variant_integration_row(id, variant_id, integration_id, **overrides) = { id:, base_variant_id: variant_id, integration_id:, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)

def purchase_integration_row(id, purchase_id, integration_id, **overrides) = { id:, purchase_id:, integration_id:, discord_user_id: nil, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)

def subscription_row(id, **overrides) = { id:, link_id: 1, user_id: 1, flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)

def habtm_row(id, purchase_id, variant_id) = { id:, purchase_id:, base_variant_id: variant_id }

def seed(**tables) = { links: [link_row(1)], purchases: [purchase_row(1)] }.merge(tables)

def run_job(job_class, name, args, seed, http = [])
  hands_back = false
  result = capture(name, now: NOW, tables: INTEGRATION_TABLES, seed:, sidekiq: true, job: job_class.name, args:, http_responses: http) do
    job_class.new.perform(*args)
  rescue HandBackMarker
    hands_back = true
  end
  result.delete("rows")
  result.delete("seed")
  result.merge("hands_back" => hands_back)
end
