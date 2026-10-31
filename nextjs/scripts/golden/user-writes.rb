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
# DynamoDB and S3 are never reached by these cases; Elasticsearch is a local socket that answers 200.
require_relative "support/rails_cases"
include RailsCases
capture_elasticsearch!

OUT = Rails.root.join("nextjs/src/server/models/__fixtures__/user-writes.golden.json")
NOW = Time.utc(2025, 11, 1, 12, 30, 45, 123_000)
SEEDED_AT = "2025-01-01 00:00:00"
TABLES = %w[users comments versions seller_profiles links events social_connect_verifications platform_blocks custom_domains
            feature_announcement_newsletter_cutovers followers affiliates carts bank_accounts merchant_accounts payments
            active_storage_attachments purchases affiliate_requests prices variant_categories base_variants product_installment_plans
            product_cached_values offer_codes bundle_products oauth_applications oauth_access_tokens oauth_device_authorizations
            user_youtube_identities user_instagram_identities user_tiktok_identities].freeze

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

REFUNDS_DISABLED = 1 << 7
VERIFIED = { verified: 1 }.freeze

cases << run("flag_for_fraud! comments and adds the gmail variant to the abuse filter", seed: { users: [user_row(5, email: "Sel.ler5+x@gmail.com")] }) do
  User.find(5).flag_for_fraud!(author_name: "check_payment_address")
end

cases << run("flag_for_tos_violation! in bulk, authored by an admin", seed: { users: [user_row(5), user_row(7, name: "Admin")] }) do
  User.find(5).flag_for_tos_violation!(author_id: 7, bulk: true)
end

cases << run("flag_for_tos_violation! for one product comments on it", seed: {
  users: [user_row(5, tos_violation_reason: "spam")],
  links: [{ id: 9, user_id: 5, name: "Ebook", unique_permalink: "abc", price_cents: 100, created_at: SEEDED_AT, updated_at: SEEDED_AT }],
}) do
  User.find(5).flag_for_tos_violation!(author_name: "iffy", product_id: 9)
end

cases << run("put_on_probation! with custom content", seed: { users: [user_row(5)] }) do
  User.find(5).put_on_probation!(author_name: "iffy", content: "Held for review")
end

cases << run("mark_not_reviewed! from probation", seed: { users: [user_row(5, user_risk_state: "on_probation")] }) do
  User.find(5).mark_not_reviewed!(author_name: "iffy")
end

cases << run("mark_compliant! from flagged enables refunds and lifts the platform pause after commit", seed: {
  users: [user_row(5, email: "seller5@gmail.com", user_risk_state: "flagged_for_fraud", flags: REFUNDS_DISABLED)],
}) do
  User.find(5).mark_compliant!(author_name: "iffy")
end

cases << run("mark_compliant! rebases flags onto the locked row", seed: { users: [user_row(5, flags: PAUSED_BY_SYSTEM | REFUNDS_DISABLED)] }) do
  user = User.find(5)
  User.where(id: 5).update_all(flags: REFUNDS_DISABLED)
  user.mark_compliant!(author_name: "iffy")
end

cases << run("mark_compliant! records hold_released once per offer", seed: {
  users: [user_row(5)],
  events: [
    { id: 1, event_name: "social_connect_offered", user_id: 5, parent_referrer: "twitter", view_url: "profile", created_at: "2025-06-01 00:00:00", updated_at: "2025-06-01 00:00:00" },
    { id: 2, event_name: "social_connect_hold_released", user_id: 5, parent_referrer: "none", view_url: "mark_compliant", created_at: "2025-07-01 00:00:00", updated_at: "2025-07-01 00:00:00" },
  ],
}) do
  User.find(5).mark_compliant!(author_name: "iffy")
end

cases << run("mark_compliant! clearing a suspension unblocks the IP, re-adds the Apple Pay domain and releases cascade siblings", seed: {
  users: [
    user_row(5, user_risk_state: "suspended_for_fraud", payment_address: "shared@example.com", last_sign_in_ip: "10.0.0.1"),
    user_row(6, user_risk_state: "suspended_for_fraud", payment_address: "shared@example.com"),
    user_row(8, user_risk_state: "suspended_for_tos_violation", payment_address: "shared@example.com"),
  ],
  comments: [
    { id: 1, commentable_id: 6, commentable_type: "User", author_name: "suspend_sellers_other_accounts", comment_type: "suspended", content: "Suspended", created_at: SEEDED_AT, updated_at: SEEDED_AT },
    { id: 2, commentable_id: 8, commentable_type: "User", author_name: "iffy", comment_type: "suspended", content: "Suspended", created_at: SEEDED_AT, updated_at: SEEDED_AT },
  ],
  platform_blocks: [{ id: 4, object_type: "ip_address", object_value: "10.0.0.1", blocked_at: SEEDED_AT, expires_at: "2026-01-01 00:00:00", created_at: SEEDED_AT, updated_at: SEEDED_AT }],
}) do
  User.find(5).mark_compliant!(author_name: "iffy", clear_suspension: true)
