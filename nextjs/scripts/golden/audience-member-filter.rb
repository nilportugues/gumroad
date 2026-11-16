# frozen_string_literal: true

# Produces nextjs/src/server/models/__fixtures__/audience-member-filter.golden.json: the SQL that
# AudienceMember.filter builds (the relation's to_sql, and the statement `.first` sends) for a matrix of
# filter params and options, the params it rejects, and ActiveSupport's Date#in_time_zone for the zones a
# seller can pick (what Installment#audience_members_filter_params turns a stored filter date into).
# No rows are needed: the statements are the proof. Run it like schedule-workflow-installment.rb:
#
#   RAILS_ENV=test DATABASE_NAME=gumroad_ws63 TEST_DATABASE_NAME=gumroad_ws63 DISABLE_TEST_REDIS_ISOLATION=1 \
#     USE_DB_WORKER_REPLICAS=true REDIS_HOST=127.0.0.1:6379/13 SIDEKIQ_REDIS_HOST=127.0.0.1:6379/13 \
#     RPUSH_REDIS_HOST=127.0.0.1:6379/13 RACK_ATTACK_REDIS_HOST=127.0.0.1:6379/13 \
#     bundle exec ruby bin/rails runner nextjs/scripts/golden/audience-member-filter.rb
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/server/models/__fixtures__/audience-member-filter.golden.json")
NOW = Time.utc(2025, 11, 1, 12, 30, 45, 123_456)
AS_OF = Time.utc(2025, 10, 1, 8, 15, 30)
AFTER = "2025-01-01T00:00:00-08:00"
BEFORE = "2025-01-31T23:59:59-08:00"

def statement_of_first(relation)
  statements = RailsRecorder.recording { relation.first }
  statements.map { _1["sql"] }
end

def statements_of
  RailsRecorder.recording { yield }.map { _1["sql"] }
end

def filter_case(params, options = {})
  build = -> { AudienceMember.filter(seller_id: 1, params:, **options) }
  error = nil
  begin
    build.call
  rescue StandardError => e
    error = { "class" => e.class.name, "message" => e.message }
  end
  entry = { "params" => params, "options" => options.transform_values { _1.is_a?(Time) ? _1.utc.strftime("%Y-%m-%dT%H:%M:%S.%6NZ") : _1 }, "error" => error }
  return entry if error

  # Each statement comes from a relation of its own: `to_sql` builds the Arel tree the relation then reuses, which
  # `first` would send without its ORDER BY and LIMIT.
  statements = lambda do |&block|
    travel_to(NOW, with_usec: true) { ActiveRecord::Base.uncached { statements_of(&block) } }
  end
  entry.merge("sql" => build.call.to_sql, "first" => statements.call { build.call.first },
              "count" => options[:with_ids] ? nil : statements.call { build.call.count },
              "count_limit" => options[:with_ids] ? nil : statements.call { build.call.limit(5).count })
end

