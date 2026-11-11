# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/send-feature-announcement-campaign-job.golden.json: SendFeatureAnnouncementCampaignJob run
# by the real app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). The mails are deliver_later pushes and the
# next batch is a perform_async, both visible in the scratch Redis. Cases marked `batch_size` run with BATCH_SIZE lowered so a full batch
# needs a handful of rows, not a thousand. Run it like update-taxonomy-stats-job.rb.
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/send-feature-announcement-campaign-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[feature_announcement_campaigns feature_announcement_subscriptions users].freeze
PRODUCTION_BATCH_SIZE = SendFeatureAnnouncementCampaignJob::BATCH_SIZE

Rails.logger = ActiveSupport::Logger.new(nil)
ActiveJob::Base.queue_adapter = :sidekiq
ActiveJob::Base.logger = Logger.new(nil)
$uuid_seq = 0
SecureRandom.singleton_class.prepend(Module.new do
  def uuid = format("00000000-0000-4000-8000-%012x", ($uuid_seq += 1))
end)

def set_batch_size(size)
  SendFeatureAnnouncementCampaignJob.send(:remove_const, :BATCH_SIZE)
  SendFeatureAnnouncementCampaignJob.const_set(:BATCH_SIZE, size)
end

def campaign_row(id = 1, state: "sending", key: "launch-#{id}") = { id:, key:, subject: "Subject", body: "Body", reply_to: "reply@example.com", audience: "all", state:, created_at: SEEDED_AT, updated_at: SEEDED_AT }

def user_row(id, **overrides) = { id:, email: "user#{id}@example.com", username: "user#{id}", external_id: (1000 + id).to_s, user_risk_state: "compliant", flags: 0, confirmed_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)

def subscription_row(id, user_id: id, subscribed: 1) = { id:, user_id:, subscribed:, version: 1, source: "settings", created_at: SEEDED_AT, updated_at: SEEDED_AT }

def run(name, args, seed, batch_size: nil)
  $uuid_seq = 0
  set_batch_size(batch_size || PRODUCTION_BATCH_SIZE)
  result = capture(name, now: NOW, tables: TABLES, seed:, sidekiq: true, job: "SendFeatureAnnouncementCampaignJob", args:, batch_size:) do
    SendFeatureAnnouncementCampaignJob.new.perform(*args)
  end
  result.delete("seed")
  result.delete("batch_size") if batch_size.nil?
  result
end

users = ->(*ids) { ids.map { user_row(_1) } }
subs = ->(*ids) { ids.map { subscription_row(_1) } }
BASE = { feature_announcement_campaigns: [campaign_row] }.freeze

cases = []
cases << run("an unknown campaign", [99], BASE)
cases << run("a campaign that is not sending", [1], { feature_announcement_campaigns: [campaign_row(1, state: "draft")], feature_announcement_subscriptions: subs.(1), users: users.(1) })
cases << run("a sent campaign", [1], { feature_announcement_campaigns: [campaign_row(1, state: "sent")], feature_announcement_subscriptions: subs.(1), users: users.(1) })
cases << run("a sending campaign with nobody subscribed", [1], BASE)
cases << run("two subscribers", [1], BASE.merge(feature_announcement_subscriptions: subs.(1, 2), users: users.(1, 2)))
cases << run("an unsubscribed tombstone is skipped", [1], BASE.merge(feature_announcement_subscriptions: [subscription_row(1), subscription_row(2, subscribed: 0)], users: users.(1, 2)))
cases << run("a subscription whose user is gone", [1], BASE.merge(feature_announcement_subscriptions: subs.(1, 2), users: users.(2)))
cases << run("a subscriber without an email on file", [1], BASE.merge(feature_announcement_subscriptions: subs.(1), users: [user_row(1, email: nil)]))
cases << run("the cursor skips earlier subscriptions", [1, 2], BASE.merge(feature_announcement_subscriptions: subs.(1, 2, 3), users: users.(1, 2, 3)))
cases << run("the cursor given as a string", [1, "2"], BASE.merge(feature_announcement_subscriptions: subs.(1, 2, 3), users: users.(1, 2, 3)))
cases << run("the campaign id given as a string", ["1"], BASE.merge(feature_announcement_subscriptions: subs.(1), users: users.(1)))
cases << run("a campaign key with punctuation", [1], { feature_announcement_campaigns: [campaign_row(1, key: "q4 launch / v2")], feature_announcement_subscriptions: subs.(1), users: users.(1) })
cases << run("a full batch schedules the next one", [1], BASE.merge(feature_announcement_subscriptions: subs.(1, 2, 3, 4), users: users.(1, 2)), batch_size: 2)
cases << run("a last batch of exactly the size", [1, 2], BASE.merge(feature_announcement_subscriptions: subs.(1, 2, 3, 4), users: users.(1, 2, 3, 4)), batch_size: 2)
cases << run("a short last batch marks the campaign sent", [1, 2], BASE.merge(feature_announcement_subscriptions: subs.(1, 2, 3), users: users.(1, 2, 3)), batch_size: 2)
cases << run("a full batch whose users are all gone", [1], BASE.merge(feature_announcement_subscriptions: subs.(1, 2, 3)), batch_size: 2)
cases << run("a batch counts tombstones out", [1], BASE.merge(feature_announcement_subscriptions: [subscription_row(1, subscribed: 0), subscription_row(2), subscription_row(3), subscription_row(4)], users: users.(1, 2, 3, 4)), batch_size: 2)
set_batch_size(PRODUCTION_BATCH_SIZE)

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