end

cases << run("mark_compliant! releases siblings that share a bank account fingerprint", seed: {
  users: [
    user_row(5, user_risk_state: "suspended_for_fraud"),
    user_row(9, user_risk_state: "suspended_for_fraud"),
  ],
  bank_accounts: [
    { id: 1, user_id: 5, type: "AchAccount", stripe_fingerprint: "fp1", created_at: SEEDED_AT, updated_at: SEEDED_AT },
    { id: 2, user_id: 5, type: "AchAccount", stripe_fingerprint: "", created_at: SEEDED_AT, updated_at: SEEDED_AT },
    { id: 3, user_id: 9, type: "AchAccount", stripe_fingerprint: "fp0", created_at: SEEDED_AT, updated_at: SEEDED_AT },
    { id: 4, user_id: 9, type: "AchAccount", stripe_fingerprint: "fp1", created_at: SEEDED_AT, updated_at: SEEDED_AT },
  ],
  comments: [
    { id: 1, commentable_id: 9, commentable_type: "User", author_name: "suspend_sellers_other_accounts", comment_type: "suspended", content: "Suspended", created_at: SEEDED_AT, updated_at: SEEDED_AT },
  ],
}) do
  User.find(5).mark_compliant!(author_id: 5, clear_suspension: true)
end

cases << run("mark_compliant! refuses to clear a suspension the caller did not authorize", seed: { users: [user_row(5)] }) do
  user = User.find(5)
  User.where(id: 5).update_all(user_risk_state: "suspended_for_tos_violation")
  user.mark_compliant!(author_name: "iffy")
end

cases << run("an event with no transition from the current state", seed: { users: [user_row(5)] }) do
  User.find(5).mark_not_reviewed!(author_name: "iffy")
end

cases << run("a verified seller cannot be flagged", seed: { users: [user_row(5, **VERIFIED)] }) do
  User.find(5).flag_for_fraud!(author_name: "iffy")
end

cases << run("a transition without an author rolls back", seed: { users: [user_row(5)] }) do
  User.find(5).flag_for_fraud!
end

cases << run("the non-bang event returns false and adds an error", seed: { users: [user_row(5, user_risk_state: "compliant")] }) do
  user = User.find(5)
  result = user.mark_not_reviewed(author_name: "iffy")
  # Surfaces the return value and the error the event leaves behind.
  raise [result, user.errors.details[:user_risk_state], user.errors.full_messages].inspect
end

