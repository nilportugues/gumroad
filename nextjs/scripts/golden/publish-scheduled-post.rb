# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/publish-scheduled-post.golden.json: PublishScheduledPostJob run by the real app
# against a scratch database, each case as a Sidekiq job (support/sidekiq_executor.rb). Cases that reach Installment#publish!
# are recorded up to there: Node hands them back to Rails. Run it like schedule-workflow-installment.rb:
#
#   RAILS_ENV=test DATABASE_NAME=gumroad_ws63 TEST_DATABASE_NAME=gumroad_ws63 DISABLE_TEST_REDIS_ISOLATION=1 \
#     USE_DB_WORKER_REPLICAS=true REDIS_HOST=127.0.0.1:6379/13 SIDEKIQ_REDIS_HOST=127.0.0.1:6379/13 \
#     RPUSH_REDIS_HOST=127.0.0.1:6379/13 RACK_ATTACK_REDIS_HOST=127.0.0.1:6379/13 \
#     bundle exec ruby bin/rails runner nextjs/scripts/golden/publish-scheduled-post.rb
require_relative "support/rails_cases"
include RailsCases
capture_elasticsearch!

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/publish-scheduled-post.golden.json")
NOW = Time.utc(2025, 11, 1, 12, 30, 45, 123_000)
SEEDED_AT = "2025-01-01 00:00:00"
TABLES = %w[users installments installment_rules versions product_files payments].freeze
SHOWN_ON_PROFILE = 1 << 7
SEND_EMAILS = 1 << 8
SINGLE_RECIPIENT_EMAIL = 1 << 11

Stripe.api_base = "http://127.0.0.1:9"
Stripe.max_network_retries = 0
ActiveJob::Base.queue_adapter = :sidekiq
ActiveJob::Base.logger = Logger.new(nil)
Rails.logger = ActiveSupport::Logger.new(nil)

def at(time) = time.utc.strftime("%Y-%m-%d %H:%M:%S.%6N")

def user_row(id, **overrides)
  { id:, email: "user#{id}@example.com", username: "user#{id}", external_id: (1000 + id).to_s, recommendation_type: "own_products",
    user_risk_state: "compliant", flags: 0, json_data: nil, confirmed_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def installment_row(id = 10, **overrides)
  { id:, seller_id: 1, installment_type: "audience", name: "Scheduled #{id}", message: "<p>Hello</p>", slug: "scheduled-#{id}", flags: SHOWN_ON_PROFILE,
    created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def rule_row(installment_id = 10, **overrides)
  { id: installment_id, installment_id:, delayed_delivery_time: nil, version: 3, time_period: nil, to_be_published_at: at(NOW + 3600), created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

JOB = "PublishScheduledPostJob"
cases = []
run = lambda do |name, args = [10, 3], now: NOW, **seed|
  seed = { users: [user_row(1)], installments: [installment_row], installment_rules: [rule_row] }.merge(seed)
  result = capture(name, now:, tables: TABLES, seed:, sidekiq: true, job: JOB, args:, case_now: now.to_f) { JOB.constantize.new.perform(*args) }
  result.delete("rows")
  result.delete("seed")
  cases << result
end

run.call("the post does not exist", [999, 3])
run.call("a deleted post", installments: [installment_row(deleted_at: SEEDED_AT)])
run.call("a published post", installments: [installment_row(published_at: SEEDED_AT)])
run.call("a post whose rule moved on", [10, 2])
run.call("a post whose rule is ahead of the job", [10, 4])
run.call("a post whose rule was deleted", installment_rules: [rule_row(deleted_at: SEEDED_AT)])
run.call("a post without a rule", installment_rules: [])
run.call("a post that is due")
run.call("a post that is due, for a seller with large payouts", payments: [{ id: 1, user_id: 1, state: "completed", amount_cents: 6_000_000, created_at: SEEDED_AT, updated_at: SEEDED_AT }])
run.call("a post that is due, for a seller with small payouts", payments: [{ id: 1, user_id: 1, state: "completed", amount_cents: 1000, created_at: SEEDED_AT, updated_at: SEEDED_AT }])
run.call("a post that emails its audience", installments: [installment_row(flags: SHOWN_ON_PROFILE | SEND_EMAILS)])
run.call("a post that only emails a single recipient", installments: [installment_row(flags: SHOWN_ON_PROFILE | SEND_EMAILS | SINGLE_RECIPIENT_EMAIL)])
run.call("a post with a file", product_files: [{ id: 1, installment_id: 10, url: "https://example.com/f.pdf", flags: 0, position: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }])
run.call("a post with an empty message", installments: [installment_row(message: "<p><br></p>")])
run.call("a post with no channel", installments: [installment_row(flags: 0)])
run.call("a post with a call to action", installments: [installment_row(call_to_action_text: "Buy", call_to_action_url: "https://example.com")])
run.call("a post without a slug", installments: [installment_row(slug: nil)])
run.call("a post scheduled for a workflow seller", installments: [installment_row(name: nil)])
run.call("a post that is due, for a seller who has not confirmed their email", users: [user_row(1, confirmed_at: nil)])

# --- Installment#unpublish! and #mark_deleted!, called directly --------------------------------------------------------
direct = lambda do |name, kind, params = {}, **seed, &block|
  seed = { users: [user_row(1)], installments: [installment_row(published_at: SEEDED_AT)], installment_rules: [rule_row] }.merge(seed)
  result = capture(name, now: NOW, tables: TABLES, seed:, sidekiq: true, kind:, params:, case_now: NOW.to_f) { block.call }
  result.delete("rows")
  result.delete("seed")
  cases << result
end
direct.call("unpublish!: a published post", "unpublish!") { Installment.find(10).unpublish! }
direct.call("unpublish!: by an admin", "unpublish!", { "is_unpublished_by_admin" => true }) { Installment.find(10).unpublish!(is_unpublished_by_admin: true) }
direct.call("unpublish!: a post that was not published", "unpublish!", installments: [installment_row]) { Installment.find(10).unpublish! }
direct.call("unpublish!: a post that emails its audience", "unpublish!", installments: [installment_row(published_at: SEEDED_AT, flags: SHOWN_ON_PROFILE | SEND_EMAILS)]) { Installment.find(10).unpublish! }
direct.call("unpublish!: a post with an empty message", "unpublish!", installments: [installment_row(published_at: SEEDED_AT, message: "<p><br></p>")]) { Installment.find(10).unpublish! }
direct.call("mark_deleted!: a post", "mark_deleted!") { Installment.find(10).mark_deleted! }
direct.call("mark_deleted!: a post that emails its audience", "mark_deleted!", installments: [installment_row(published_at: SEEDED_AT, flags: SHOWN_ON_PROFILE | SEND_EMAILS)]) { Installment.find(10).mark_deleted! }
direct.call("mark_deleted!: a post without a message", "mark_deleted!", installments: [installment_row(message: nil)]) { Installment.find(10).mark_deleted! }

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
