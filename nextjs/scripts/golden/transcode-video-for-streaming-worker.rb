# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/transcode-video-for-streaming-worker.golden.json: TranscodeVideoForStreamingWorker run by the
# real app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). A Link is no longer transcoded and a deleted file ends
# the job; a file that is found goes on to `attempt_to_transcode?` (transcoded_videos reads, then MediaConvert or GRMC), which Node hands back
# to Rails: those cases are recorded up to it, which a marker exception stands in for. Run it like pdf-unstampable-notifier-job.rb (env as in
# publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/transcode-video-for-streaming-worker.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[links product_files].freeze

Rails.logger = ActiveSupport::Logger.new(nil)

class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

ProductFile.prepend(Module.new do
  def attempt_to_transcode?(*, **) = raise(HandBackMarker)
end)

def link_row(id, **overrides) = { id:, name: "Product #{id}", user_id: 1, unique_permalink: "p#{id}", price_currency_type: "usd", flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)

def file_row(id, link_id: 1, **overrides)
  { id:, link_id:, url: "https://example.com/files/#{id}.mp4", filetype: "mp4", created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def run(name, args, files)
  hands_back = false
  result = capture(name, now: NOW, tables: TABLES, seed: { links: [link_row(1)], product_files: files }, sidekiq: true, job: "TranscodeVideoForStreamingWorker", args:) do
    TranscodeVideoForStreamingWorker.new.perform(*args)
  rescue HandBackMarker
    hands_back = true
  end
  result.delete("rows")
  result.delete("seed")
  result.merge("hands_back" => hands_back)
end

cases = []
cases << run("a video file", [1], [file_row(1)])
cases << run("a video file among others", [2], [file_row(1), file_row(2), file_row(3)])
cases << run("a file that does not exist", [9], [file_row(1)])
cases << run("a deleted file", [1], [file_row(1, deleted_at: SEEDED_AT)])
cases << run("the file class named", [1, "ProductFile"], [file_row(1)])
cases << run("a deleted file with the class named", [1, "ProductFile"], [file_row(1, deleted_at: SEEDED_AT)])
cases << run("a link", [1, "Link"], [file_row(1)])
cases << run("a link that does not exist", [9, "Link"], [])
cases << run("a transcoder and the allowed-when-processing flag", [1, "ProductFile", "mediaconvert", true], [file_row(1)])
cases << run("the transcoder named", [1, "ProductFile", "grmc"], [file_row(1)])
cases << run("the file id as a digit string", ["2"], [file_row(1), file_row(2)])
cases << run("a file id of zero", [0], [file_row(1)])
cases << run("a file id of nil", [nil], [file_row(1)])
cases << run("a file id as a float", [1.0], [file_row(1)])
cases << run("a file id as a word", ["one"], [file_row(1)])
cases << run("another class", [1, "Installment"], [file_row(1)])
cases << run("no arguments", [], [file_row(1)])
cases << run("five arguments", [1, "ProductFile", "grmc", false, 1], [file_row(1)])

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