BASE_PARAMS = [
  {},
  { type: "customer" },
  { type: "follower" },
  { type: "affiliate" },
  { type: "bogus" },
  { bought_product_ids: [1] },
  { bought_product_ids: [1, 2, 3] },
  { bought_variant_ids: [7] },
  { bought_variant_ids: [7, 8] },
  { bought_product_ids: [1, 2], bought_variant_ids: [7, 8] },
  { not_bought_product_ids: [1] },
  { not_bought_product_ids: [1, 2] },
  { not_bought_variant_ids: [7] },
  { not_bought_variant_ids: [7, 8] },
  { not_bought_product_ids: [1], not_bought_variant_ids: [7] },
  { paid_more_than_cents: 500 },
  { paid_less_than_cents: 2000 },
  { paid_more_than_cents: 500, paid_less_than_cents: 2000 },
  { created_after: AFTER },
  { created_before: BEFORE },
  { created_after: AFTER, created_before: BEFORE },
  { bought_from: "United States" },
  { bought_from: "Côte d'Ivoire" },
  { active_customers_only: true },
  { active_customers_only: "0" },
  { active_customers_only: "1" },
  { active_customers_only: false },
  { minimum_license_uses: 3 },
  { affiliate_product_ids: [4] },
  { affiliate_product_ids: [4, 5] },
  { waitlisted_product_ids: [9] },
  { waitlisted_product_ids: [9, 10] },
  { waitlisted_product_ids: [nil] },
  { exclude_emails: ["a@example.com"] },
  { exclude_emails: ["a@example.com", "b@example.com"] },
  { exclude_emails: [] },
  { type: "customer", bought_product_ids: [1] },
  { type: "customer", bought_product_ids: [1], paid_more_than_cents: 500 },
  { type: "customer", bought_product_ids: [1], bought_variant_ids: [7], paid_more_than_cents: 500, paid_less_than_cents: 2000 },
  { type: "customer", paid_more_than_cents: 500, paid_less_than_cents: 2000 },
  { type: "customer", created_after: AFTER },
  { type: "customer", created_after: AFTER, created_before: BEFORE },
  { type: "customer", bought_from: "United States" },
  { type: "customer", active_customers_only: true },
  { type: "customer", active_customers_only: true, bought_product_ids: [1, 2] },
  { type: "customer", minimum_license_uses: 3 },
  { type: "customer", minimum_license_uses: 3, bought_product_ids: [1], active_customers_only: true },
  { type: "customer", not_bought_product_ids: [2], bought_product_ids: [1] },
  { type: "follower", created_after: AFTER },
  { type: "follower", created_before: BEFORE },
  { type: "follower", created_after: AFTER, created_before: BEFORE },
  { type: "follower", bought_product_ids: [1] },
  { type: "follower", bought_product_ids: [1], created_after: AFTER },
  { type: "follower", bought_variant_ids: [7], created_after: AFTER, created_before: BEFORE },
  { type: "follower", waitlisted_product_ids: [9] },
  { type: "follower", waitlisted_product_ids: [9], created_after: AFTER },
  { type: "follower", exclude_emails: ["a@example.com"], created_after: AFTER },
  { type: "affiliate", affiliate_product_ids: [4] },
  { type: "affiliate", created_after: AFTER },
  { type: "affiliate", created_after: AFTER, created_before: BEFORE },
  { type: "affiliate", affiliate_product_ids: [4, 5], created_after: AFTER, created_before: BEFORE },
  { type: "affiliate", bought_product_ids: [1], affiliate_product_ids: [4] },
  { type: "affiliate", bought_product_ids: [1], paid_more_than_cents: 100 },
  { affiliate_product_ids: [4], created_after: AFTER },
  { bought_product_ids: [1], affiliate_product_ids: [4], created_after: AFTER },
  { bought_product_ids: [1], created_after: AFTER, created_before: BEFORE, bought_from: "France" },
  { not_bought_product_ids: [2], created_after: AFTER },
  { type: "customer", waitlisted_product_ids: [9], bought_product_ids: [1] },
].freeze

OPTION_SETS = [
  {},
  { with_ids: true },
  { ids: [11] },
  { ids: [11, 12], with_ids: true },
  { as_of: AS_OF },
  { as_of: AS_OF, with_ids: true },
  { purchase_ids: [21, 22] },
  { purchase_ids: [21], with_ids: true, ids: [11] },
].freeze

cases = BASE_PARAMS.flat_map { |params| OPTION_SETS.map { |options| filter_case(params, options) } }

# Param shapes the callers can pass that normalize_filter_params reshapes.
cases << filter_case({ type: "customer", bogus_key: 1, bought_product_ids: [1] })
cases << filter_case({ type: "customer", paid_more_than_cents: nil, created_after: "" })
cases << filter_case({ bought_product_ids: [] })
cases << filter_case({ bought_product_ids: [1], exclude_emails: ["O'Brien@example.com"], bought_from: "a'b" })

