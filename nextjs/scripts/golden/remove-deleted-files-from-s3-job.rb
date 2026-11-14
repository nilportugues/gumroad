# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/remove-deleted-files-from-s3-job.golden.json: RemoveDeletedFilesFromS3Job run by the
# real app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). S3 is answered by WebMock (capture_http!), so
# the DeleteObjects and ListObjectsV2 requests are recorded and no bucket is reached. Run it like refresh-audience-member-job.rb:
#
#   bundle exec rails runner nextjs/scripts/golden/remove-deleted-files-from-s3-job.rb   (env as in publish-scheduled-post.rb)
ENV["S3_DELETER_ACCESS_KEY_ID"] = "AKIAEXAMPLEDELETER"
ENV["S3_DELETER_SECRET_ACCESS_KEY"] = "example-deleter-secret"
require_relative "support/rails_cases"
include RailsCases
capture_http!

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/remove-deleted-files-from-s3-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
TABLES = %w[product_files product_files_archives subtitle_files stamped_pdfs transcoded_videos product_builds links].freeze
BASE = S3_BASE_URL
SEEDED_AT = "2026-01-01 00:00:00"

Rails.logger = ActiveSupport::Logger.new(nil)

NOTIFIED = []
ErrorNotifier.singleton_class.prepend(Module.new do
  def notify(error, **options, &block)
    tab = nil
    block&.call(Object.new.tap { |report| report.define_singleton_method(:add_tab) { |name, **fields| tab = { "name" => name.to_s, "fields" => fields.as_json } } })
    NOTIFIED << { "class" => error.class.name, "message" => error.message, "tab" => tab }
  end
end)

def ago(hours) = (NOW - (hours * 3600)).strftime("%Y-%m-%d %H:%M:%S")
def url(key) = "#{BASE}#{key}"

