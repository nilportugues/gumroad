# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/refresh-audience-member-job.golden.json: RefreshAudienceMemberJob run by the
# real app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). A purchase that could qualify for the
# audience and a direct affiliate are what Node hands back to Rails; those cases are recorded up to the call a marker
# exception stands in for. Run it like publish-scheduled-post.rb:
#
#   bundle exec rails runner nextjs/scripts/golden/refresh-audience-member-job.rb   (env as in publish-scheduled-post.rb)
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/refresh-audience-member-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[users purchases followers affiliates audience_members].freeze
EMAIL = "buyer@example.com"

Rails.logger = ActiveSupport::Logger.new(nil)

class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

# Node skips a purchase that cannot qualify without a query (no subscription, and the buyer cannot be contacted, the sale is not
# in a sellable state, or the address is malformed); any other purchase, and every direct affiliate, is handed back.
Purchase.prepend(Module.new do
  def should_be_audience_member?
    skippable = subscription_id.nil? && (!can_contact? || !purchase_state.in?(%w[successful gift_receiver_purchase_successful not_charged]) || !EmailFormatValidator.valid?(email))
    skippable ? super : raise(HandBackMarker)
  end
end)
DirectAffiliate.prepend(Module.new do
  def should_be_audience_member? = raise(HandBackMarker)
end)

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

FOLLOWER_DETAILS = { follower: { id: 1, created_at: "2026-01-01T00:00:00Z" } }.to_json
PURCHASE_DETAILS = { purchases: [{ id: 1, created_at: "2026-01-01T00:00:00Z", product_id: 1, price_cents: 500 }] }.to_json

def member_row(id = 1, email: EMAIL, details: FOLLOWER_DETAILS, **overrides)
  { id:, seller_id: 1, email:, details:, customer: false, follower: true, affiliate: false, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def run(name, args, seed: {})
  hands_back = false
  result = capture(name, now: NOW, tables: TABLES, seed: { users: [user_row(1, "seller@example.com"), user_row(2, EMAIL)] }.merge(seed), sidekiq: true, job: "RefreshAudienceMemberJob", args:) do
    RefreshAudienceMemberJob.new.perform(*args)
  rescue HandBackMarker
    hands_back = true
  end
  result.delete("rows")
  result.delete("seed")
  result.merge("hands_back" => hands_back)
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
cases << run("a purchase that could qualify", [EMAIL, 1], seed: { purchases: [purchase_row(1)] })
cases << run("a purchase that could qualify and a row", [EMAIL, 1], seed: { purchases: [purchase_row(1)], audience_members: [member_row(details: PURCHASE_DETAILS, customer: true, follower: false)] })
cases << run("a purchase that cannot qualify after one that could", [EMAIL, 1], seed: { purchases: [purchase_row(1, can_contact: false), purchase_row(2)] })
cases << run("a subscription purchase that cannot be contacted", [EMAIL, 1], seed: { purchases: [purchase_row(1, can_contact: false, subscription_id: 1)] })
cases << run("a direct affiliate", [EMAIL, 1], seed: { affiliates: [affiliate_row(1)] })
cases << run("a deleted direct affiliate", [EMAIL, 1], seed: { affiliates: [affiliate_row(1, deleted_at: "2026-02-01 00:00:00")] })
cases << run("an affiliate of another seller", [EMAIL, 1], seed: { affiliates: [affiliate_row(1, seller_id: 2)] })
cases << run("a global affiliate", [EMAIL, 1], seed: { affiliates: [affiliate_row(1, type: "GlobalAffiliate")] })

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
