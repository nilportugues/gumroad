# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/update-integrations-on-tier-change-worker.golden.json: UpdateIntegrationsOnTierChangeWorker
# run by the real app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). Circle and Discord are checked in turn
# against the subscription's previous and current original purchase. A Circle member to add or remove, or a Discord member to remove,
# is an API call that Node hands back to Rails; those cases are recorded up to it, which a marker exception stands in for. Discord's
# activate has no block in Ruby, so it only reads. Run it like pdf-unstampable-notifier-job.rb (env as in publish-scheduled-post.rb).
require_relative "support/rails_cases"
require_relative "support/integration_rows"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/update-integrations-on-tier-change-worker.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
ORIGINAL = 1 << 2
ARCHIVED = 1 << 17

Rails.logger = ActiveSupport::Logger.new(nil)

def run(name, args, seed) = run_job(UpdateIntegrationsOnTierChangeWorker, name, args, seed)

def merge(*seeds) = seeds.each_with_object({}) { |s, all| s.each { |table, rows| all[table] = (all[table] || []) + rows } }
def circle(id, product, **flags) = { integrations: [integration_row(id, CIRCLE, **flags)], product_integrations: [product_integration_row(id, product, id)] }
def discord(id, product, **flags) = { integrations: [integration_row(id, DISCORD, **flags)], product_integrations: [product_integration_row(id, product, id)] }

# Purchase 1 is the previous original purchase on product 1, purchase 2 the current one on product 2.
def tier_seed(*extras, current_flags: ORIGINAL, previous_flags: ORIGINAL | ARCHIVED, **more)
  base = {
    subscriptions: [subscription_row(1)],
    links: [link_row(1), link_row(2)],
    purchases: [purchase_row(1, subscription_id: 1, flags: previous_flags), purchase_row(2, link_id: 2, subscription_id: 1, flags: current_flags)]
  }
  merge(base, *extras, more)
end

cases = []
cases << run("a subscription that does not exist", [9], {})
cases << run("a subscription with a single original purchase", [1], { subscriptions: [subscription_row(1)], links: [link_row(1)], purchases: [purchase_row(1, subscription_id: 1, flags: ORIGINAL)] })
cases << run("a subscription with no purchase", [1], { subscriptions: [subscription_row(1)] })
cases << run("two original purchases with no integration", [1], tier_seed)
cases << run("circle on both products", [1], tier_seed(circle(1, 1), { integrations: [], product_integrations: [product_integration_row(2, 2, 1)] }))
cases << run("circle only on the previous product", [1], tier_seed(circle(1, 1)))
cases << run("circle only on the previous product, keeping inactive members", [1], tier_seed(circle(1, 1, flags: KEEP_INACTIVE_MEMBERS)))
cases << run("circle only on the current product", [1], tier_seed(circle(1, 2)))
cases << run("discord only on the previous product with no member", [1], tier_seed(discord(1, 1)))
cases << run("discord only on the previous product with a member", [1], tier_seed(discord(1, 1), purchase_integrations: [purchase_integration_row(1, 1, 1, discord_user_id: "d1")]))
cases << run("discord only on the previous product, keeping inactive members", [1], tier_seed(discord(1, 1, flags: KEEP_INACTIVE_MEMBERS), purchase_integrations: [purchase_integration_row(1, 1, 1, discord_user_id: "d1")]))
cases << run("discord only on the current product", [1], tier_seed(discord(1, 2)))
cases << run("discord on both products", [1], tier_seed(discord(1, 1), { product_integrations: [product_integration_row(2, 2, 1)] }, purchase_integrations: [purchase_integration_row(1, 1, 1, discord_user_id: "d1")]))
cases << run("circle on the current and discord with a member on the previous product", [1], tier_seed(circle(1, 2), discord(2, 1), purchase_integrations: [purchase_integration_row(1, 1, 2, discord_user_id: "d1")]))
cases << run("circle on the previous and discord on the current product", [1], tier_seed(circle(1, 1), discord(2, 2)))
cases << run("a deleted circle integration on the previous product", [1], tier_seed({ integrations: [integration_row(1, CIRCLE)], product_integrations: [product_integration_row(1, 1, 1, deleted_at: SEEDED_AT)] }))
cases << run("a previous purchase with a variant integration", [1], tier_seed(
  { base_variants: [variant_row(1)], base_variants_purchases: [habtm_row(1, 1, 1)], integrations: [integration_row(1, CIRCLE)], base_variant_integrations: [variant_integration_row(1, 1, 1)] }
))
cases << run("both purchases on the same variant integration", [1], tier_seed(
  { base_variants: [variant_row(1)], base_variants_purchases: [habtm_row(1, 1, 1), habtm_row(2, 2, 1)], integrations: [integration_row(1, CIRCLE)], base_variant_integrations: [variant_integration_row(1, 1, 1)] }
))
cases << run("three original purchases, the one before the last is the previous one", [1], {
  subscriptions: [subscription_row(1)], links: [link_row(1), link_row(2), link_row(3)],
  purchases: [purchase_row(1, subscription_id: 1, flags: ORIGINAL), purchase_row(2, link_id: 2, subscription_id: 1, flags: ORIGINAL), purchase_row(3, link_id: 3, subscription_id: 1, flags: ORIGINAL)],
  integrations: [integration_row(1, CIRCLE)], product_integrations: [product_integration_row(1, 2, 1)]
})
cases << run("a previous original purchase that was not archived is also read as the current one", [1], tier_seed(circle(1, 1), previous_flags: ORIGINAL))
cases << run("every original purchase archived", [1], tier_seed(circle(1, 1), previous_flags: ORIGINAL | ARCHIVED, current_flags: ORIGINAL | ARCHIVED))
cases << run("a recurring charge that is not an original purchase", [1], tier_seed(circle(1, 1), current_flags: 0))
cases << run("a subscription id as a digit string", ["1"], tier_seed)
cases << run("a subscription id of nil", [nil], tier_seed)
cases << run("a subscription id as a float", [1.0], tier_seed)
cases << run("a subscription id as a word", ["one"], tier_seed)

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
