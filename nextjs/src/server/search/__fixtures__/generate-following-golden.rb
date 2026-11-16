# frozen_string_literal: true

# Produces following.golden.json: CreatorAnalytics::Following (the Audience page's chart data) and the
# ConfirmedFollowerEvent search behind the dashboard's follower activity, run on the real app against
# the real Elasticsearch through the recording proxy (es_recording_proxy.rb). The index is
# ws65-confirmedfollowerevent, filled with a fixed set of follow and unfollow events.
#
#   scratchpad/ws65-run.sh bin/rails runner nextjs/src/server/search/__fixtures__/generate-following-golden.rb
abort "Refusing to run outside the test environment" unless Rails.env.test?
abort "Refusing to run against #{ActiveRecord::Base.connection.current_database}" unless ActiveRecord::Base.connection.current_database == "gumroad_ws65"

require_relative "es_recording_proxy"
require "active_support/testing/time_helpers"
include ActiveSupport::Testing::TimeHelpers
connect_recording_client!

FIXED_NOW = Time.utc(2026, 9, 10, 3, 30, 0)
travel_to(FIXED_NOW)

ConfirmedFollowerEvent.index_name("ws65-confirmedfollowerevent")
ConfirmedFollowerEvent.__elasticsearch__.create_index!(force: true)

events = [
  ["added", "2026-08-20T10:00:00Z", 1], ["added", "2026-08-31T23:30:00Z", 2], ["added", "2026-09-01T06:59:59Z", 3], ["added", "2026-09-01T07:00:00Z", 4],
  ["removed", "2026-09-02T12:00:00Z", 1], ["added", "2026-09-03T01:00:00Z", 5], ["added", "2026-09-03T23:59:59Z", 6], ["added", "2026-09-05T00:00:00Z", 7],
  ["removed", "2026-09-05T15:00:00Z", 2], ["added", "2026-09-09T20:00:00Z", 8],
]
events.each_with_index do |(name, timestamp, follower_id), index|
  EsClient.index(index: ConfirmedFollowerEvent.index_name, id: "e#{index}", body: { name:, timestamp:, follower_id:, followed_user_id: 42, follower_user_id: 1000 + follower_id, email: "f#{follower_id}@example.com" })
end
EsClient.index(index: ConfirmedFollowerEvent.index_name, id: "other", body: { name: "added", timestamp: "2026-09-02T00:00:00Z", follower_id: 99, followed_user_id: 43, follower_user_id: 1099, email: "x@example.com" })
EsClient.indices.refresh(index: ConfirmedFollowerEvent.index_name)

def exchanges_log = EsProxy.log.map { _1.except("response").merge("response" => JSON.parse(_1["response"]).except("took")) }

def record
  EsProxy.log.clear
  EsProxy.on = true
  value = yield
  [value, exchanges_log]
rescue StandardError => e
  [{ "error" => { "class" => e.class.name, "message" => e.message } }, exchanges_log]
ensure
  EsProxy.on = false
end

cases = []
[
  ["Pacific Time (US & Canada)", "2026-09-01", "2026-09-07"],
  ["UTC", "2026-09-01", "2026-09-07"],
  ["London", "2026-08-30", "2026-09-10"],
  ["Tokyo", "2026-09-02", "2026-09-04"],
  ["Mumbai", "2026-09-01", "2026-09-05"],
  ["Sydney", "2026-09-04", "2026-09-10"],
  ["Pacific Time (US & Canada)", "2026-09-05", "2026-09-05"],
  ["Pacific Time (US & Canada)", "2026-01-01", "2026-01-03"],
  ["Pacific Time (US & Canada)", "2027-01-01", "2027-01-03"],
  ["Santiago", "2026-09-04", "2026-09-08"],
].each do |timezone, from, to|
  user = User.new(timezone:)
  user.id = 42
  outcome, exchanges = record { JSON.parse(CreatorAnalytics::Following.new(user).by_date(start_date: Date.parse(from), end_date: Date.parse(to)).to_json) }
  cases << { "kind" => "by_date", "timezone" => timezone, "from" => from, "to" => to, "user_id" => 42, "outcome" => outcome, "exchanges" => exchanges }
end

# A seller with no followers at all.
user = User.new(timezone: "Pacific Time (US & Canada)")
user.id = 4242
outcome, exchanges = record { JSON.parse(CreatorAnalytics::Following.new(user).by_date(start_date: Date.parse("2026-09-01"), end_date: Date.parse("2026-09-03")).to_json) }
cases << { "kind" => "by_date", "timezone" => "Pacific Time (US & Canada)", "from" => "2026-09-01", "to" => "2026-09-03", "user_id" => 4242, "outcome" => outcome, "exchanges" => exchanges }

user = User.new(timezone: "Eastern Time (US & Canada)")
user.id = 42
[nil, "2026-09-03"].each do |before|
  outcome, exchanges = record { CreatorAnalytics::Following.new(user).net_total(before_date: before&.then { Date.parse(_1) }) }
  cases << { "kind" => "net_total", "timezone" => user.timezone, "before" => before, "user_id" => 42, "outcome" => outcome, "exchanges" => exchanges }
end

# CreatorHomePresenter#followers_activity_items' search.
presenter = CreatorHomePresenter.allocate
seller = User.new
seller.id = 42
presenter.instance_variable_set(:@seller, seller)
outcome, exchanges = record { presenter.send(:followers_activity_items).then { JSON.parse(_1.to_json) } }
cases << { "kind" => "followers_activity", "user_id" => 42, "outcome" => outcome, "exchanges" => exchanges }

File.write(File.join(__dir__, "following.golden.json"), JSON.pretty_generate("index" => ConfirmedFollowerEvent.index_name, "now" => FIXED_NOW.iso8601, "cases" => cases) + "\n")
puts "wrote #{cases.size} cases"