def product_file_row(id, key, deleted_hours_ago: 48, **overrides)
  { id:, link_id: 1, url: url(key), flags: 0, deleted_at: deleted_hours_ago && ago(deleted_hours_ago), created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def simple_row(id, key, deleted_hours_ago: 48, **overrides)
  { id:, url: url(key), deleted_at: deleted_hours_ago && ago(deleted_hours_ago), created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def archive_row(id, key, deleted_hours_ago: 48, **overrides)
  { id:, link_id: 1, url: url(key), deleted_at: deleted_hours_ago && ago(deleted_hours_ago) }.merge(overrides)
end

def video_row(id, key, deleted_hours_ago: 48, flags: 0, **overrides)
  { id:, link_id: 1, original_video_key: "original/#{id}.mp4", transcoded_video_key: key, flags:, deleted_at: deleted_hours_ago && ago(deleted_hours_ago), created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def link_row(id, **overrides)
  { id:, name: "Product #{id}", flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def build_row(id, product_id, key)
  { id:, product_id:, public_id: "build#{id}".ljust(21, "x"), number: id, status: "live", source_url: "https://example.com/source.zip", storage_key: key, byte_size: 10, created_at: SEEDED_AT, updated_at: SEEDED_AT }
end

HLS_DIR = "transcoded/abc/hls/"

def list_xml(keys, truncated: false)
  contents = keys.map { "<Contents><Key>#{_1}</Key><Size>1</Size></Contents>" }.join
  %(<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>#{S3_BUCKET}</Name><Prefix></Prefix><KeyCount>#{keys.size}</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>#{truncated}</IsTruncated>#{contents}</ListBucketResult>)
end

DELETE_OK = { status: 200, body: %(<?xml version="1.0" encoding="UTF-8"?><DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"></DeleteResult>), headers: { "content-type" => "application/xml" } }.freeze
DENIED = { status: 403, body: %(<?xml version="1.0" encoding="UTF-8"?><Error><Code>AccessDenied</Code><Message>Access Denied</Message><RequestId>REQ</RequestId></Error>), headers: { "content-type" => "application/xml" } }.freeze

def run(name, args = [], seed: {}, responses: [])
  NOTIFIED.clear
  result = capture(name, now: NOW, tables: TABLES, seed:, sidekiq: true, job: "RemoveDeletedFilesFromS3Job", args:, http_responses: responses) do
    RemoveDeletedFilesFromS3Job.new.perform(*args)
  end
  result["http"] = result["http"].map { _1.slice("method", "url", "body") }
  result["notified"] = NOTIFIED.dup
  result.delete("seed")
  result.delete("rows")
  result
end

cases = []
cases << run("nothing deleted")
cases << run("a product file deleted two days ago", seed: { product_files: [product_file_row(1, "attachments/g1/original/a.pdf")] }, responses: [DELETE_OK])
cases << run("a product file deleted just inside the window", seed: { product_files: [product_file_row(1, "attachments/g1/original/a.pdf", deleted_hours_ago: 24.5)] }, responses: [DELETE_OK])
cases << run("a product file deleted too recently", seed: { product_files: [product_file_row(1, "attachments/g1/original/a.pdf", deleted_hours_ago: 23)] })
cases << run("a product file deleted too long ago", seed: { product_files: [product_file_row(1, "attachments/g1/original/a.pdf", deleted_hours_ago: 24 * 4)] })
cases << run("a product file deleted four days ago and a wider window", [60], seed: { product_files: [product_file_row(1, "attachments/g1/original/a.pdf", deleted_hours_ago: 24 * 4)] }, responses: [DELETE_OK])
cases << run("a window of one day", [1], seed: { product_files: [product_file_row(1, "attachments/g1/original/a.pdf", deleted_hours_ago: 24.5), product_file_row(2, "attachments/g2/original/b.pdf", deleted_hours_ago: 30)] }, responses: [DELETE_OK])
cases << run("a window of zero days", [0], seed: { product_files: [product_file_row(1, "attachments/g1/original/a.pdf")] })
cases << run("a negative window", [-1], seed: { product_files: [product_file_row(1, "attachments/g1/original/a.pdf")] })
cases << run("a live product file", seed: { product_files: [product_file_row(1, "attachments/g1/original/a.pdf", deleted_hours_ago: nil)] })
cases << run("a product file already deleted from the cdn", seed: { product_files: [product_file_row(1, "attachments/g1/original/a.pdf", deleted_from_cdn_at: "2026-11-03 00:00:00")] })
cases << run("a product file that is an external link", seed: { product_files: [product_file_row(1, "x", url: "https://example.com/file.pdf")] })
cases << run("a product file with no url", seed: { product_files: [product_file_row(1, "x", url: nil)] })
cases << run("a product file whose url is the bucket root", seed: { product_files: [product_file_row(1, "")] })
cases << run("a product file with a key containing slashes and spaces", seed: { product_files: [product_file_row(1, "attachments/g1/original/a folder/b & c.pdf")] }, responses: [DELETE_OK])
cases << run("a deleted product file with a live duplicate", seed: { product_files: [product_file_row(1, "attachments/g1/original/a.pdf"), product_file_row(2, "attachments/g1/original/a.pdf", deleted_hours_ago: nil)] })
cases << run("two deleted product files sharing a url", seed: { product_files: [product_file_row(1, "attachments/g1/original/a.pdf"), product_file_row(2, "attachments/g1/original/a.pdf")] }, responses: [DELETE_OK, DELETE_OK])
cases << run("a deleted product file owned by a live build", seed: { product_files: [product_file_row(1, "builds/1/1/build.zip")], links: [link_row(1)], product_builds: [build_row(1, 1, "builds/1/1/build.zip")] })
cases << run("a deleted product file owned by a build of a deleted product", seed: { product_files: [product_file_row(1, "builds/1/1/build.zip")], links: [link_row(1, deleted_at: "2026-02-01 00:00:00")], product_builds: [build_row(1, 1, "builds/1/1/build.zip")] }, responses: [DELETE_OK])
cases << run("a deleted product file under builds with no build", seed: { product_files: [product_file_row(1, "builds/1/1/build.zip")] }, responses: [DELETE_OK])
cases << run("a deleted product file under builds and a build of another key", seed: { product_files: [product_file_row(1, "builds/1/1/build.zip")], links: [link_row(1)], product_builds: [build_row(1, 1, "builds/1/2/build.zip")] }, responses: [DELETE_OK])
cases << run("a deleted subtitle file", seed: { subtitle_files: [simple_row(1, "attachments/g1/original/s.srt")] }, responses: [DELETE_OK])
cases << run("a deleted subtitle file with a live duplicate", seed: { subtitle_files: [simple_row(1, "attachments/g1/original/s.srt"), simple_row(2, "attachments/g1/original/s.srt", deleted_hours_ago: nil)] })
cases << run("a deleted stamped pdf", seed: { stamped_pdfs: [simple_row(1, "attachments/g1/original/stamped.pdf", url_redirect_id: 1)] }, responses: [DELETE_OK])
cases << run("two deleted stamped pdfs with one url", seed: { stamped_pdfs: [simple_row(1, "attachments/g1/original/stamped.pdf", url_redirect_id: 1), simple_row(2, "attachments/g1/original/stamped.pdf", url_redirect_id: 2)] }, responses: [DELETE_OK, DELETE_OK])
cases << run("a deleted product files archive", seed: { product_files_archives: [archive_row(1, "attachments/g1/archive.zip")] }, responses: [DELETE_OK])
cases << run("a deleted product files archive with a live duplicate url", seed: { product_files_archives: [archive_row(1, "attachments/g1/archive.zip"), archive_row(2, "attachments/g1/archive.zip", deleted_hours_ago: nil)] }, responses: [DELETE_OK])
cases << run("a deleted transcoded video with a plain key", seed: { transcoded_videos: [video_row(1, "transcoded/abc/video.mp4")] })
cases << run("a deleted hls video", seed: { transcoded_videos: [video_row(1, HLS_DIR, flags: 1)] }, responses: [{ status: 200, body: list_xml(["#{HLS_DIR}index.m3u8", "#{HLS_DIR}seg0.ts", "#{HLS_DIR}1080p/index.m3u8", "#{HLS_DIR}1080p/seg0.ts", "#{HLS_DIR}seg1.ts"]), headers: { "content-type" => "application/xml" } }, DELETE_OK])
cases << run("a deleted hls video keyed on its playlist", seed: { transcoded_videos: [video_row(1, "#{HLS_DIR}index.m3u8", flags: 1)] }, responses: [{ status: 200, body: list_xml(["#{HLS_DIR}index.m3u8", "#{HLS_DIR}seg0.ts"]), headers: { "content-type" => "application/xml" } }, DELETE_OK])
cases << run("a deleted hls video with nothing in the bucket", seed: { transcoded_videos: [video_row(1, HLS_DIR, flags: 1)] }, responses: [{ status: 200, body: list_xml([]), headers: { "content-type" => "application/xml" } }])
cases << run("a deleted hls video with only sub directories", seed: { transcoded_videos: [video_row(1, HLS_DIR, flags: 1)] }, responses: [{ status: 200, body: list_xml(["#{HLS_DIR}1080p/seg0.ts"]), headers: { "content-type" => "application/xml" } }])
cases << run("a deleted transcoded video whose key is not an hls directory", seed: { transcoded_videos: [video_row(1, "transcoded/abc/hls", flags: 1)] })
cases << run("a deleted transcoded video with a blank key", seed: { transcoded_videos: [video_row(1, "")] })
cases << run("a deleted hls video with a live duplicate", seed: { transcoded_videos: [video_row(1, HLS_DIR, flags: 1), video_row(2, HLS_DIR, flags: 1, deleted_hours_ago: nil)] })
cases << run("a deleted hls video with more than a thousand keys", seed: { transcoded_videos: [video_row(1, HLS_DIR, flags: 1)] }, responses: [{ status: 200, body: list_xml((0..1_000).map { "#{HLS_DIR}seg#{_1}.ts" }), headers: { "content-type" => "application/xml" } }, DELETE_OK, DELETE_OK])
cases << run("a deleted hls video listed over two pages", seed: { transcoded_videos: [video_row(1, HLS_DIR, flags: 1)] }, responses: [{ status: 200, body: list_xml(["#{HLS_DIR}seg0.ts"], truncated: true).sub("</ListBucketResult>", "<NextContinuationToken>TOKEN1</NextContinuationToken></ListBucketResult>"), headers: { "content-type" => "application/xml" } }, { status: 200, body: list_xml(["#{HLS_DIR}seg1.ts"]), headers: { "content-type" => "application/xml" } }, DELETE_OK])
cases << run("a deleted transcoded video with a NULL key", seed: { transcoded_videos: [video_row(1, nil, flags: 1)] })
cases << run("a deleted product file with a quote and a backslash in its key", seed: { product_files: [product_file_row(1, "attachments/g1/original/it's a\\b.pdf")] }, responses: [DELETE_OK])
cases << run("a deleted product file with a key ending in a slash", seed: { product_files: [product_file_row(1, "attachments/g1/original/folder/")] }, responses: [DELETE_OK])
cases << run("a deleted product file whose url differs from the base in case", seed: { product_files: [product_file_row(1, "x", url: "HTTP://LOCALHOST:9010/GUMROAD-SPECS/attachments/g1/original/a.pdf")] })
cases << run("a deleted product file with an empty segment in its key", seed: { product_files: [product_file_row(1, "attachments//g1/original/a.pdf")] }, responses: [DELETE_OK])
cases << run("one file of each kind", seed: { product_files: [product_file_row(1, "attachments/g1/original/a.pdf")], subtitle_files: [simple_row(1, "attachments/g1/original/s.srt")], stamped_pdfs: [simple_row(1, "attachments/g1/original/p.pdf", url_redirect_id: 1)], product_files_archives: [archive_row(1, "attachments/g1/archive.zip")], transcoded_videos: [video_row(1, "transcoded/abc/video.mp4")] }, responses: [DELETE_OK, DELETE_OK, DELETE_OK, DELETE_OK])
cases << run("S3 refuses to delete a product file", seed: { product_files: [product_file_row(1, "attachments/g1/original/a.pdf"), product_file_row(2, "attachments/g2/original/b.pdf")] }, responses: [DENIED, DELETE_OK])
cases << run("S3 refuses to delete an hls listing", seed: { transcoded_videos: [video_row(1, HLS_DIR, flags: 1)], product_files: [product_file_row(1, "attachments/g1/original/a.pdf")] }, responses: [DENIED, DELETE_OK])
cases << run("S3 refuses to delete a thousand and one keys", seed: { transcoded_videos: [video_row(1, HLS_DIR, flags: 1)] }, responses: [{ status: 200, body: list_xml((0..1_000).map { "#{HLS_DIR}seg#{_1}.ts" }), headers: { "content-type" => "application/xml" } }, DELETE_OK, DENIED])
cases << run("more than a thousand product files", seed: { product_files: (1..1_001).map { product_file_row(_1, "attachments/g#{_1}/original/a.pdf") } }, responses: Array.new(1_001) { DELETE_OK })

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "base_url" => BASE, "bucket" => S3_BUCKET, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
