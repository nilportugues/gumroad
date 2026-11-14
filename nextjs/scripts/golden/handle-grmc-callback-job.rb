# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/handle-grmc-callback-job.golden.json: HandleGrmcCallbackJob run by the real app against a
# scratch database as a Sidekiq job (support/sidekiq_executor.rb). The second `TranscodedVideo.processing` (the sweep over the videos of one
# source file, which updates streamables and enqueues transcodes) is replaced by `TranscodedVideo.none` plus a recorder, so the golden keeps
# the statements up to that point and the `original_video_key` it was asked to sweep under `processed`. Run it like
# publish-scheduled-post.rb (env in its header).
require_relative "support/rails_cases"
include RailsCases
capture_http!

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/handle-grmc-callback-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[transcoded_videos].freeze

Rails.logger = ActiveSupport::Logger.new(nil)

$processing_calls = 0
$processed = []
TranscodedVideo.singleton_class.prepend(Module.new do
  def processing
    $processing_calls += 1
    return super if $processing_calls == 1

    # The sweep: the original_video_key it filters on is the one of the video found first.
    $processed << :sweep
    none
  end
end)

def video_row(id, **overrides)
  { id:, original_video_key: "original/#{id}.mp4", transcoded_video_key: "transcoded/#{id}/", job_id: "job#{id}", state: "processing",
    created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def run(name, args, rows)
  $processing_calls = 0
  $processed = []
  result = capture(name, now: NOW, tables: TABLES, seed: { transcoded_videos: rows }, sidekiq: true, job: "HandleGrmcCallbackJob", args:) do
    HandleGrmcCallbackJob.new.perform(*args)
  end
  result.delete("seed")
  result.delete("rows")
  result.merge("processed" => $processed.dup)
end

cases = []
cases << run("a notification for no known job", [{ "job_id" => "nope", "status" => "success" }], [video_row(1)])
cases << run("a notification for a job in flight", [{ "job_id" => "job1", "status" => "success" }], [video_row(1)])
cases << run("an error notification for a job in flight", [{ "job_id" => "job1", "status" => "error" }], [video_row(1)])
cases << run("a notification for a job that completed", [{ "job_id" => "job1", "status" => "success" }], [video_row(1, state: "completed")])
cases << run("a notification for a job that failed", [{ "job_id" => "job1", "status" => "success" }], [video_row(1, state: "error")])
cases << run("a notification for a deleted video in flight", [{ "job_id" => "job1", "status" => "success" }], [video_row(1, deleted_at: SEEDED_AT)])
cases << run("two videos of the same source", [{ "job_id" => "job2", "status" => "success" }], [video_row(1, original_video_key: "original/s.mp4"), video_row(2, original_video_key: "original/s.mp4")])
cases << run("a job id the table does not hold among several videos", [{ "job_id" => "job9" }], [video_row(1), video_row(2)])
cases << run("a job id of an empty string", [{ "job_id" => "" }], [video_row(1)])
cases << run("a job id with a quote", [{ "job_id" => "a'b" }], [video_row(1)])
cases << run("a job id with a multibyte letter", [{ "job_id" => "jöb1" }], [video_row(1, job_id: "jöb1")])
cases << run("a notification without a job id", [{ "status" => "success" }], [video_row(1, job_id: nil)])
cases << run("a notification without a job id and no video", [{ "status" => "success" }], [])
cases << run("a job id of nil", [{ "job_id" => nil }], [video_row(1)])
cases << run("a job id given as an integer", [{ "job_id" => 1 }], [video_row(1, job_id: "1")])
cases << run("a job id given as an array", [{ "job_id" => ["job1"] }], [video_row(1)])
cases << run("a notification that is a string", ["job1"], [video_row(1)])
cases << run("a notification that is nil", [nil], [video_row(1)])
cases << run("a notification that is an array", [["job_id"]], [video_row(1)])

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
