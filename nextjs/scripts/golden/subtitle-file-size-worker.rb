# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/subtitle-file-size-worker.golden.json: SubtitleFileSizeWorker run by the real app
# against a scratch database as a Sidekiq job (support/sidekiq_executor.rb), with the S3 HEAD request captured and answered by
# WebMock (capture_http!). Run it like submit-to-indexnow-job.rb (env as in publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases
capture_http!

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/subtitle-file-size-worker.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[subtitle_files product_files versions].freeze
URL = "#{S3_BASE_URL}attachments/0123456789abcdef0123456789abcdef/original/english.srt"

Rails.logger = ActiveSupport::Logger.new(nil)

def product_file_row(id, **overrides) = { id:, link_id: 1, url: "#{S3_BASE_URL}attachments/video#{id}/original/movie.mp4", flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)

def subtitle_row(id, **overrides) = { id:, url: URL, language: "English", product_file_id: 1, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)

def head(length) = { status: 200, body: "", headers: length.nil? ? {} : { "Content-Length" => length.to_s } }

SEED = { product_files: [product_file_row(1)], subtitle_files: [subtitle_row(1)] }.freeze

def run(name, seed = SEED, id = 1, responses: [head(1234)])
  result = capture(name, now: NOW, tables: TABLES, seed:, sidekiq: true, job: "SubtitleFileSizeWorker", args: [id], http_responses: responses) do
    SubtitleFileSizeWorker.new.perform(id)
  end
  result.delete("rows")
  result.delete("seed")
  result
end

with_size = ->(size) { { product_files: [product_file_row(1)], subtitle_files: [subtitle_row(1, size:)] } }

cases = []
cases << run("a subtitle file with no size yet")
cases << run("a size that changes", with_size.(10))
cases << run("a size that is already stored", with_size.(1234))
cases << run("an empty file", responses: [head(0)])
cases << run("the largest size an integer column holds", responses: [head(2_147_483_647)])
cases << run("a size past an integer column", responses: [head(2_147_483_648)])
cases << run("an answer without a content length", with_size.(10), responses: [head(nil)])
cases << run("a file that is not in storage", responses: [{ status: 404, body: "" }])
cases << run("a file the credentials cannot read", responses: [{ status: 403, body: "" }])
cases << run("a storage error", responses: [{ status: 500, body: "" }])
cases << run("a subtitle file that does not exist", SEED, 99)
cases << run("a nil id", SEED, nil)
cases << run("an id given as a digit string", SEED, "1")
cases << run("a deleted subtitle file is still measured", { product_files: [product_file_row(1)], subtitle_files: [subtitle_row(1, deleted_at: SEEDED_AT)] })
cases << run("a subtitle type storage does not support", { product_files: [product_file_row(1)], subtitle_files: [subtitle_row(1, url: "#{S3_BASE_URL}attachments/abc/original/english.txt")] })
cases << run("a deleted subtitle file of an unsupported type", { product_files: [product_file_row(1)], subtitle_files: [subtitle_row(1, url: "#{S3_BASE_URL}attachments/abc/original/english.txt", deleted_at: SEEDED_AT)] })
cases << run("every supported subtitle type", { product_files: [product_file_row(1)], subtitle_files: [subtitle_row(1, url: "#{S3_BASE_URL}attachments/abc/original/a.vtt")] })
cases << run("a subtitle file with no product file", { subtitle_files: [subtitle_row(1, product_file_id: nil)] })
cases << run("a subtitle file whose product file is gone", { subtitle_files: [subtitle_row(1, product_file_id: 7)] })
cases << run("a url outside storage", { product_files: [product_file_row(1)], subtitle_files: [subtitle_row(1, url: "https://example.com/english.srt")] })
cases << run("a url with no value", { product_files: [product_file_row(1)], subtitle_files: [subtitle_row(1, url: nil)] })
cases << run("a url with a key that needs escaping", { product_files: [product_file_row(1)], subtitle_files: [subtitle_row(1, url: "#{S3_BASE_URL}attachments/abc/original/english subs+1.srt")] })
cases << run("a url with a deep key", { product_files: [product_file_row(1)], subtitle_files: [subtitle_row(1, url: "#{S3_BASE_URL}a/b/c/d/e/f.srt")] })
cases << run("another subtitle file is left alone", { product_files: [product_file_row(1)], subtitle_files: [subtitle_row(1), subtitle_row(2, size: 5)] })

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "s3_base_url" => S3_BASE_URL, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
