# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/generate-merchant-center-feed-worker.golden.json: GenerateMerchantCenterFeedWorker (and the
# MerchantCenterFeedRun it drives) run by the real app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). Publishing
# a unit is the product scan and the S3 upload, which Node hands back: a marker exception stands in for MerchantCenterFeedService#generate
# and #generate_shard, so those cases are recorded up to there. The Redis a case starts from is set in `setup` (`redis_before`).
# `calls` scripts what the kill switch check does on its Nth call: "engage" turns it on, "steal" overwrites the feed lock with another
# run's token first. Run it like publish-scheduled-post.rb (env as there):
#
#   bundle exec rails runner nextjs/scripts/golden/generate-merchant-center-feed-worker.rb
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/generate-merchant-center-feed-worker.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[links].freeze
LOCK = RedisKey.merchant_center_feed_lock
PROGRESS = RedisKey.merchant_center_feed_progress
MAX_SHARD = RedisKey.merchant_center_feed_max_shard

Rails.logger = ActiveSupport::Logger.new(nil)

class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

MerchantCenterFeedService.prepend(Module.new do
  def generate(*, **) = raise(HandBackMarker)
  def generate_shard(*) = raise(HandBackMarker)
end)

$calls = {}
$kill_switch_calls = 0
MerchantCenterFeedRun.prepend(Module.new do
  def kill_switch?
    $kill_switch_calls += 1
    case $calls[$kill_switch_calls]
    when "engage" then return true
    when "steal" then $redis.set(RedisKey.merchant_center_feed_lock, "another-run-token")
    end
    super
  end
end)

def link_row(id) = { id:, name: "Product #{id}", user_id: 1, unique_permalink: "p#{id}", price_currency_type: "usd", flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }

def run(name, args = [], links: [], strings: {}, hashes: {}, features: [], calls: {})
  $calls = calls
  $kill_switch_calls = 0
  setup = lambda do
    features.each { |feature| Feature.activate(feature) }
    strings.each { |key, value| redis.set(key, value) }
    hashes.each { |key, value| redis.hset(key, value) }
  end
  hands_back = false
  result = capture(name, now: NOW, tables: TABLES, seed: { links: }, setup:, sidekiq: true, job: "GenerateMerchantCenterFeedWorker", args:, calls: calls.transform_keys(&:to_s)) do
    GenerateMerchantCenterFeedWorker.new.perform(*args)
  rescue HandBackMarker
    hands_back = true
  end
  result.delete("seed")
  result.delete("rows")
  result.merge("hands_back" => hands_back)
end

cases = []
cases << run("nothing in the way")
cases << run("a seller's products exist", links: [link_row(1), link_row(1_500_000)])
cases << run("the shard limit is set", links: [link_row(2_500_000)], strings: { MAX_SHARD => "1" })
cases << run("the shard limit is not a number", links: [link_row(2_500_000)], strings: { MAX_SHARD => "abc" })
cases << run("some units are finished", hashes: { PROGRESS => { "legacy" => "1762000000" } })
cases << run("every unit is finished", hashes: { PROGRESS => { "legacy" => "1762000000" } })
cases << run("every unit is finished with shards", links: [link_row(1_500_000)], strings: { MAX_SHARD => "5" }, hashes: { PROGRESS => { "legacy" => "1", "shard:0" => "1", "shard:1" => "1" } })
cases << run("explicit arguments", [500, 2])
cases << run("the feed lock is held", strings: { LOCK => "another-run-token" })
cases << run("the feed lock is held on the second attempt", [100_000, 2], strings: { LOCK => "another-run-token" })
cases << run("the feed lock is held on the fourth attempt", [250, 4], strings: { LOCK => "another-run-token" })
cases << run("the feed lock is held on the fifth attempt", [250, 5], strings: { LOCK => "another-run-token" })
cases << run("the feed lock is held on the sixth attempt", [250, 6], strings: { LOCK => "another-run-token" })
cases << run("the feed lock is held with only a limit", [250], strings: { LOCK => "another-run-token" })
cases << run("the feed lock is held with an attempt of zero", [250, 0], strings: { LOCK => "another-run-token" })
cases << run("the feed lock is held with a negative attempt", [250, -3], strings: { LOCK => "another-run-token" })
cases << run("the kill switch is on", features: [:disable_merchant_center_feed])
cases << run("the kill switch is on and the lock is held", features: [:disable_merchant_center_feed], strings: { LOCK => "another-run-token" })
cases << run("the kill switch is turned on mid-run", calls: { 2 => "engage" })
cases << run("the feed lock is lost mid-run", calls: { 2 => "steal" })
cases << run("a limit given as a string", ["500"])
cases << run("a limit given as a float", [500.0])
cases << run("an attempt given as a string with the lock held", [250, "2"], strings: { LOCK => "another-run-token" })
cases << run("an attempt given as a float with the lock held", [250, 2.0], strings: { LOCK => "another-run-token" })
cases << run("a limit of nil with the lock held", [nil], strings: { LOCK => "another-run-token" })
cases << run("a limit given as a string with the lock held", ["500"], strings: { LOCK => "another-run-token" })

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
