# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/delete-product-files-worker.golden.json: DeleteProductFilesWorker run by the real app
# against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). The sales search goes to a local socket that answers
# the case's `es_bodies` (support/rails_cases.rb) and is recorded under `es`; a product with a file to delete runs the real
# ProductFile#delete! (validations, callbacks, PaperTrail, HLS renditions, subtitle files). Run it like
# sync-watched-users-job.rb (env as in publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases
capture_elasticsearch!

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/delete-product-files-worker.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[links product_files versions transcoded_videos subtitle_files active_storage_blobs active_storage_attachments taxonomies taxonomy_hierarchies product_cached_values installments].freeze
S3 = S3_BASE_URL

Rails.logger = ActiveSupport::Logger.new(nil)
# The attachments table references the blobs table, which TRUNCATE refuses; the seeds insert both.
ActiveRecord::Base.connection.execute("SET FOREIGN_KEY_CHECKS=0")

def link_row(id, **overrides) = { id:, user_id: 1, name: "Product #{id}", unique_permalink: "p#{id}", deleted_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
def file_row(id, link: 1, **overrides) = { id:, link_id: link, url: "https://files.example.com/#{id}.pdf", filetype: "pdf", flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
def sales(total, relation = "eq") = { "hits" => { "total" => { "value" => total, "relation" => relation }, "hits" => [] } }

def run(name, seed, args = [1], es_bodies: [])
  result = capture(name, now: NOW, tables: TABLES, seed:, sidekiq: true, job: "DeleteProductFilesWorker", args:, es_bodies:) do
    DeleteProductFilesWorker.new.perform(*args)
  end
  result.delete("seed")
  result
end

cases = []
cases << run("a product that does not exist", {}, [99])
cases << run("a product id of nil", { links: [link_row(1)] }, [nil])
cases << run("a product whose deletion was undone", { links: [link_row(1, deleted_at: nil)], product_files: [file_row(1)] })
cases << run("a deleted product with sales", { links: [link_row(1)], product_files: [file_row(1)] }, es_bodies: [sales(3)])
cases << run("a deleted product with sales beyond the tracked total", { links: [link_row(1)], product_files: [file_row(1)] }, es_bodies: [sales(10_000, "gte")])
cases << run("a deleted product with no sales and no files", { links: [link_row(1)] }, es_bodies: [sales(0)])
cases << run("a deleted product with no sales and a file", { links: [link_row(1)], product_files: [file_row(1)] }, es_bodies: [sales(0)])
cases << run("a deleted product with no sales and two files", { links: [link_row(1)], product_files: [file_row(2), file_row(1)] }, es_bodies: [sales(0)])
cases << run("a deleted product with no sales and an already deleted file", { links: [link_row(1)], product_files: [file_row(1, deleted_at: SEEDED_AT)] }, es_bodies: [sales(0)])
cases << run("files of another product", { links: [link_row(1), link_row(2)], product_files: [file_row(1, link: 2)] }, es_bodies: [sales(0)])
cases << run("the second product", { links: [link_row(1), link_row(2)], product_files: [file_row(1, link: 1)] }, [2], es_bodies: [sales(0)])
cases << run("a product id given as a digit string", { links: [link_row(1)] }, ["1"], es_bodies: [sales(0)])
cases << run("a product id given as a float", { links: [link_row(1)] }, [1.0], es_bodies: [sales(0)])
cases << run("a product id given as a word", { links: [link_row(1)] }, ["abc"], es_bodies: [sales(0)])
cases << run("a search answer without a total", { links: [link_row(1)] }, es_bodies: [{ "hits" => { "hits" => [] } }])
cases << run("a search answer with a bare total", { links: [link_row(1)] }, es_bodies: [{ "hits" => { "total" => 5, "hits" => [] } }])
cases << run("a search answer with a null total value", { links: [link_row(1)] }, es_bodies: [{ "hits" => { "total" => { "value" => nil }, "hits" => [] } }])
cases << run("a search answer with a fractional total", { links: [link_row(1)] }, es_bodies: [{ "hits" => { "total" => { "value" => 0.5 }, "hits" => [] } }])
[["a string", "3"], ["true", true], ["false", false], ["an array", [1]], ["an object", { "a" => 1 }]].each do |label, value|
  cases << run("a search answer with #{label} as the total value", { links: [link_row(1)] }, es_bodies: [{ "hits" => { "total" => { "value" => value }, "hits" => [] } }])
end
cases << run("a search answer that is empty", { links: [link_row(1)] }, es_bodies: [{}])


def thumb_rows(file_id, content_type: "image/png", byte_size: 1024)
  { active_storage_blobs: [{ id: 1, key: "k#{file_id}", filename: "t.png", content_type:, metadata: "{}", byte_size:, checksum: "c", created_at: SEEDED_AT, service_name: "test" }],
    active_storage_attachments: [{ id: 1, name: "thumbnail", record_type: "ProductFile", record_id: file_id, blob_id: 1, created_at: SEEDED_AT }] }
end

def video_row(id, file: 1, key: "hls/#{id}/index.m3u8", state: "completed", flags: 1, **overrides)
  { id:, link_id: 1, original_video_key: "orig/#{id}.mp4", transcoded_video_key: key, state:, created_at: SEEDED_AT, updated_at: SEEDED_AT, flags:, streamable_type: "ProductFile", streamable_id: file, last_accessed_at: SEEDED_AT }.merge(overrides)
end

def subtitle_row(id, file: 1, **overrides) = { id:, url: "https://files.example.com/#{id}.srt", language: "English", created_at: SEEDED_AT, updated_at: SEEDED_AT, product_file_id: file, size: 10 }.merge(overrides)
def cached_value_row(id, **overrides) = { id:, product_id: 1, expired: false, successful_sales_count: 1, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
def deleting(name, seed, args = [1]) = run(name, seed, args, es_bodies: [sales(0)])
HLS = 1
TAXONOMY_ROWS = ->(leaf) { { taxonomies: [{ id: 1, slug: "design" }, { id: 2, slug: leaf, parent_id: 1 }], taxonomy_hierarchies: [{ ancestor_id: 1, descendant_id: 1, generations: 0 }, { ancestor_id: 2, descendant_id: 2, generations: 0 }, { ancestor_id: 1, descendant_id: 2, generations: 1 }] } }
S3_PDF = "#{S3}attachments/abc/original/a.pdf"

# The delete path of ProductFile#delete!: validations, callbacks, PaperTrail, HLS renditions and subtitle files.
cases << deleting("a file whose url is an S3 key with an extension", { links: [link_row(1)], product_files: [file_row(1, url: S3_PDF, filegroup: nil)] })
cases << deleting("a file whose S3 extension changes its type", { links: [link_row(1)], product_files: [file_row(1, url: "#{S3}attachments/abc/original/a.MP4", filetype: "pdf", filegroup: "document")] })
cases << deleting("a file whose type becomes pdf with stamping on", { links: [link_row(1)], product_files: [file_row(1, url: S3_PDF, filetype: "zip", flags: 16)] })
cases << deleting("a file with an unrecognised S3 extension", { links: [link_row(1)], product_files: [file_row(1, url: "#{S3}attachments/abc/original/a.qqq", filetype: "pdf")] })
cases << deleting("an external link file", { links: [link_row(1)], product_files: [file_row(1, url: "https://example.com/page", filetype: "link", filegroup: nil)] })
cases << deleting("a file with a blank url", { links: [link_row(1)], product_files: [file_row(1, url: "")] })
cases << deleting("a file with a nil url", { links: [link_row(1)], product_files: [file_row(1, url: nil)] })
cases << deleting("a file with a nil filetype", { links: [link_row(1)], product_files: [file_row(1, filetype: nil)] })
cases << deleting("a file with an uppercase filetype", { links: [link_row(1)], product_files: [file_row(1, filetype: "PDF")] })
cases << deleting("a file with a valid ISBN-10", { links: [link_row(1)], product_files: [file_row(1, isbn: "0-306-40615-2")] })
cases << deleting("a file with a valid ISBN-10 ending in X", { links: [link_row(1)], product_files: [file_row(1, isbn: "080442957X")] })
cases << deleting("a file with a valid ISBN-13", { links: [link_row(1)], product_files: [file_row(1, isbn: "978-0-306-40615-7")] })
cases << deleting("a file with a lowercase spaced ISBN", { links: [link_row(1)], product_files: [file_row(1, isbn: " 080442957x ")] })
cases << deleting("a file with an invalid ISBN checksum", { links: [link_row(1)], product_files: [file_row(1, isbn: "0-306-40615-3")] })
cases << deleting("a file with a short ISBN", { links: [link_row(1)], product_files: [file_row(1, isbn: "123")] })
cases << deleting("a file with a non-numeric ISBN-13", { links: [link_row(1)], product_files: [file_row(1, isbn: "97803064061AB")] })
cases << deleting("a file with a blank ISBN", { links: [link_row(1)], product_files: [file_row(1, isbn: "")] })
cases << deleting("a file with an ISBN on a type that takes none", { links: [link_row(1)], product_files: [file_row(1, filetype: "zip", isbn: "0-306-40615-2")] })
cases << deleting("an epub with a valid ISBN", { links: [link_row(1)], product_files: [file_row(1, filetype: "epub", isbn: "9780306406157")] })
cases << deleting("a file that belongs to an installment as well", { links: [link_row(1)], installments: [{ id: 5, link_id: 1, created_at: SEEDED_AT, updated_at: SEEDED_AT }], product_files: [file_row(1, installment_id: 5)] })
cases << deleting("a file with a missing installment", { links: [link_row(1)], product_files: [file_row(1, installment_id: 99)] })
cases << deleting("a file with a thumbnail", { links: [link_row(1)], product_files: [file_row(1)] }.merge(thumb_rows(1)))
cases << deleting("a file with a thumbnail that is not an image", { links: [link_row(1)], product_files: [file_row(1)] }.merge(thumb_rows(1, content_type: "text/plain")))
cases << deleting("a file with a thumbnail in an unsupported format", { links: [link_row(1)], product_files: [file_row(1)] }.merge(thumb_rows(1, content_type: "image/webp")))
cases << deleting("a file with a thumbnail past the size limit", { links: [link_row(1)], product_files: [file_row(1)] }.merge(thumb_rows(1, byte_size: 5 * 1024 * 1024 + 1)))
cases << deleting("a file with a thumbnail at the size limit", { links: [link_row(1)], product_files: [file_row(1)] }.merge(thumb_rows(1, byte_size: 5 * 1024 * 1024)))
cases << deleting("a file with a thumbnail without a content type", { links: [link_row(1)], product_files: [file_row(1)] }.merge(thumb_rows(1, content_type: nil)))
cases << deleting("a file with a thumbnail attachment whose blob is gone", { links: [link_row(1)], product_files: [file_row(1)], active_storage_attachments: thumb_rows(1)[:active_storage_attachments] })
cases << deleting("a file with a cached value to expire", { links: [link_row(1)], product_files: [file_row(1)], product_cached_values: [cached_value_row(1), cached_value_row(2, expired: true), cached_value_row(3)] })
cases << deleting("a file with two subtitle files and a deleted one", { links: [link_row(1)], product_files: [file_row(1)], subtitle_files: [subtitle_row(1), subtitle_row(2), subtitle_row(3, deleted_at: SEEDED_AT)] })
cases << deleting("a file with a subtitle file of another file", { links: [link_row(1)], product_files: [file_row(1), file_row(2)], subtitle_files: [subtitle_row(1, file: 2)] })
cases << deleting("a file with a subtitle file in an unsupported type", { links: [link_row(1)], product_files: [file_row(1)], subtitle_files: [subtitle_row(1, url: "https://files.example.com/a.txt")] })
cases << deleting("a file with a transcoded video and the HLS flag", { links: [link_row(1)], product_files: [file_row(1, flags: HLS)], transcoded_videos: [video_row(1)] })
cases << deleting("a file with a transcoded video and no HLS flag", { links: [link_row(1)], product_files: [file_row(1)], transcoded_videos: [video_row(1)] })
cases << deleting("a file with two transcoded videos and the HLS flag", { links: [link_row(1)], product_files: [file_row(1, flags: HLS)], transcoded_videos: [video_row(1), video_row(2, key: "hls/2/index.m3u8")] })
cases << deleting("a file with a transcoded video another file also uses", { links: [link_row(1)], product_files: [file_row(1, flags: HLS), file_row(2, flags: HLS)], transcoded_videos: [video_row(1), video_row(2, file: 2, key: "hls/1/index.m3u8")] })
cases << deleting("a file with a transcoded video whose key a deleted row shares", { links: [link_row(1)], product_files: [file_row(1, flags: HLS)], transcoded_videos: [video_row(1), video_row(2, file: 9, key: "hls/1/index.m3u8", deleted_at: SEEDED_AT)] })
cases << deleting("a file with a deleted and a processing transcoded video", { links: [link_row(1)], product_files: [file_row(1, flags: HLS)], transcoded_videos: [video_row(1, deleted_at: SEEDED_AT), video_row(2, state: "processing", key: "hls/2/index.m3u8")] })
cases << deleting("a file with a transcoded video in an unknown state", { links: [link_row(1)], product_files: [file_row(1, flags: HLS)], transcoded_videos: [video_row(1, state: "bogus")] })
cases << deleting("a file with a transcoded video missing its key", { links: [link_row(1)], product_files: [file_row(1, flags: HLS)], transcoded_videos: [video_row(1, key: nil)] })
cases << deleting("a file with a transcoded video without a last access time", { links: [link_row(1)], product_files: [file_row(1, flags: HLS)], transcoded_videos: [video_row(1, last_accessed_at: nil)] })
cases << deleting("a file with a transcoded video, a subtitle file and a cached value", { links: [link_row(1)], product_files: [file_row(1, flags: HLS)], transcoded_videos: [video_row(1)], subtitle_files: [subtitle_row(1)], product_cached_values: [cached_value_row(1)] })
cases << deleting("two files, the second invalid", { links: [link_row(1)], product_files: [file_row(1), file_row(2, url: "")] })
cases << deleting("two files with transcoded videos", { links: [link_row(1)], product_files: [file_row(1, flags: HLS), file_row(2, flags: HLS)], transcoded_videos: [video_row(1), video_row(2, file: 2, key: "hls/2/index.m3u8")], subtitle_files: [subtitle_row(1, file: 2)] })
cases << deleting("a file with the stamp flag on a pdf", { links: [link_row(1)], product_files: [file_row(1, flags: 16)] })
cases << deleting("a product with a taxonomy", { links: [link_row(1, taxonomy_id: 2)], product_files: [file_row(1)] }.merge(TAXONOMY_ROWS.("3d")))
cases << deleting("a product in the fonts taxonomy", { links: [link_row(1, taxonomy_id: 2)], product_files: [file_row(1, url: "#{S3}attachments/abc/original/a.otf", filetype: "otf")] }.merge(TAXONOMY_ROWS.("fonts")))
cases << deleting("a product with a missing taxonomy", { links: [link_row(1, taxonomy_id: 77)], product_files: [file_row(1)] })
cases << deleting("a product with inferred taxonomy values", { links: [link_row(1, json_data: { inferred_taxonomy_attribute_values: { "font_type" => "serif" } }.to_json)], product_files: [file_row(1)] })
cases << deleting("a product with empty inferred taxonomy values", { links: [link_row(1, json_data: { inferred_taxonomy_attribute_values: {} }.to_json)], product_files: [file_row(1)] })
cases << deleting("a product with other json data", { links: [link_row(1, json_data: { "x" => 1 }.to_json)], product_files: [file_row(1)] })
cases << deleting("a file in a folder", { links: [link_row(1)], product_files: [file_row(1, folder_id: 4)] })
cases << deleting("a file with a description and a display name", { links: [link_row(1)], product_files: [file_row(1, display_name: "Name", description: "Desc", position: 3, size: 100, pagelength: 5)] })

File.write(OUT, JSON.pretty_generate({ "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
