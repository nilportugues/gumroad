# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/record-product-file-missing-from-storage-job.golden.json:
# RecordProductFileMissingFromStorageJob run by the real app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb).
# The two storage lookups (the Unicode-variant check and the object's `exists?`) are replaced by answers the case sets, and each call is
# recorded under `s3_calls`, so nothing reaches S3. A file that gets past the row checks always reaches them. Node answers an ASCII key
# (which has no Unicode variants) with one HEAD of its own and writes the marker; any other key hands back after the read.
# Run it like refresh-custom-domain-routability-worker.rb (env as in publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/record-product-file-missing-from-storage-job.golden.json")
# Whole seconds, so a file created exactly one grace period ago is exactly on the boundary.
NOW = Time.utc(2026, 11, 4, 12, 30, 45)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[product_files].freeze
ANALYZE_COMPLETED = 1 << 2
GRACE = 3 * 86_400
KEY = "attachments/abc/original/file.pdf"

Rails.logger = ActiveSupport::Logger.new(nil)

$s3_calls = []
$variant = nil
$exists = true
S3KeyUnicodeNormalization.singleton_class.prepend(Module.new do
  def existing_variant(s3_key, **)
    $s3_calls << ["existing_variant", s3_key]
    $variant
  end
end)
ProductFile.prepend(Module.new do
  def s3_object
    object = Object.new
    object.define_singleton_method(:exists?) { $s3_calls << ["exists?"]; $exists }
    object
  end
end)

def ago(seconds) = (NOW - seconds).utc.strftime("%Y-%m-%d %H:%M:%S")

def file_row(id, **overrides) = { id:, link_id: 1, url: "#{S3_BASE_URL}#{KEY}", filetype: "pdf", flags: 0, created_at: ago(GRACE + 1), updated_at: SEEDED_AT }.merge(overrides)

def run(name, args, rows, variant: nil, exists: true, now: NOW)
  $s3_calls = []
  $variant = variant
  $exists = exists
  result = capture(name, now:, tables: TABLES, seed: { product_files: rows }, sidekiq: true, job: "RecordProductFileMissingFromStorageJob", args:) do
    RecordProductFileMissingFromStorageJob.new.perform(*args)
  end
  result.delete("seed")
  result.merge("s3_calls" => $s3_calls.dup, "s3_base_url" => S3_BASE_URL, "at" => now.to_f)
end

cases = []
cases << run("a file that does not exist", [99], [])
cases << run("a file id of nil", [nil], [file_row(1)])
cases << run("a deleted file", [1], [file_row(1, deleted_at: SEEDED_AT)])
cases << run("a file hosted elsewhere", [1], [file_row(1, url: "https://files.example.com/a.pdf")])
cases << run("a file with an empty url", [1], [file_row(1, url: "")])
cases << run("a file without a url", [1], [file_row(1, url: nil)])
cases << run("a file with the storage prefix later in its url", [1], [file_row(1, url: "https://files.example.com/?u=#{S3_BASE_URL}a.pdf")])
cases << run("a file with a url that only resembles the storage prefix", [1], [file_row(1, url: S3_BASE_URL.chomp("/") + "x/a.pdf")])
cases << run("a file whose analysis completed", [1], [file_row(1, flags: ANALYZE_COMPLETED)])
cases << run("a file already marked missing", [1], [file_row(1, deleted_from_cdn_at: SEEDED_AT)])
cases << run("a file created just inside the grace period", [1], [file_row(1, created_at: ago(GRACE - 1))])
cases << run("a file created exactly at the grace period", [1], [file_row(1, created_at: ago(GRACE))])
cases << run("a file created just outside the grace period", [1], [file_row(1, created_at: ago(GRACE + 1))])
cases << run("a file created a minute ago", [1], [file_row(1, created_at: ago(60))])
cases << run("a file created in the future", [1], [file_row(1, created_at: ago(-60))])
cases << run("a file found under another unicode form", [1], [file_row(1)], variant: "other")
cases << run("a file present in storage", [1], [file_row(1)])
cases << run("a file missing from storage", [1], [file_row(1)], exists: false)
cases << run("a file id given as a digit string", ["1"], [file_row(1)], exists: false)
cases << run("a file id given as a float", [1.0], [file_row(1)], exists: false)
cases << run("a file id given as a word", ["abc"], [file_row(1)], exists: false)
cases << run("a file with spaces and parentheses in its key", [1], [file_row(1, url: "#{S3_BASE_URL}attachments/abc/original/my file (1).pdf")], exists: false)
cases << run("a file with an accented key missing from storage", [1], [file_row(1, url: "#{S3_BASE_URL}attachments/abc/original/caf\u00e9.pdf")], exists: false)
cases << run("a file with an accented key present in storage", [1], [file_row(1, url: "#{S3_BASE_URL}attachments/abc/original/caf\u00e9.pdf")])
cases << run("a file with an accented key found under another unicode form", [1], [file_row(1, url: "#{S3_BASE_URL}attachments/abc/original/caf\u00e9.pdf")], variant: "other")
cases << run("a file whose url is the storage prefix alone", [1], [file_row(1, url: S3_BASE_URL)], exists: false)
cases << run("a file marked missing at a fractional second", [1], [file_row(1)], exists: false, now: NOW + 0.789)
cases << run("another file that was created a minute ago", [2], [file_row(1), file_row(2, created_at: ago(60))])

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
