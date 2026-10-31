# frozen_string_literal: true

# Produces nextjs/src/server/models/__fixtures__/user-writes.golden.json: User saves, with_lock and
# the user_risk_state transitions, run by the real app/models/user.rb (and every model it reaches)
# on the real mysql2 driver against a scratch database. See support/rails_cases.rb for what each
# case records. Run from the repository root under the test environment, pointed at a scratch
# database and Redis db (it truncates the tables it uses and flushes the Redis db):
#
#   RAILS_ENV=test DATABASE_NAME=gumroad_ws36 TEST_DATABASE_NAME=gumroad_ws36 DISABLE_TEST_REDIS_ISOLATION=1 \
#     REDIS_HOST=127.0.0.1:6379/9 SIDEKIQ_REDIS_HOST=127.0.0.1:6379/9 RPUSH_REDIS_HOST=127.0.0.1:6379/9 \
#     RACK_ATTACK_REDIS_HOST=127.0.0.1:6379/9 bundle exec rails runner nextjs/scripts/golden/user-writes.rb
#
# Elasticsearch, DynamoDB and S3 are never reached by these cases, so the app boots without them.
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/server/models/__fixtures__/user-writes.golden.json")
NOW = Time.utc(2025, 11, 1, 12, 30, 45, 123_000)
SEEDED_AT = "2025-01-01 00:00:00"
TABLES = %w[users comments versions seller_profiles links events social_connect_verifications platform_blocks custom_domains
            feature_announcement_newsletter_cutovers followers affiliates carts bank_accounts merchant_accounts payments
            active_storage_attachments purchases affiliate_requests].freeze

def user_row(id, **overrides)
  {
    id:, email: "seller#{id}@example.com", username: "seller#{id}", external_id: (1000 + id).to_s, recommendation_type: "own_products",
    user_risk_state: "not_reviewed", flags: 0, json_data: nil, confirmed_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT
  }.merge(overrides)
end

PAUSED_BY_SYSTEM = 1 << 19

def run(name, seed: {}, &block) = capture(name, now: NOW, tables: TABLES, seed:, &block)

cases = []

cases << run("update! of a flag and a json_data accessor", seed: { users: [user_row(5, flags: PAUSED_BY_SYSTEM, json_data: '{"payouts_paused_by":"system"}')] }) do
  User.find(5).update!(payouts_paused_internally: false, payouts_paused_by: nil)
end

cases << run("update! of an attribute that loads the seller profile", seed: { users: [user_row(5)] }) do
  User.find(5).update!(payment_address: "paypal5@example.com")
end

cases << run("a second save of the same instance inserts the built seller profile", seed: { users: [user_row(5)] }) do
  user = User.find(5)
  user.update!(payment_address: "paypal5@example.com")
  user.update!(bio: "Hello")
end

cases << run("an existing seller profile is loaded, not built", seed: {
  users: [user_row(5)],
  seller_profiles: [{ id: 3, seller_id: 5, highlight_color: "#ff90e8", background_color: "#ffffff", font: "Inter", created_at: SEEDED_AT, updated_at: SEEDED_AT }],
}) do
  user = User.find(5)
  user.update!(payment_address: "paypal5@example.com")
  user.update!(bio: "Hello")
end

cases << run("with_lock reloads the row FOR UPDATE and saves inside", seed: { users: [user_row(5, flags: PAUSED_BY_SYSTEM, json_data: '{"payouts_paused_by":"system","payout_frequency":"monthly"}')] }) do
  user = User.find(5)
  user.with_lock do
    user.update!(payouts_paused_internally: false, payouts_paused_by: nil)
  end
end

cases << run("with_lock refuses a record with unsaved changes", seed: { users: [user_row(5)] }) do
  user = User.find(5)
  user.name = "Changed"
  user.with_lock { user.update!(bio: "never") }
end

cases << run("save without changes still runs the update callbacks", seed: { users: [user_row(5)] }) do
  User.find(5).save!
end

cases << run("an invalid update rolls back", seed: { users: [user_row(5)] }) do
  User.find(5).update!(name: "a:b")
end

# Time.now.to_f as travel_to stubs it, which is what Sidekiq stamps on payloads.
now_f = travel_to(NOW, with_usec: true) { Time.now.to_f }
File.write(OUT, JSON.pretty_generate({ "now" => now_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