def product_row(id, **overrides)
  { id:, user_id: 5, name: "Product #{id}", unique_permalink: "perm#{("a".ord + id).chr}", price_cents: 100, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def price_row(id, link_id, **overrides)
  { id:, link_id:, price_cents: 100, currency: "usd", created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def oauth_application_row(id, uid)
  { id:, name: "App #{id}", uid:, secret: "secret#{id}", redirect_uri: "https://example.com/cb", scopes: "mobile_api", created_at: SEEDED_AT, updated_at: SEEDED_AT }
end

MOBILE_UID = OauthApplication::MOBILE_API_OAUTH_APPLICATION_UID
LEGACY_MOBILE_UID = OauthApplication::LEGACY_MOBILE_API_OAUTH_APPLICATION_UID

cases << run("suspend_for_fraud! revokes mobile sessions, bans products, deletes the custom domain and schedules the cascade", seed: {
  users: [user_row(5)],
  # Product 10 has no price, so its save fails validation and the suspension goes on without it.
  links: [product_row(9), product_row(10)],
  prices: [price_row(1, 9)],
  oauth_applications: [oauth_application_row(2, MOBILE_UID), oauth_application_row(3, LEGACY_MOBILE_UID), oauth_application_row(4, "third-party")],
  oauth_access_tokens: [
    { id: 1, resource_owner_id: 5, application_id: 2, token: "t1", scopes: "mobile_api", created_at: SEEDED_AT },
    { id: 2, resource_owner_id: 5, application_id: 3, token: "t2", scopes: "mobile_api", created_at: SEEDED_AT },
    { id: 3, resource_owner_id: 5, application_id: 4, token: "t3", scopes: "mobile_api", created_at: SEEDED_AT },
    { id: 4, resource_owner_id: 5, application_id: 2, token: "t4", scopes: "mobile_api", created_at: SEEDED_AT, revoked_at: SEEDED_AT },
  ],
  oauth_device_authorizations: [
    { id: 1, oauth_application_id: 2, resource_owner_id: 5, status: "approved", device_code_digest: "d1", user_code_digest: "u1", scopes: "mobile_api", expires_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT },
    { id: 2, oauth_application_id: 2, resource_owner_id: 5, status: "pending", device_code_digest: "d2", user_code_digest: "u2", scopes: "mobile_api", expires_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT },
  ],
  custom_domains: [{ id: 3, user_id: 5, domain: "shop.example.com", created_at: SEEDED_AT, updated_at: SEEDED_AT }],
}) do
  User.find(5).suspend_for_fraud!(author_name: "iffy")
end

cases << run("suspend_for_tos_violation! from the account cascade skips its own job and filters the gmail address", seed: {
  users: [user_row(5, email: "seller.five@gmail.com", user_risk_state: "flagged_for_tos_violation")],
  links: [product_row(9, price_cents: 0, banned_at: "2025-06-01 00:00:00")],
  prices: [price_row(1, 9, price_cents: 0)],
  custom_domains: [{ id: 3, user_id: 5, domain: "WWW.Example.org ", created_at: SEEDED_AT, updated_at: SEEDED_AT }],
}) do
  User.find(5).suspend_for_tos_violation!(author_name: "suspend_sellers_other_accounts", skip_transition_callback: :suspend_sellers_other_accounts)
end

# Deleting the domain validates its uniqueness, so another seller's alive bare domain blocks the
# whole suspension.
cases << run("suspend_for_fraud! rolls back when the custom domain is not unique", seed: {
  users: [user_row(5)],
  custom_domains: [
    { id: 3, user_id: 5, domain: "www.example.org", created_at: SEEDED_AT, updated_at: SEEDED_AT },
    { id: 4, user_id: 6, domain: "example.org", created_at: SEEDED_AT, updated_at: SEEDED_AT },
  ],
}) do
  User.find(5).suspend_for_fraud!(author_name: "iffy")
end

cases << run("suspend_for_fraud! rolls back when a product raises", seed: {
  users: [user_row(5)],
  links: [product_row(9, flags: (1 << 18) | (1 << 1), native_type: "membership", subscription_duration: 0)],
  prices: [price_row(1, 9, price_cents: 0, recurrence: "monthly")],
  variant_categories: [{ id: 2, link_id: 9, title: "Tier" }],
}) do
  User.find(5).suspend_for_fraud!(author_name: "iffy")
end

cases << run("a verified seller cannot be suspended", seed: { users: [user_row(5, **VERIFIED)] }) do
  User.find(5).suspend_for_fraud!(author_name: "iffy")
end

# One product: the seller's is_recommendable reindex reads the user once per product here, but
# once per batch under the job query cache this harness records without.
cases << run("mark_compliant! clearing a suspension unbans deleted products too", seed: {
  users: [user_row(5, user_risk_state: "suspended_for_tos_violation")],
  links: [product_row(9, banned_at: "2025-06-01 00:00:00", deleted_at: "2025-06-01 00:00:00")],
  prices: [price_row(1, 9)],
}) do
  User.find(5).mark_compliant!(author_name: "iffy", clear_suspension: true)
end

cases << run("mark_compliant! records hold_released for each currently linked provider", seed: {
  users: [user_row(5, twitter_user_id: "77")],
  social_connect_verifications: [
    { id: 1, user_id: 5, platform: "twitter", uid: "77", last_verified_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT },
    { id: 2, user_id: 5, platform: "youtube", uid: "yt", last_verified_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT },
    { id: 3, user_id: 5, platform: "instagram", uid: "ig-old", last_verified_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT },
    { id: 4, user_id: 5, platform: "tiktok", uid: "tt", last_verified_at: SEEDED_AT, superseded_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT },
  ],
  user_youtube_identities: [{ id: 1, user_id: 5, channel_id: "yt", created_at: SEEDED_AT, updated_at: SEEDED_AT }],
  user_instagram_identities: [{ id: 1, user_id: 5, instagram_user_id: "ig-new", created_at: SEEDED_AT, updated_at: SEEDED_AT }],
  user_tiktok_identities: [{ id: 1, user_id: 5, tiktok_open_id: "tt", created_at: SEEDED_AT, updated_at: SEEDED_AT }],
}) do
  User.find(5).mark_compliant!(author_name: "iffy")
end

cases << run("mark_compliant! records hold_released once when no verification is linked", seed: {
  users: [user_row(5)],
  social_connect_verifications: [{ id: 1, user_id: 5, platform: "youtube", uid: "yt", last_verified_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT }],
}) do
  User.find(5).mark_compliant!(author_name: "iffy")
end

# Time.now.to_f as travel_to stubs it, which is what Sidekiq stamps on payloads.
now_f = travel_to(NOW, with_usec: true) { Time.now.to_f }
File.write(OUT, JSON.pretty_generate({ "now" => now_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
