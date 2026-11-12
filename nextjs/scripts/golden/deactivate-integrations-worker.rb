# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/deactivate-integrations-worker.golden.json: DeactivateIntegrationsWorker run by the real
# app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). A purchase whose Circle integration keeps inactive
# members, or whose Discord integration has no member to remove, changes nothing. One that would remove a member is a CircleApi /
# DiscordApi call, which Node hands back to Rails; those cases are recorded up to it, which a marker exception stands in for.
# Run it like pdf-unstampable-notifier-job.rb (env as in publish-scheduled-post.rb).
require_relative "support/rails_cases"
require_relative "support/integration_rows"
include RailsCases
capture_http!

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/deactivate-integrations-worker.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)

Rails.logger = ActiveSupport::Logger.new(nil)

def run(name, args, seed, http = []) = run_job(DeactivateIntegrationsWorker, name, args, seed, http)

def circle(product: 1, **flags) = { integrations: [integration_row(1, CIRCLE, **flags)], product_integrations: [product_integration_row(1, product, 1)] }
def discord(**flags) = { integrations: [integration_row(2, DISCORD, **flags)], product_integrations: [product_integration_row(2, 1, 2)] }
def merge(*seeds) = seeds.each_with_object({}) { |s, all| s.each { |table, rows| all[table] = (all[table] || []) + rows } }

cases = []
cases << run("a purchase that does not exist", [9], seed)
cases << run("a product with no integration", [1], seed)
cases << run("a product with a circle integration", [1], seed(**circle))
cases << run("a circle integration that keeps inactive members", [1], seed(**circle(flags: KEEP_INACTIVE_MEMBERS)))
cases << run("a discord integration with no member", [1], seed(**discord))
cases << run("a discord integration with a member", [1], seed(**discord, purchase_integrations: [purchase_integration_row(1, 1, 2, discord_user_id: "d1")]))
cases << run("a discord integration whose member was removed", [1], seed(**discord, purchase_integrations: [purchase_integration_row(1, 1, 2, discord_user_id: "d1", deleted_at: SEEDED_AT)]))
cases << run("a discord integration whose member has a blank user id", [1], seed(**discord, purchase_integrations: [purchase_integration_row(1, 1, 2, discord_user_id: "")]))
cases << run("a discord integration whose member has no user id", [1], seed(**discord, purchase_integrations: [purchase_integration_row(1, 1, 2)]))
cases << run("a discord integration that keeps inactive members", [1], seed(**discord(flags: KEEP_INACTIVE_MEMBERS), purchase_integrations: [purchase_integration_row(1, 1, 2, discord_user_id: "d1")]))
cases << run("a circle integration that keeps members and a discord one with a member", [1], seed(**merge(circle(flags: KEEP_INACTIVE_MEMBERS), discord), purchase_integrations: [purchase_integration_row(1, 1, 2, discord_user_id: "d1")]))
cases << run("a circle integration and a discord one with a member", [1], seed(**merge(circle, discord), purchase_integrations: [purchase_integration_row(1, 1, 2, discord_user_id: "d1")]))
cases << run("a member of another purchase", [1], seed(**discord, purchases: [purchase_row(1), purchase_row(2)], purchase_integrations: [purchase_integration_row(1, 2, 2, discord_user_id: "d1")]))
cases << run("a variant with a discord member", [1], seed(**{ base_variants: [variant_row(1)], base_variants_purchases: [habtm_row(1, 1, 1)], integrations: [integration_row(2, DISCORD)], base_variant_integrations: [variant_integration_row(1, 1, 2)] }, purchase_integrations: [purchase_integration_row(1, 1, 2, discord_user_id: "d1")]))
cases << run("a variant with a circle integration", [1], seed(**{ base_variants: [variant_row(1)], base_variants_purchases: [habtm_row(1, 1, 1)], integrations: [integration_row(1, CIRCLE)], base_variant_integrations: [variant_integration_row(1, 1, 1)] }))

# A subscription adds the other purchases of it that hold a live purchase integration.
sub = { subscriptions: [subscription_row(1)] }
cases << run("a subscription purchase with no other purchase", [1], seed(**sub, purchases: [purchase_row(1, subscription_id: 1)]))
cases << run("a subscription id with no subscription row", [1], seed(purchases: [purchase_row(1, subscription_id: 7)]))
cases << run("a subscription purchase with a circle integration", [1], seed(**sub, **circle, purchases: [purchase_row(1, subscription_id: 1)]))
cases << run("a subscription whose other purchase has a live purchase integration", [1], seed(**sub, **discord, purchases: [purchase_row(1, subscription_id: 1), purchase_row(2, subscription_id: 1)], purchase_integrations: [purchase_integration_row(1, 2, 2, discord_user_id: "d2")]))
cases << run("a subscription whose other purchase has a deleted purchase integration", [1], seed(**sub, **discord, purchases: [purchase_row(1, subscription_id: 1), purchase_row(2, subscription_id: 1)], purchase_integrations: [purchase_integration_row(1, 2, 2, discord_user_id: "d2", deleted_at: SEEDED_AT)]))
cases << run("a subscription whose own purchase has the live purchase integration", [1], seed(**sub, **discord, purchases: [purchase_row(1, subscription_id: 1), purchase_row(2, subscription_id: 1)], purchase_integrations: [purchase_integration_row(1, 1, 2)]))
cases << run("a subscription whose purchases both have live purchase integrations, none with a member", [1], seed(**sub, **discord, purchases: [purchase_row(1, subscription_id: 1), purchase_row(2, subscription_id: 1)], purchase_integrations: [purchase_integration_row(1, 1, 2), purchase_integration_row(2, 2, 2)]))
cases << run("a purchase of another subscription with an integration", [1], seed(subscriptions: [subscription_row(1), subscription_row(2)], **discord, purchases: [purchase_row(1, subscription_id: 1), purchase_row(2, subscription_id: 2)], purchase_integrations: [purchase_integration_row(1, 2, 2, discord_user_id: "d2")]))
cases << run("circle answers not found", [1], seed(**circle), [circle_answer(404, { error: "no member" })])
cases << run("circle answers a server error", [1], seed(**circle), [circle_answer(500, { error: "backend" })])
cases << run("circle answers a body that is not json", [1], seed(**circle), [{ status: 200, body: "<html>ok</html>", headers: { "Content-Type" => "text/html" } }])
cases << run("the buyer's email needs escaping", [1], seed(**circle, purchases: [purchase_row(1, email: "Bu+yer name@example.com")]))
cases << run("a circle integration with no details", [1], seed(**circle(json_data: nil)))
cases << run("a circle integration whose details need escaping", [1], seed(**circle(json_data: { community_id: "a b&c", space_group_id: "é/200" }.to_json)))
cases << run("a circle integration whose details are numbers", [1], seed(**circle(json_data: { community_id: 100, space_group_id: 200.5 }.to_json)))
cases << run("a circle integration with no api key", [1], seed(**circle(api_key: nil)))
cases << run("a circle integration with an api key that needs escaping in a header", [1], seed(**circle(api_key: "k e/y+1=")))
cases << run("a subscription whose two purchases both hold the circle integration", [1], seed(**sub, **circle, purchases: [purchase_row(1, subscription_id: 1), purchase_row(2, subscription_id: 1, email: "second@example.com")], purchase_integrations: [purchase_integration_row(1, 2, 1)]))
cases << run("a purchase id as a digit string", ["1"], seed)
cases << run("a purchase id of nil", [nil], seed)
cases << run("a purchase id as a float", [1.0], seed)
cases << run("a purchase id as a word", ["one"], seed)

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
