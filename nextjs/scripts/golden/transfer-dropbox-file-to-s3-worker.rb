# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/transfer-dropbox-file-to-s3-worker.golden.json: TransferDropboxFileToS3Worker run by the
# real app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). A file still in progress is either failed (an
# expired link) or downloaded and uploaded to S3, which Node hands back to Rails; those cases are recorded up to the first write, which a
# marker exception stands in for. Run it like pdf-unstampable-notifier-job.rb (env as in publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/transfer-dropbox-file-to-s3-worker.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[dropbox_files].freeze

Rails.logger = ActiveSupport::Logger.new(nil)

class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

DropboxFile.prepend(Module.new do
  def mark_failed! = raise(HandBackMarker)
  def set_json_data_for_attr(*) = raise(HandBackMarker)
end)

def at(seconds_from_now) = (NOW + seconds_from_now).utc.strftime("%Y-%m-%d %H:%M:%S")

def file_row(id, **overrides)
  { id:, state: "in_progress", dropbox_url: "https://example.com/files/#{id}.pdf", expires_at: at(3600), user_id: 1,
    json_data: { file_name: "file#{id}.pdf", file_size: 10 }.to_json, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def run(name, args, *files)
  hands_back = false
  result = capture(name, now: NOW, tables: TABLES, seed: { dropbox_files: files }, sidekiq: true, job: "TransferDropboxFileToS3Worker", args:) do
    TransferDropboxFileToS3Worker.new.perform(*args)
  rescue HandBackMarker
    hands_back = true
  rescue ArgumentError => e
    # `Time.current > nil`: Node does not reproduce Ruby's message, it hands a file without an expiry back.
    raise unless e.message.start_with?("comparison of")

    hands_back = true
  end
  result.delete("rows")
  result.delete("seed")
  result.merge("hands_back" => hands_back)
end

cases = []
cases << run("a file that does not exist", [9])
cases << run("a file that does not exist among others", [9], file_row(1), file_row(2))
cases << run("a file in progress", [1], file_row(1))
cases << run("a file in progress among others", [2], file_row(1, state: "cancelled"), file_row(2), file_row(3))
cases << run("a file in progress whose link expired", [1], file_row(1, expires_at: at(-60)))
cases << run("a file in progress whose link expires at the current second", [1], file_row(1, expires_at: at(0)))
cases << run("a file in progress without an expiry", [1], file_row(1, expires_at: nil))
cases << run("a file in progress that was deleted", [1], file_row(1, deleted_at: at(-60)))
%w[successfully_uploaded cancelled failed deleted].each do |state|
  cases << run("a #{state} file", [1], file_row(1, state:))
  cases << run("a #{state} file whose link expired", [1], file_row(1, state:, expires_at: at(-60)))
end
cases << run("a file without a state", [1], file_row(1, state: nil))
cases << run("a file with an unknown state", [1], file_row(1, state: "archived"))
cases << run("a file id as a digit string", ["1"], file_row(1, state: "cancelled"))
cases << run("a file in progress id as a digit string", ["1"], file_row(1))
cases << run("a file id of nil", [nil], file_row(1))
cases << run("a file id as a float", [1.0], file_row(1))
cases << run("a file id as a word", ["one"], file_row(1))

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
