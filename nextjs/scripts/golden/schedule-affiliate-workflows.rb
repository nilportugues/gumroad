# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/schedule-affiliate-workflows.golden.json: ScheduleAffiliateWorkflowJobsJob with a
# workflow schedule token (and the DirectAffiliate#schedule_workflow_jobs it calls) run by the real app against a scratch
# database, each case as a Sidekiq job (support/sidekiq_executor.rb). Run it like schedule-workflow-installment.rb:
#
#   RAILS_ENV=test DATABASE_NAME=gumroad_ws63 TEST_DATABASE_NAME=gumroad_ws63 DISABLE_TEST_REDIS_ISOLATION=1 \
#     USE_DB_WORKER_REPLICAS=true REDIS_HOST=127.0.0.1:6379/13 SIDEKIQ_REDIS_HOST=127.0.0.1:6379/13 \
#     RPUSH_REDIS_HOST=127.0.0.1:6379/13 RACK_ATTACK_REDIS_HOST=127.0.0.1:6379/13 \
#     OBFUSCATE_IDS_CIPHER_KEY=ws63-golden-obfuscate-key OBFUSCATE_IDS_NUMERIC_CIPHER_KEY=123456789 \
#     bundle exec ruby bin/rails runner nextjs/scripts/golden/schedule-affiliate-workflows.rb
require_relative "support/rails_cases"
include RailsCases
capture_elasticsearch!

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/schedule-affiliate-workflows.golden.json")
NOW = Time.utc(2025, 11, 1, 12, 30, 45, 123_000)
SEEDED_AT = "2025-01-01 00:00:00"
TABLES = %w[users links workflows installments installment_rules affiliates affiliates_links versions].freeze

Stripe.api_base = "http://127.0.0.1:9"
Stripe.max_network_retries = 0
ActiveJob::Base.queue_adapter = :sidekiq
ActiveJob::Base.logger = Logger.new(nil)
Rails.logger = ActiveSupport::Logger.new(nil)

$uuid_seq = 0
SecureRandom.singleton_class.prepend(Module.new do
  def uuid
    $uuid_seq += 1
    format("00000000-0000-4000-8000-%012d", $uuid_seq)
  end
end)

HOUR = 3600
SEND_POSTS = 2
SEND_EMAILS = 1 << 8

def at(time) = time.utc.strftime("%Y-%m-%d %H:%M:%S.%6N")

