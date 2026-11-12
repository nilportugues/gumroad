# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/refresh-audience-member-job.golden.json: RefreshAudienceMemberJob run by the
# real app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). Every source is recorded for real: a
# purchase (Purchase#should_be_audience_member? and #audience_member_details), a follower and a direct affiliate. Run it like
# publish-scheduled-post.rb:
#
#   bundle exec rails runner nextjs/scripts/golden/refresh-audience-member-job.rb   (env as in publish-scheduled-post.rb)
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/refresh-audience-member-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[users purchases followers affiliates audience_members subscriptions licenses base_variants base_variants_purchases affiliates_links].freeze
EMAIL = "buyer@example.com"

Rails.logger = ActiveSupport::Logger.new(nil)

def user_row(id, email = "user#{id}@example.com")
  { id:, email:, username: "user#{id}", external_id: (1000 + id).to_s, user_risk_state: "compliant", flags: 0, confirmed_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT }
end

def purchase_row(id, **overrides)
  { id:, seller_id: 1, link_id: 1, email: EMAIL, price_cents: 500, purchase_state: "successful", can_contact: true, flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def follower_row(id, **overrides)
  { id:, followed_id: 1, email: EMAIL, confirmed_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def affiliate_row(id, **overrides)
  { id:, seller_id: 1, affiliate_user_id: 2, type: "DirectAffiliate", flags: 1, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def subscription_row(id, **overrides)
  { id:, link_id: 1, user_id: 2, seller_id: 1, flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def variant_row(id, **overrides)
  { id:, variant_category_id: 1, name: "Variant #{id}", flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def license_row(id, purchase_id, **overrides)
  { id:, link_id: 1, purchase_id:, serial: "SERIAL-#{id}", created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def product_affiliate_row(id, affiliate_id, link_id, **overrides)
  { id:, affiliate_id:, link_id:, flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

# Bit n of a flag_shih_tzu mapping is 1 << (n - 1).
SEND_POSTS = 1 << 1 # Affiliate flag 2
TEST_SUBSCRIPTION = 1 # Subscription flag 1
ORIGINAL_SUBSCRIPTION = 1 << 2 # Purchase flag 3
GIFT_SENDER = 1 << 6 # Purchase flag 7
CHARGEBACK_REVERSED = 1 << 9 # Purchase flag 10
ARCHIVED_ORIGINAL_SUBSCRIPTION = 1 << 17 # Purchase flag 18
AFFILIATE_DETAILS = { affiliates: [{ id: 1, product_id: 1, created_at: "2026-01-01T00:00:00Z" }] }.to_json

FOLLOWER_DETAILS = { follower: { id: 1, created_at: "2026-01-01T00:00:00Z" } }.to_json
PURCHASE_DETAILS = { purchases: [{ id: 1, created_at: "2026-01-01T00:00:00Z", product_id: 1, price_cents: 500 }] }.to_json

def member_row(id = 1, email: EMAIL, details: FOLLOWER_DETAILS, **overrides)
  { id:, seller_id: 1, email:, details:, customer: false, follower: true, affiliate: false, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def run(name, args, seed: {})
  result = capture(name, now: NOW, tables: TABLES, seed: { users: [user_row(1, "seller@example.com"), user_row(2, EMAIL)] }.merge(seed), sidekiq: true, job: "RefreshAudienceMemberJob", args:) do
    RefreshAudienceMemberJob.new.perform(*args)
  end
  result.delete("rows")
  result.delete("seed")
  result
end

def purchase_cases(cases)
  cases << run("a qualifying purchase and no row", [EMAIL, 1], seed: { purchases: [purchase_row(1, country: "United States")] })
  cases << run("a qualifying purchase and an up to date row", [EMAIL, 1], seed: { purchases: [purchase_row(1, country: "United States")], audience_members: [member_row(details: { purchases: [{ id: 1, country: "United States", created_at: "2026-01-01T00:00:00Z", product_id: 1, price_cents: 500 }] }.to_json, customer: true, follower: false, min_paid_cents: 500, max_paid_cents: 500, min_purchase_created_at: SEEDED_AT, max_purchase_created_at: SEEDED_AT, min_created_at: SEEDED_AT, max_created_at: SEEDED_AT)] })
  cases << run("a qualifying purchase and a stale row", [EMAIL, 1], seed: { purchases: [purchase_row(1, country: "United States", price_cents: 900)], audience_members: [member_row(details: PURCHASE_DETAILS, customer: true, follower: false)] })
  cases << run("a purchase that fell out of the audience and a row", [EMAIL, 1], seed: { purchases: [purchase_row(1, stripe_refunded: true)], audience_members: [member_row(details: PURCHASE_DETAILS, customer: true, follower: false)] })
  cases << run("a purchase with the country read from the IP", [EMAIL, 1], seed: { purchases: [purchase_row(1, country: "", ip_country: "France")] })
  cases << run("a purchase with a blank country and IP country", [EMAIL, 1], seed: { purchases: [purchase_row(1, country: nil, ip_country: nil)] })
  cases << run("a free purchase", [EMAIL, 1], seed: { purchases: [purchase_row(1, price_cents: 0)] })
  cases << run("a gift receiver purchase", [EMAIL, 1], seed: { purchases: [purchase_row(1, purchase_state: "gift_receiver_purchase_successful")] })
  cases << run("a not charged purchase", [EMAIL, 1], seed: { purchases: [purchase_row(1, purchase_state: "not_charged")] })
  cases << run("a gift sender purchase", [EMAIL, 1], seed: { purchases: [purchase_row(1, flags: GIFT_SENDER)] })
  cases << run("a refunded purchase", [EMAIL, 1], seed: { purchases: [purchase_row(1, stripe_refunded: true)] })
  cases << run("a purchase with stripe_refunded false", [EMAIL, 1], seed: { purchases: [purchase_row(1, stripe_refunded: false)] })
  cases << run("a charged back purchase", [EMAIL, 1], seed: { purchases: [purchase_row(1, chargeback_date: SEEDED_AT)] })
  cases << run("a charged back purchase whose chargeback was reversed", [EMAIL, 1], seed: { purchases: [purchase_row(1, chargeback_date: SEEDED_AT, flags: CHARGEBACK_REVERSED)] })
  cases << run("a purchase with a reversed flag and no chargeback", [EMAIL, 1], seed: { purchases: [purchase_row(1, flags: CHARGEBACK_REVERSED)] })
  cases << run("a purchase with two variants", [EMAIL, 1], seed: { purchases: [purchase_row(1)], base_variants: [variant_row(7), variant_row(3)], base_variants_purchases: [{ id: 1, purchase_id: 1, base_variant_id: 7 }, { id: 2, purchase_id: 1, base_variant_id: 3 }] })
  cases << run("a purchase with a deleted variant", [EMAIL, 1], seed: { purchases: [purchase_row(1)], base_variants: [variant_row(7, deleted_at: "2026-02-01 00:00:00")], base_variants_purchases: [{ id: 1, purchase_id: 1, base_variant_id: 7 }] })
  cases << run("a purchase with a variant of another purchase", [EMAIL, 1], seed: { purchases: [purchase_row(1)], base_variants: [variant_row(7)], base_variants_purchases: [{ id: 1, purchase_id: 2, base_variant_id: 7 }] })
  cases << run("a purchase with a license that was used", [EMAIL, 1], seed: { purchases: [purchase_row(1)], licenses: [license_row(1, 1, uses: 3)] })
  cases << run("a purchase with a license that was never used", [EMAIL, 1], seed: { purchases: [purchase_row(1)], licenses: [license_row(1, 1, uses: 0)] })
  cases << run("a purchase with a license with NULL uses", [EMAIL, 1], seed: { purchases: [purchase_row(1)], licenses: [license_row(1, 1, uses: nil)] })
  cases << run("a purchase with a deleted license", [EMAIL, 1], seed: { purchases: [purchase_row(1)], licenses: [license_row(1, 1, uses: 3, deleted_at: "2026-02-01 00:00:00")] })
  cases << run("two qualifying purchases", [EMAIL, 1], seed: { purchases: [purchase_row(2, price_cents: 900, link_id: 2, created_at: "2026-03-01 00:00:00"), purchase_row(1)] })
  cases << run("a qualifying purchase between two that cannot qualify", [EMAIL, 1], seed: { purchases: [purchase_row(1, can_contact: false), purchase_row(2, price_cents: 900), purchase_row(3, purchase_state: "failed")] })
  cases << run("a qualifying purchase and a follower", [EMAIL, 1], seed: { purchases: [purchase_row(1)], followers: [follower_row(1)] })
  cases << run("a purchase created at a time with seconds", [EMAIL, 1], seed: { purchases: [purchase_row(1, created_at: "2026-05-06 07:08:09")] })
  cases << run("a purchase of a product that does not exist", [EMAIL, 1], seed: { purchases: [purchase_row(1, link_id: 999)] })
  cases << run("a purchase with the address in another case", ["Buyer@Example.COM", 1], seed: { purchases: [purchase_row(1, email: "BUYER@example.com")] })
  cases << run("a purchase with NULL price_cents", [EMAIL, 1], seed: { purchases: [purchase_row(1, price_cents: nil)] })
  cases << run("a purchase with NULL purchase_state", [EMAIL, 1], seed: { purchases: [purchase_row(1, purchase_state: nil)] })

  original = ORIGINAL_SUBSCRIPTION
  cases << run("an original subscription purchase", [EMAIL, 1], seed: { purchases: [purchase_row(1, subscription_id: 1, flags: original)], subscriptions: [subscription_row(1)] })
  cases << run("an original subscription purchase of a cancelled subscription", [EMAIL, 1], seed: { purchases: [purchase_row(1, subscription_id: 1, flags: original)], subscriptions: [subscription_row(1, cancelled_at: "2026-02-01 00:00:00")] })
  cases << run("an original subscription purchase of a deactivated subscription", [EMAIL, 1], seed: { purchases: [purchase_row(1, subscription_id: 1, flags: original)], subscriptions: [subscription_row(1, deactivated_at: "2026-02-01 00:00:00")] })
  cases << run("an original subscription purchase of a test subscription", [EMAIL, 1], seed: { purchases: [purchase_row(1, subscription_id: 1, flags: original)], subscriptions: [subscription_row(1, flags: TEST_SUBSCRIPTION)] })
  cases << run("an archived original subscription purchase", [EMAIL, 1], seed: { purchases: [purchase_row(1, subscription_id: 1, flags: original | ARCHIVED_ORIGINAL_SUBSCRIPTION)], subscriptions: [subscription_row(1)] })
  cases << run("a recurring charge", [EMAIL, 1], seed: { purchases: [purchase_row(1, subscription_id: 1)], subscriptions: [subscription_row(1)] })
  cases << run("a recurring charge after the original purchase", [EMAIL, 1], seed: { purchases: [purchase_row(1, subscription_id: 1, flags: original), purchase_row(2, subscription_id: 1)], subscriptions: [subscription_row(1)] })
  cases << run("a refunded subscription purchase", [EMAIL, 1], seed: { purchases: [purchase_row(1, subscription_id: 1, flags: original, stripe_refunded: true)], subscriptions: [subscription_row(1)] })
  cases << run("a charged back subscription purchase", [EMAIL, 1], seed: { purchases: [purchase_row(1, subscription_id: 1, flags: original, chargeback_date: SEEDED_AT)], subscriptions: [subscription_row(1)] })
  cases << run("a subscription purchase whose subscription is gone", [EMAIL, 1], seed: { purchases: [purchase_row(1, subscription_id: 5, flags: original)] })
  cases << run("a gift sender subscription purchase", [EMAIL, 1], seed: { purchases: [purchase_row(1, subscription_id: 1, flags: original | GIFT_SENDER)], subscriptions: [subscription_row(1)] })
  cases << run("two original subscription purchases of two subscriptions", [EMAIL, 1], seed: { purchases: [purchase_row(1, subscription_id: 1, flags: original), purchase_row(2, subscription_id: 2, flags: original, link_id: 2)], subscriptions: [subscription_row(1), subscription_row(2, cancelled_at: "2026-02-01 00:00:00")] })
  cases << run("a subscription purchase that cannot be contacted", [EMAIL, 1], seed: { purchases: [purchase_row(1, can_contact: false, subscription_id: 1, flags: original)], subscriptions: [subscription_row(1)] })
  cases << run("a subscription purchase in a failed state", [EMAIL, 1], seed: { purchases: [purchase_row(1, purchase_state: "failed", subscription_id: 1, flags: original)], subscriptions: [subscription_row(1)] })
  cases << run("a subscription purchase with a malformed address", ["not an email", 1], seed: { purchases: [purchase_row(1, email: "not an email", subscription_id: 1, flags: original)], subscriptions: [subscription_row(1)] })
end

def affiliate_cases(cases)
  cases << run("a direct affiliate that sends posts and has a product", [EMAIL, 1], seed: { affiliates: [affiliate_row(1, flags: SEND_POSTS)], affiliates_links: [product_affiliate_row(1, 1, 1)] })
  cases << run("a direct affiliate with two products", [EMAIL, 1], seed: { affiliates: [affiliate_row(1, flags: SEND_POSTS)], affiliates_links: [product_affiliate_row(1, 1, 5), product_affiliate_row(2, 1, 2)] })
  cases << run("a direct affiliate with no product", [EMAIL, 1], seed: { affiliates: [affiliate_row(1, flags: SEND_POSTS)] })
  cases << run("a direct affiliate with no product and a row", [EMAIL, 1], seed: { affiliates: [affiliate_row(1, flags: SEND_POSTS)], audience_members: [member_row] })
  cases << run("a direct affiliate that does not send posts", [EMAIL, 1], seed: { affiliates: [affiliate_row(1, flags: 1)], affiliates_links: [product_affiliate_row(1, 1, 1)] })
  cases << run("a direct affiliate that does not send posts and a row", [EMAIL, 1], seed: { affiliates: [affiliate_row(1, flags: 0)], affiliates_links: [product_affiliate_row(1, 1, 1)], audience_members: [member_row(details: AFFILIATE_DETAILS, customer: false, follower: false, affiliate: true)] })
  cases << run("a deleted direct affiliate with a product", [EMAIL, 1], seed: { affiliates: [affiliate_row(1, flags: SEND_POSTS, deleted_at: "2026-02-01 00:00:00")], affiliates_links: [product_affiliate_row(1, 1, 1)] })
  cases << run("a direct affiliate whose address is malformed", ["not an email", 1], seed: { users: [user_row(1, "seller@example.com"), user_row(2, "not an email")], affiliates: [affiliate_row(1, flags: SEND_POSTS)], affiliates_links: [product_affiliate_row(1, 1, 1)] })
  cases << run("a direct affiliate and a product of another affiliate", [EMAIL, 1], seed: { affiliates: [affiliate_row(1, flags: SEND_POSTS)], affiliates_links: [product_affiliate_row(1, 2, 1), product_affiliate_row(2, 1, 3)] })
  cases << run("two direct affiliate rows of one user", [EMAIL, 1], seed: { affiliates: [affiliate_row(1, flags: SEND_POSTS, deleted_at: "2026-02-01 00:00:00"), affiliate_row(2, flags: SEND_POSTS, created_at: "2026-03-01 00:00:00")], affiliates_links: [product_affiliate_row(1, 1, 1), product_affiliate_row(2, 2, 1)] })
  cases << run("a direct affiliate of a user with another address", [EMAIL, 1], seed: { users: [user_row(1, "seller@example.com"), user_row(2, "other@example.com")], affiliates: [affiliate_row(1, flags: SEND_POSTS)], affiliates_links: [product_affiliate_row(1, 1, 1)] })
  cases << run("a direct affiliate whose user is gone", [EMAIL, 1], seed: { affiliates: [affiliate_row(1, flags: SEND_POSTS, affiliate_user_id: 99)], affiliates_links: [product_affiliate_row(1, 1, 1)] })
  cases << run("a direct affiliate, a follower and a purchase", [EMAIL, 1], seed: { affiliates: [affiliate_row(1, flags: SEND_POSTS)], affiliates_links: [product_affiliate_row(1, 1, 1)], followers: [follower_row(1)], purchases: [purchase_row(1)] })
  cases << run("a deleted direct affiliate and a row", [EMAIL, 1], seed: { affiliates: [affiliate_row(1, flags: SEND_POSTS, deleted_at: "2026-02-01 00:00:00")], affiliates_links: [product_affiliate_row(1, 1, 1)], audience_members: [member_row(details: AFFILIATE_DETAILS, customer: false, follower: false, affiliate: true)] })
  cases << run("a direct affiliate of other sellers", [EMAIL, 1], seed: { affiliates: [affiliate_row(1, flags: SEND_POSTS, seller_id: 2), affiliate_row(2, flags: SEND_POSTS, seller_id: 3, affiliate_user_id: 2)], affiliates_links: [product_affiliate_row(1, 1, 1), product_affiliate_row(2, 2, 1)] })
end

cases = []
cases << run("nobody and no row", [EMAIL, 1])
cases << run("a row whose source is gone", [EMAIL, 1], seed: { audience_members: [member_row] })
cases << run("a seller that does not exist", [EMAIL, 99])
cases << run("a row of a seller that does not exist", [EMAIL, 99], seed: { audience_members: [member_row(seller_id: 99)] })
cases << run("a confirmed follower and no row", [EMAIL, 1], seed: { followers: [follower_row(1)] })
cases << run("a confirmed follower and an up to date row", [EMAIL, 1], seed: { followers: [follower_row(1)], audience_members: [member_row] })
cases << run("a confirmed follower and a stale row", [EMAIL, 1], seed: { followers: [follower_row(5)], audience_members: [member_row(details: PURCHASE_DETAILS, customer: true, follower: false)] })
cases << run("an unconfirmed follower and no row", [EMAIL, 1], seed: { followers: [follower_row(1, confirmed_at: nil)] })
cases << run("an unconfirmed follower and a row", [EMAIL, 1], seed: { followers: [follower_row(1, confirmed_at: nil)], audience_members: [member_row] })
cases << run("a follower with a malformed address", ["not an email", 1], seed: { followers: [follower_row(1, email: "not an email")] })
cases << run("a deleted follower", [EMAIL, 1], seed: { followers: [follower_row(1, deleted_at: "2026-02-01 00:00:00")] })
cases << run("the address in another case", ["Buyer@Example.COM", 1], seed: { followers: [follower_row(1)], audience_members: [member_row] })
cases << run("the address in another case and no row", ["Buyer@Example.COM", 1], seed: { followers: [follower_row(1)] })
cases << run("the address padded with spaces", [" #{EMAIL} ", 1], seed: { followers: [follower_row(1)] })
cases << run("a blank address", ["", 1])
cases << run("another seller's follower", [EMAIL, 1], seed: { followers: [follower_row(1, followed_id: 2)] })
cases << run("a follower of another address", [EMAIL, 1], seed: { followers: [follower_row(1, email: "other@example.com")] })
cases << run("a purchase that cannot be contacted", [EMAIL, 1], seed: { purchases: [purchase_row(1, can_contact: false)], audience_members: [member_row(details: PURCHASE_DETAILS, customer: true, follower: false)] })
cases << run("a purchase that was not charged successfully", [EMAIL, 1], seed: { purchases: [purchase_row(1, purchase_state: "failed")] })
cases << run("a purchase with a malformed address", ["not an email", 1], seed: { purchases: [purchase_row(1, email: "not an email")] })
cases << run("several purchases that cannot qualify and a follower", [EMAIL, 1], seed: { purchases: [purchase_row(1, can_contact: false), purchase_row(2, purchase_state: "failed")], followers: [follower_row(1)] })
cases << run("a purchase of another seller", [EMAIL, 1], seed: { purchases: [purchase_row(1, seller_id: 2)] })
cases << run("a subscription purchase that cannot be contacted", [EMAIL, 1], seed: { purchases: [purchase_row(1, can_contact: false, subscription_id: 1)] })
cases << run("an affiliate of another seller", [EMAIL, 1], seed: { affiliates: [affiliate_row(1, seller_id: 2)] })
cases << run("a global affiliate", [EMAIL, 1], seed: { affiliates: [affiliate_row(1, type: "GlobalAffiliate")] })

purchase_cases(cases)
affiliate_cases(cases)

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
