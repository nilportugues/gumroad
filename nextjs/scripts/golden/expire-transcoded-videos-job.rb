# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/expire-transcoded-videos-job.golden.json: ExpireTranscodedVideosJob run by the real
# app against a scratch database and Redis as a Sidekiq job (support/sidekiq_executor.rb). The first TranscodedVideo#mark_deleted!
# is what Node hands back to Rails; those cases are recorded up to the call a marker exception stands in for. Run it like
# flush-delivered-email-infos-job.rb, with USE_DB_WORKER_REPLICAS=true and one Redis database for REDIS_HOST and SIDEKIQ_REDIS_HOST:
#
#   bundle exec rails runner nextjs/scripts/golden/expire-transcoded-videos-job.rb
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/expire-transcoded-videos-job.golden.json")
NOW = Time.utc(2026, 11, 30, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[transcoded_videos].freeze
LIMIT_KEY = RedisKey.transcoded_videos_recentness_limit_in_months

Rails.logger = ActiveSupport::Logger.new(nil)

class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

TranscodedVideo.prepend(Module.new do
  def mark_deleted!(*) = raise(HandBackMarker)
end)

$replica_lag_watches = 0
ReplicaLagWatcher.singleton_class.prepend(Module.new do
  def watch(*) = ($replica_lag_watches += 1)
end)

def video(id, last_accessed_at:, **overrides)
  {
    id:, original_video_key: "original/#{id}.mp4", transcoded_video_key: "transcoded/#{id}.m3u8", state: "completed", flags: 0,
    last_accessed_at:, created_at: SEEDED_AT, updated_at: SEEDED_AT
  }.merge(overrides)
end

def run(name, rows, limit: nil)
  $replica_lag_watches = 0
  hands_back = false
  result = capture(name, now: NOW, tables: TABLES, seed: { transcoded_videos: rows }, sidekiq: true, setup: limit && -> { redis.set(LIMIT_KEY, limit) }, job: "ExpireTranscodedVideosJob", args: []) do
    ExpireTranscodedVideosJob.new.perform
  rescue HandBackMarker
    hands_back = true
  end
  result.delete("rows")
  result.delete("seed")
  result.merge("replica_lag_watches" => $replica_lag_watches, "hands_back" => hands_back)
end

OLD = "2023-01-01 00:00:00"
RECENT = "2026-10-01 00:00:00"
DELETED = { deleted_at: "2026-11-01 00:00:00" }.freeze

cases = []
cases << run("no videos and no limit", [])
cases << run("an ancient video under the default limit of 100 years", [video(1, last_accessed_at: "1900-01-01 00:00:00")])
cases << run("an old video under the default limit", [video(1, last_accessed_at: OLD)])
cases << run("a limit of 12 months and no videos", [], limit: "12")
cases << run("a limit of 12 months and only recent videos", [video(1, last_accessed_at: RECENT)], limit: "12")
cases << run("a limit of 12 months and an old video", [video(1, last_accessed_at: OLD)], limit: "12")
cases << run("a limit of 12 months and an old deleted video", [video(1, last_accessed_at: OLD, **DELETED)], limit: "12")
cases << run("a limit of 12 months and a video never accessed", [video(1, last_accessed_at: nil)], limit: "12")
cases << run("a limit of 1 month and a video accessed exactly at the cutoff", [video(1, last_accessed_at: "2026-10-30 12:30:45")], limit: "1")
cases << run("a limit of 1 month and a video accessed a second after the cutoff", [video(1, last_accessed_at: "2026-10-30 12:30:46")], limit: "1")
cases << run("a limit of 1 month and a video accessed a second before the cutoff", [video(1, last_accessed_at: "2026-10-30 12:30:44")], limit: "1")
cases << run("a limit of 3 months counted back from the 30th clamps to a shorter month", [video(1, last_accessed_at: "2026-08-30 12:30:45")], limit: "3")
cases << run("a limit of 9 months counted back across a year end", [video(1, last_accessed_at: "2026-02-28 12:30:45")], limit: "9")
cases << run("a limit of 0 months", [video(1, last_accessed_at: "2026-11-30 12:30:45")], limit: "0")
cases << run("a limit of 0 months and a video accessed after now", [video(1, last_accessed_at: "2026-11-30 12:30:46")], limit: "0")
cases << run("a negative limit puts the cutoff in the future", [video(1, last_accessed_at: "2026-12-15 00:00:00")], limit: "-1")
cases << run("a blank limit counts as 0 months", [video(1, last_accessed_at: "2026-11-30 12:30:45")], limit: "")
cases << run("a limit that is not a number counts as 0 months", [video(1, last_accessed_at: "2026-11-30 12:30:45")], limit: "forever")
cases << run("a limit with trailing text", [video(1, last_accessed_at: OLD)], limit: "12 months")
cases << run("a limit with leading spaces", [video(1, last_accessed_at: OLD)], limit: "  12")
cases << run("a limit with underscores", [video(1, last_accessed_at: OLD)], limit: "1_2")
cases << run("a limit with a leading plus", [video(1, last_accessed_at: RECENT)], limit: "+12")
cases << run("a decimal limit is cut at the point", [video(1, last_accessed_at: OLD)], limit: "12.9")
cases << run("101 old videos", (1..101).map { video(_1, last_accessed_at: OLD) }, limit: "12")

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