def user_row(id, **overrides)
  { id:, email: "user#{id}@example.com", username: "user#{id}", external_id: (1000 + id).to_s, recommendation_type: "own_products",
    user_risk_state: "compliant", flags: 0, json_data: nil, confirmed_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def link_row(id = 1, **overrides)
  { id:, name: "Product #{id}", user_id: 1, unique_permalink: "p#{id}", price_currency_type: "usd", flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def workflow_row(id = 1, type: "affiliate", trigger: nil, **overrides)
  { id:, seller_id: 1, link_id: nil, workflow_type: type, published_at: SEEDED_AT, json_data: trigger ? { workflow_trigger: trigger }.to_json : nil,
    flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def installment_row(id = 10, workflow_id: 1, filters: {}, **overrides)
  { id:, link_id: nil, seller_id: 1, workflow_id:, installment_type: "affiliate", name: "Post #{id}", published_at: SEEDED_AT, flags: SEND_EMAILS,
    json_data: filters.empty? ? nil : filters.to_json, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def rule_row(installment_id = 10, **overrides)
  { id: installment_id, installment_id:, delayed_delivery_time: HOUR, version: 3, time_period: "hour", created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def affiliate_row(id = 1, type: "DirectAffiliate", affiliate_user_id: 2, **overrides)
  { id:, seller_id: 1, affiliate_user_id:, type:, affiliate_basis_points: 1000, flags: SEND_POSTS, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def assignment_row(id = 1, token: "tok", affiliate_id: 1, link_id: 1, created_at: "2025-10-30 09:15:20", **overrides)
  { id:, affiliate_id:, link_id:, workflow_schedule_token: token, flags: 0, created_at:, updated_at: created_at }.merge(overrides)
end

def base_seed(**extra)
  { users: [user_row(1), user_row(2), user_row(3)], links: [link_row, link_row(2)], workflows: [workflow_row], installments: [installment_row], installment_rules: [rule_row],
    affiliates: [affiliate_row], affiliates_links: [assignment_row] }.merge(extra)
end

JOB = "ScheduleAffiliateWorkflowJobsJob"
cases = []
run = lambda do |name, args = ["tok"], now: NOW, **seed|
  $uuid_seq = 0
  result = capture(name, now:, tables: TABLES, seed: base_seed(**seed), sidekiq: true, job: JOB, args:, case_now: now.to_f) { JOB.constantize.new.perform(*args) }
  result.delete("rows")
  result.delete("seed")
  cases << result
end

run.call("a direct affiliate with an affiliate workflow")
run.call("no workflows", workflows: [], installments: [], installment_rules: [])
run.call("an audience workflow", workflows: [workflow_row(type: "audience")], installments: [installment_row(installment_type: "audience")])
run.call("two installments", installments: [installment_row, installment_row(11)], installment_rules: [rule_row, rule_row(11, delayed_delivery_time: 2 * HOUR, version: 4)])
run.call("an affiliate and an audience workflow", workflows: [workflow_row, workflow_row(2, type: "audience")],
                                                   installments: [installment_row, installment_row(11, workflow_id: 2, installment_type: "audience")], installment_rules: [rule_row, rule_row(11)])
run.call("a product workflow", workflows: [workflow_row(type: "product", link_id: 1)], installments: [installment_row(installment_type: "product")])
run.call("a workflow with another trigger", workflows: [workflow_row(trigger: "member_cancellation")])
run.call("a deleted workflow", workflows: [workflow_row(deleted_at: SEEDED_AT)])
run.call("a deleted installment", installments: [installment_row(deleted_at: SEEDED_AT)])
run.call("an unpublished installment", installments: [installment_row(published_at: nil)])
run.call("an installment without a rule", installment_rules: [])
run.call("an installment of another workflow", installments: [installment_row(workflow_id: 2)])
run.call("an installment for products the assignment is not for", installments: [installment_row(filters: { affiliate_products: %w[p2] })])
run.call("an installment for the assignment's product", installments: [installment_row(filters: { affiliate_products: %w[p1] })])
run.call("an installment for several products", installments: [installment_row(filters: { affiliate_products: %w[p2 p1] })])
run.call("an installment for products that do not exist", installments: [installment_row(filters: { affiliate_products: %w[nope] })])
run.call("an installment created after the affiliate", installments: [installment_row(filters: { created_after: "2025-02-01T00:00:00.000-08:00" })])
run.call("an installment created after before the affiliate", installments: [installment_row(filters: { created_after: "2024-12-01T00:00:00.000-08:00" })])
run.call("an installment created before the affiliate", installments: [installment_row(filters: { created_before: "2024-12-31T23:59:59.999-08:00" })])
run.call("an installment created before after the affiliate", installments: [installment_row(filters: { created_before: "2025-06-30T23:59:59.999-07:00" })])
run.call("an installment created on the day of the affiliate", installments: [installment_row(filters: { created_after: "2025-01-01T00:00:00.000-08:00", created_before: "2025-01-01T23:59:59.999-08:00" })],
                                                                affiliates: [affiliate_row(created_at: "2025-01-01 20:00:00")])
run.call("an installment with a filter Node does not read", installments: [installment_row(filters: { created_after: "soon" })])
run.call("an installment with a has-not-clicked filter", installments: [installment_row(filters: { not_clicked_post_id: "nope" })])
run.call("an affiliate that does not send posts", affiliates: [affiliate_row(flags: 0)])
run.call("a deleted affiliate", affiliates: [affiliate_row(deleted_at: SEEDED_AT)])
run.call("a collaborator", affiliates: [affiliate_row(type: "Collaborator")])
run.call("an affiliate whose user is missing", affiliates: [affiliate_row(affiliate_user_id: 99)])
run.call("an assignment without a creation time", affiliates_links: [assignment_row(created_at: nil)])
run.call("an assignment created with fractions of a second", affiliates_links: [assignment_row(created_at: "2025-10-30 09:15:20.987654")])
run.call("a second assignment that triggers", affiliates_links: [assignment_row, assignment_row(2, link_id: 2, created_at: "2025-10-31 10:00:00")])
run.call("a second assignment in the same second as the first", affiliates_links: [assignment_row(1, token: nil), assignment_row(2, link_id: 2)])
run.call("a second assignment in the same second, both triggering", affiliates_links: [assignment_row(1), assignment_row(2, link_id: 2)])
run.call("an assignment in the same second as an older one that holds no token, with an earlier id", affiliates_links: [assignment_row(1, token: nil), assignment_row(2, link_id: 2, created_at: "2025-10-30 09:15:20")])
run.call("an older assignment without the token", affiliates_links: [assignment_row(1, token: nil, created_at: "2025-10-01 00:00:00"), assignment_row(2, link_id: 2)])
run.call("an assignment for another token", affiliates_links: [assignment_row(1), assignment_row(2, link_id: 2, token: "other")])
run.call("two affiliates", users: [user_row(1), user_row(2), user_row(3)], affiliates: [affiliate_row, affiliate_row(2, affiliate_user_id: 3)],
                           affiliates_links: [assignment_row, assignment_row(2, affiliate_id: 2, link_id: 2, created_at: "2025-10-31 10:00:00")])
run.call("two affiliates, the first not sending posts", affiliates: [affiliate_row(flags: 0), affiliate_row(2, affiliate_user_id: 3)],
                                                         affiliates_links: [assignment_row, assignment_row(2, affiliate_id: 2, link_id: 2, created_at: "2025-10-31 10:00:00")])
run.call("a seller in another time zone", users: [user_row(1, timezone: "Tokyo"), user_row(2), user_row(3)], installments: [installment_row(filters: { created_after: "2025-01-15T00:00:00.000+09:00" })],
                                          affiliates: [affiliate_row(created_at: "2025-01-14 15:30:00")])
run.call("no assignment holds the token", ["missing"])
run.call("an integer token that an assignment holds as digits", [5], affiliates_links: [assignment_row(token: "5")])
run.call("an integer token no assignment holds", [7], affiliates_links: [assignment_row(token: "5")])
run.call("an integer token past 2**53", [2**70], affiliates_links: [assignment_row(token: (2**70).to_s)])
run.call("a negative integer token", [-3], affiliates_links: [assignment_row(token: "-3")])
run.call("a true token that an assignment holds as 1", [true], affiliates_links: [assignment_row(token: "1")])
run.call("a false token that an assignment holds as 0", [false], affiliates_links: [assignment_row(token: "0")])
run.call("a false token no assignment holds", [false])
run.call("the sweep", [nil])

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
