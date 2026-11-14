# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/community-chat-recap-notifications.golden.json: the real
# SendCommunityChatRecapNotificationsJob (and the User#accessible_communities_ids it calls) against a
# scratch database, each case as a Sidekiq job (support/sidekiq_executor.rb). The mails it queues
# go to Sidekiq through ActiveJob's adapter, as in production. Run it like user-writes.rb, adding
# USE_DB_WORKER_REPLICAS=true.
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/community-chat-recap-notifications.golden.json")
NOW = Time.utc(2025, 11, 1, 12, 30, 45, 123_000)
SEEDED_AT = "2025-01-01 00:00:00"
TABLES = %w[users links communities community_chat_recap_runs community_chat_recaps community_notification_settings purchases].freeze

# ActiveJob's job_id is SecureRandom.uuid; sequential values keep the payloads comparable.
$uuid_seq = 0
SecureRandom.singleton_class.prepend(Module.new do
  def uuid
    $uuid_seq += 1
    format("00000000-0000-4000-8000-%012d", $uuid_seq)
  end
end)
ActiveJob::Base.queue_adapter = :sidekiq
ActiveJob::Base.logger = Logger.new(nil)
ActionMailer::Base.deliver_later_queue_name = :default
Rails.logger = ActiveSupport::Logger.new(nil)

def user_row(id, **overrides)
  {
    id:, email: "user#{id}@example.com", username: "user#{id}", external_id: (1000 + id).to_s, recommendation_type: "own_products",
    user_risk_state: "compliant", flags: 0, json_data: nil, confirmed_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT
  }.merge(overrides)
end

COMMUNITY_CHAT_ENABLED = 1 << (30 - 1)