# --- Installment#audience_members_filter_params -----------------------------------------------------------------------
SEEDED_AT = "2025-01-01 00:00:00"
TABLES = %w[users links installments].freeze
$return = nil

def user_row(id, **overrides)
  { id:, email: "user#{id}@example.com", username: "user#{id}", external_id: (1000 + id).to_s, recommendation_type: "own_products", user_risk_state: "compliant",
    flags: 0, json_data: nil, confirmed_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def link_row(id, user_id: 1, **overrides)
  { id:, name: "Product #{id}", user_id:, unique_permalink: "p#{id}", price_currency_type: "usd", flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def installment_row(type: "seller", filters: {}, **overrides)
  { id: 10, seller_id: 1, link_id: nil, installment_type: type, name: "Post", message: "<p>Hi</p>", json_data: filters.empty? ? nil : filters.to_json,
    created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

LINKS = [link_row(1), link_row(2), link_row(3, user_id: 2), link_row(4, deleted_at: SEEDED_AT)].freeze
filter_params_cases = []
params_case = lambda do |name, type: "seller", filters: {}, timezone: nil, users: nil, **overrides|
  seed = { users: users || [user_row(1, **(timezone ? { timezone: }.compact : {})), user_row(2)], links: LINKS, installments: [installment_row(type:, filters:, **overrides)] }
  result = capture(name, now: NOW, tables: TABLES, seed:, sidekiq: true, kind: "audience_members_filter_params", installment_type: type, filters:) do
    $return = Installment.find(10).audience_members_filter_params
  end
  result.delete("rows")
  result.delete("seed")
  result["return"] = result["error"] ? nil : $return.as_json
  filter_params_cases << result
end
variant_ids = [ObfuscateIds.encrypt(7), ObfuscateIds.encrypt(8)]

params_case.call("no filters, seller post")
params_case.call("no filters, product post", type: "product", link_id: 1)
params_case.call("no filters, variant post", type: "variant", link_id: 1)
params_case.call("no filters, audience post", type: "audience")
params_case.call("no filters, follower post", type: "follower")
params_case.call("no filters, affiliate post", type: "affiliate")
params_case.call("no filters, abandoned cart post", type: "abandoned_cart")
params_case.call("installment without a seller", seller_id: nil, link_id: 1, type: "product")
params_case.call("installment of a seller that does not exist", seller_id: 99)
params_case.call("bought products", filters: { bought_products: %w[p1 p2] })
params_case.call("bought product of another seller", filters: { bought_products: %w[p3] })
params_case.call("bought product that was deleted", filters: { bought_products: %w[p4] })
params_case.call("bought products that do not exist", filters: { bought_products: %w[nope] })
params_case.call("not bought products", filters: { not_bought_products: %w[p1] })
params_case.call("bought variants", filters: { bought_variants: variant_ids })
params_case.call("not bought variants", filters: { not_bought_variants: variant_ids })
params_case.call("bought variant that does not decode", filters: { bought_variants: [variant_ids[0], "garbage"] })
params_case.call("paid more and less", filters: { paid_more_than_cents: 500, paid_less_than_cents: 2000 })
params_case.call("paid more than zero", filters: { paid_more_than_cents: 0 })
params_case.call("paid more than as a string", filters: { paid_more_than_cents: "500" })
params_case.call("active customers only", filters: { active_customers_only: true })
params_case.call("active customers only as a string", filters: { active_customers_only: "true" })
params_case.call("active customers only false", filters: { active_customers_only: false })
params_case.call("active customers only on a follower post", type: "follower", filters: { active_customers_only: true })
params_case.call("minimum license uses", filters: { minimum_license_uses: 3 })
params_case.call("minimum license uses as a string", filters: { minimum_license_uses: "4" })
params_case.call("minimum license uses of zero", filters: { minimum_license_uses: 0 })
params_case.call("minimum license uses on an audience post", type: "audience", filters: { minimum_license_uses: 3 })
params_case.call("created after", filters: { created_after: "2025-03-01T00:00:00.000-08:00" })
params_case.call("created before", filters: { created_before: "2025-03-31T23:59:59.999-07:00" })
params_case.call("created after and before", filters: { created_after: "2025-01-15T00:00:00.000-08:00", created_before: "2025-06-30T23:59:59.999-07:00" })
params_case.call("created after in another time zone", timezone: "Tokyo", filters: { created_after: "2025-01-15T00:00:00.000+09:00", created_before: "2025-06-30T23:59:59.999+09:00" })
params_case.call("created after in London time", timezone: "London", filters: { created_after: "2025-07-01T00:00:00.000+01:00", created_before: "2025-10-26T23:59:59.999+00:00" })
params_case.call("created after as a date", filters: { created_after: "2025-01-15" })
params_case.call("created after that is not a date", filters: { created_after: "soon" })
params_case.call("created after with a six digit year", filters: { created_after: "202500-01-01" })
params_case.call("created after on a day that does not exist", filters: { created_after: "2025-02-30T00:00:00.000-08:00" })
params_case.call("created before in a month that does not exist", filters: { created_before: "2025-13-01" })
params_case.call("created after as a number", filters: { created_after: 20250115 })
params_case.call("bought from", filters: { bought_from: "United States" })
params_case.call("affiliate products", type: "affiliate", filters: { affiliate_products: %w[p1 p2] })
params_case.call("affiliate products that do not exist", type: "affiliate", filters: { affiliate_products: %w[nope] })
params_case.call("waitlisted products", type: "follower", filters: { waitlisted_products: %w[p1] })
params_case.call("waitlisted products that do not exist", type: "follower", filters: { waitlisted_products: %w[nope] })
params_case.call("every filter on a seller post", filters: { bought_products: %w[p1], not_bought_products: %w[p2], bought_variants: variant_ids, not_bought_variants: variant_ids, paid_more_than_cents: 100, paid_less_than_cents: 900,
                                                           active_customers_only: true, minimum_license_uses: 2, created_after: "2025-01-15T00:00:00.000-08:00", created_before: "2025-06-30T23:59:59.999-07:00", bought_from: "France", affiliate_products: %w[p2] })
params_case.call("not clicked post that does not exist", filters: { not_clicked_post_id: "nope" })
params_case.call("seller with a time zone Node does not know", timezone: "Nowhere", filters: { created_after: "2025-01-15T00:00:00.000-08:00" })

# --- Date#in_time_zone, as audience_members_filter_params applies it to a seller's time zone ---------------------
DATES = %w[2025-01-15 2025-03-09 2025-03-10 2025-03-30 2025-04-06 2025-07-01 2025-10-26 2025-11-02 2018-11-04 2018-10-14 2019-09-08].freeze
zones = ActiveSupport::TimeZone.all.map do |zone|
  {
    "name" => zone.name,
    "tzinfo" => zone.tzinfo.name,
    "dates" => DATES.to_h do |date|
      parsed = Date.parse(date)
      start = begin
        parsed.in_time_zone(zone.name).iso8601
      rescue StandardError => e
        "#{e.class}: #{e.message}"
      end
      finish = begin
        parsed.in_time_zone(zone.name).end_of_day.iso8601
      rescue StandardError => e
        "#{e.class}: #{e.message}"
      end
      [date, { "start" => start, "end" => finish }]
    end,
  }
end

File.write(Rails.root.join("nextjs/src/server/models/concerns/time-zones.generated.json"), JSON.pretty_generate(ActiveSupport::TimeZone.all.to_h { [_1.name, _1.tzinfo.name] }) + "\n")
File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases, "zones" => zones, "filter_params_cases" => filter_params_cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases, #{zones.size} zones, #{filter_params_cases.size} filter params cases)"
