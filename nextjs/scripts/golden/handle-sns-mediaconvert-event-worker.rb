# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/handle-sns-mediaconvert-event-worker.golden.json: HandleSnsMediaconvertEventWorker run by
# the real app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). TranscodeEventHandler#handle_transcoding_job_notification
# (which updates the videos and their streamables) is replaced by a recorder; the golden keeps the arguments it was called with under
# `processed`. Run it like publish-scheduled-post.rb (env in its header).
require_relative "support/rails_cases"
include RailsCases
capture_http!

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/handle-sns-mediaconvert-event-worker.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[transcoded_videos].freeze

Rails.logger = ActiveSupport::Logger.new(nil)

$processed = []
HandleSnsMediaconvertEventWorker.prepend(Module.new do
  private
    define_method(:handle_transcoding_job_notification) { |*args| $processed << args }
end)

def video_row(id, **overrides)
  { id:, original_video_key: "original/#{id}.mp4", transcoded_video_key: "transcoded/#{id}/", job_id: "job#{id}", state: "processing",
    created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

BUCKET = S3_BUCKET

def notification(detail, type: "Notification")
  { "Type" => type, "Message" => { "detail" => detail }.to_json }
end

def complete(job_id, path = "s3://#{BUCKET}/transcoded/1/index.m3u8")
  notification({ "jobId" => job_id, "status" => "COMPLETE", "outputGroupDetails" => [{ "playlistFilePaths" => [path] }] })
end

def run(name, args, rows)
  $processed = []
  result = capture(name, now: NOW, tables: TABLES, seed: { transcoded_videos: rows }, sidekiq: true, job: "HandleSnsMediaconvertEventWorker", args:) do
    HandleSnsMediaconvertEventWorker.new.perform(*args)
  end
  result.delete("seed")
  result.delete("rows")
  result.merge("processed" => $processed.dup)
end

cases = []
cases << run("a message that is not a notification", [notification({ "jobId" => "job1" }, type: "SubscriptionConfirmation")], [video_row(1)])
cases << run("a notification type of nil", [{ "Message" => "{}" }], [video_row(1)])
cases << run("a completed job in flight", [complete("job1")], [video_row(1)])
cases << run("a completed job already finished", [complete("job1")], [video_row(1, state: "completed")])
cases << run("a completed job already failed", [complete("job1")], [video_row(1, state: "error")])
cases << run("a completed job nobody knows", [complete("nope")], [video_row(1)])
cases << run("an error event for a job in flight", [notification({ "jobId" => "job1", "status" => "ERROR" })], [video_row(1)])
cases << run("a canceled event for a job in flight", [notification({ "jobId" => "job1", "status" => "CANCELED" })], [video_row(1)])
cases << run("a completed event with a path outside the bucket", [complete("job1", "s3://other-bucket/x/index.m3u8")], [video_row(1)])
cases << run("a completed event with no output details", [notification({ "jobId" => "job1", "status" => "COMPLETE" })], [video_row(1)])
cases << run("a completed event with empty output groups", [notification({ "jobId" => "job1", "status" => "COMPLETE", "outputGroupDetails" => [] })], [video_row(1)])
cases << run("a completed event with no playlist paths", [notification({ "jobId" => "job1", "status" => "COMPLETE", "outputGroupDetails" => [{ "playlistFilePaths" => [] }] })], [video_row(1)])
cases << run("a completed event with a path of nil", [notification({ "jobId" => "job1", "status" => "COMPLETE", "outputGroupDetails" => [{ "playlistFilePaths" => [nil] }] })], [video_row(1)])
cases << run("a completed event with a path that is a number", [notification({ "jobId" => "job1", "status" => "COMPLETE", "outputGroupDetails" => [{ "playlistFilePaths" => [5] }] })], [video_row(1)])
cases << run("a completed event whose output groups are not an array", [notification({ "jobId" => "job1", "status" => "COMPLETE", "outputGroupDetails" => "x" })], [video_row(1)])
cases << run("a job id of an empty string", [notification({ "jobId" => "", "status" => "COMPLETE" })], [video_row(1)])
cases << run("a job id with a quote", [notification({ "jobId" => "a'b", "status" => "COMPLETE" })], [video_row(1)])
cases << run("a job id of nil", [notification({ "jobId" => nil, "status" => "COMPLETE" })], [video_row(1)])
cases << run("a job id missing", [notification({ "status" => "COMPLETE" })], [video_row(1, job_id: nil)])
cases << run("a job id given as an integer", [notification({ "jobId" => 1, "status" => "COMPLETE" })], [video_row(1, job_id: "1")])
cases << run("a status of nil", [notification({ "jobId" => "job1" })], [video_row(1)])
cases << run("a message that is not json", [{ "Type" => "Notification", "Message" => "not json" }], [video_row(1)])
cases << run("a message without detail", [{ "Type" => "Notification", "Message" => "{}" }], [video_row(1)])
cases << run("a message whose detail is a string", [{ "Type" => "Notification", "Message" => '{"detail":"x"}' }], [video_row(1)])
cases << run("a message that is nil", [{ "Type" => "Notification" }], [video_row(1)])
cases << run("a message that is a json array", [{ "Type" => "Notification", "Message" => "[1]" }], [video_row(1)])
cases << run("a notification that is nil", [nil], [video_row(1)])
cases << run("a notification that is a string", ["x"], [video_row(1)])

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