def link_row(id, user_id, **overrides)
  { id:, user_id:, name: "Product #{id}", unique_permalink: "perm#{id}", price_cents: 100, flags: COMMUNITY_CHAT_ENABLED, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def community_row(id, link_id, seller_id, **overrides)
  { id:, resource_type: "Link", resource_id: link_id, seller_id:, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def run_row(id, frequency = "daily", **overrides)
  { id:, recap_frequency: frequency, from_date: "2025-10-31 00:00:00", to_date: "2025-10-31 23:59:59", finished_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def recap_row(id, run_id, community_id, status = "finished", **overrides)
  { id:, community_chat_recap_run_id: run_id, community_id:, seller_id: 1, summarized_message_count: 3, summary: "Summary #{id}", status:, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def setting_row(id, user_id, seller_id, frequency = "daily", **overrides)
  { id:, user_id:, seller_id:, recap_frequency: frequency, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def purchase_row(id, link_id, **overrides)
  { id:, link_id:, seller_id: 1, purchase_state: "successful", price_cents: 100, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

# What the job's rescue-all reported to ErrorNotifier.
$notified = []
ErrorNotifier.singleton_class.prepend(Module.new do
  def notify(error, *, **)
    $notified << { "class" => error.class.name, "message" => error.message.lines.first.to_s.strip }
    super
  end
end)

def run(name, args: [61], seed: {}, &block)
  $uuid_seq = 0
  $notified = []
  block ||= -> { SendCommunityChatRecapNotificationsJob.new.perform(*args) }
  capture(name, now: NOW, tables: TABLES, seed:, sidekiq: true, args:, notified: $notified, &block)
end

# Two sellers (1, 2), each with a product and a community, and members 10-13.
def base(**extra)
  {
    users: [user_row(1), user_row(2), user_row(10), user_row(11), user_row(12), user_row(13)],
    links: [link_row(101, 1), link_row(102, 2)],
    communities: [community_row(201, 101, 1), community_row(202, 102, 2)],
    community_chat_recap_runs: [run_row(61)],
    community_chat_recaps: [recap_row(301, 61, 201), recap_row(302, 61, 202)],
  }.merge(extra)
end

cases = []

cases << run("a run that does not exist", args: [404])
cases << run("a run that has not finished", seed: base(community_chat_recap_runs: [run_row(61, finished_at: nil)], community_notification_settings: [setting_row(1, 1, 1)]))
cases << run("no finished recaps", seed: base(community_chat_recaps: [recap_row(301, 61, 201, "pending"), recap_row(302, 61, 202, "failed")], community_notification_settings: [setting_row(1, 1, 1)]))
cases << run("recaps of another run only", seed: base(community_chat_recap_runs: [run_row(61), run_row(62, "weekly", from_date: "2025-10-20 00:00:00")],
                                                      community_chat_recaps: [recap_row(301, 62, 201)], community_notification_settings: [setting_row(1, 1, 1)]))
cases << run("no settings for the run's frequency", seed: base(community_notification_settings: [setting_row(1, 10, 1, "weekly"), setting_row(2, 11, 1, nil)]))
cases << run("settings whose sellers have no live community", seed: base(
  communities: [community_row(201, 101, 1, deleted_at: SEEDED_AT)], community_notification_settings: [setting_row(1, 10, 1)],
))
cases << run("a seller reads their own community", seed: base(community_notification_settings: [setting_row(1, 1, 1)]))
cases << run("a buyer by purchaser id", seed: base(
  community_notification_settings: [setting_row(1, 10, 1)], purchases: [purchase_row(401, 101, purchaser_id: 10, email: "someone@example.com")],
))
cases << run("a buyer by purchase email", seed: base(
  community_notification_settings: [setting_row(1, 10, 1)], purchases: [purchase_row(401, 101, email: "user10@example.com")],
))
cases << run("purchases that do not count", seed: base(
  community_notification_settings: [setting_row(1, 10, 1)],
  purchases: [purchase_row(401, 101, purchaser_id: 10, purchase_state: "failed"), purchase_row(402, 102, purchaser_id: 11), purchase_row(403, 101, email: "USER10@example.org")],
))
cases << run("a buyer with several purchases of one product", seed: base(
  community_notification_settings: [setting_row(1, 10, 1)],
  purchases: [purchase_row(401, 101, purchaser_id: 10), purchase_row(402, 101, purchaser_id: 10), purchase_row(403, 101, email: "user10@example.com")],
))
cases << run("products that are not alive or have chat off", seed: base(
  links: [link_row(101, 1, deleted_at: SEEDED_AT), link_row(102, 2, flags: 0), link_row(103, 1, banned_at: SEEDED_AT), link_row(104, 1, purchase_disabled_at: SEEDED_AT)],
  communities: [community_row(201, 101, 1), community_row(202, 102, 2), community_row(203, 103, 1), community_row(204, 104, 1)],
  community_chat_recaps: [recap_row(301, 61, 201), recap_row(302, 61, 202), recap_row(303, 61, 203), recap_row(304, 61, 204)],
  community_notification_settings: [setting_row(1, 1, 1), setting_row(2, 1, 2)],
))
cases << run("a community whose recap is not finished", seed: base(
  community_chat_recaps: [recap_row(301, 61, 201, "pending"), recap_row(302, 61, 202)], community_notification_settings: [setting_row(1, 1, 1), setting_row(2, 1, 2)],
))
cases << run("several members and sellers, one mail each", seed: base(
  links: [link_row(101, 1), link_row(102, 2), link_row(103, 1)],
  communities: [community_row(201, 101, 1), community_row(202, 102, 2), community_row(203, 103, 1)],
  community_chat_recaps: [recap_row(301, 61, 201), recap_row(302, 61, 202), recap_row(303, 61, 203), recap_row(304, 61, 201)],
  community_notification_settings: [setting_row(1, 12, 2), setting_row(2, 10, 1), setting_row(3, 10, 2), setting_row(4, 11, 1, "weekly"), setting_row(5, 13, 1)],
  purchases: [purchase_row(401, 101, purchaser_id: 10), purchase_row(402, 102, purchaser_id: 10), purchase_row(403, 102, purchaser_id: 12), purchase_row(404, 103, email: "user13@example.com")],
))
cases << run("the weekly run", seed: base(
  community_chat_recap_runs: [run_row(61, "weekly")], community_notification_settings: [setting_row(1, 10, 1, "weekly"), setting_row(2, 11, 1, "daily")],
  purchases: [purchase_row(401, 101, purchaser_id: 10)],
))
cases << run("a member whose email has quotes", seed: base(
  users: [user_row(1), user_row(2), user_row(10, email: "o'brien\\x@example.com")], community_notification_settings: [setting_row(1, 10, 1)],
  purchases: [purchase_row(401, 101, email: "o'brien\\x@example.com")],
))
cases << run("a member without an email", seed: base(
  users: [user_row(1), user_row(2), user_row(10, email: nil)], community_notification_settings: [setting_row(1, 10, 1)], purchases: [purchase_row(401, 101, purchaser_id: 10)],
))
cases << run("a setting whose user is gone, after a mail was queued", seed: base(
  community_notification_settings: [setting_row(1, 1, 1), setting_row(2, 99, 2), setting_row(3, 2, 2)],
))
cases << run("a community whose product row is gone", seed: base(
  communities: [community_row(201, 999, 1)], community_notification_settings: [setting_row(1, 1, 1)],
))
cases << run("a community on something other than a product", seed: base(
  communities: [community_row(201, 101, 1, resource_type: "Installment")], community_notification_settings: [setting_row(1, 1, 1)],
))

now_f = travel_to(NOW, with_usec: true) { Time.now.to_f }
File.write(OUT, JSON.pretty_generate({ "now" => now_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
