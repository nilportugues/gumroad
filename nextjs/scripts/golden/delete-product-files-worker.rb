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
TABLES = %w[links product_files versions transcoded_videos subtitle_files active_storage_blobs active_storage_attachments taxonomies taxonomy_hierarchies taxonomy_attributes product_cached_values installments users prices].freeze
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

# The classifier commit callback (Discover::TaxonomyAttributeClassifier.classify!) writing the product: the seller exists, so Link#save
# validates. Fonts is the one classified taxonomy; any other taxonomy only clears values a prior classifier left.
def user_row(id = 1) = { id:, email: "user#{id}@example.com", username: "user#{id}", external_id: (1000 + id).to_s, recommendation_type: "own_products", user_risk_state: "compliant", flags: 0, confirmed_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT }
def attribute_rows(taxonomy: 2, only: nil)
  rows = [
    { id: 1, taxonomy_id: taxonomy, name: "format", label: "Format", value_type: "enum", values: %w[OTF TTF WOFF2].to_json, position: 0, active: 1, created_at: SEEDED_AT, updated_at: SEEDED_AT },
    { id: 2, taxonomy_id: taxonomy, name: "variable_font", label: "Variable font", value_type: "boolean", values: nil, position: 1, active: 1, created_at: SEEDED_AT, updated_at: SEEDED_AT },
    { id: 3, taxonomy_id: taxonomy, name: "weight", label: "Weight", value_type: "number", values: nil, position: 2, active: 1, created_at: SEEDED_AT, updated_at: SEEDED_AT },
    { id: 4, taxonomy_id: taxonomy, name: "retired", label: "Retired", value_type: "enum", values: %w[a].to_json, position: 3, active: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT },
  ]
  { taxonomy_attributes: only ? rows.select { only.include?(_1[:name]) } : rows }
end
def price_row(link) = { id: link, link_id: link, price_cents: 500, currency: "usd", created_at: SEEDED_AT, updated_at: SEEDED_AT }
def font_file(id, ext, **overrides) = file_row(id, url: "#{S3}attachments/abc/original/#{id}-font.#{ext}", filetype: ext, **overrides)
def classified(name, links:, files:, taxonomy: "fonts", attributes: attribute_rows, **seed)
  deleting(name, { users: [user_row], prices: links.map { price_row(_1[:id]) }, links: links.map { _1.merge(unique_permalink: "perm#{('a'.ord + _1[:id]).chr}") }, product_files: files }.merge(TAXONOMY_ROWS.(taxonomy)).merge(attributes).merge(seed))
end
FONTS = { taxonomy_id: 2 }
cases << classified("fonts: one otf file", links: [link_row(1, **FONTS)], files: [font_file(1, "otf")])
cases << classified("fonts: two files, the second a ttf", links: [link_row(1, **FONTS)], files: [font_file(1, "otf"), font_file(2, "ttf")])
cases << classified("fonts: three files of three types", links: [link_row(1, **FONTS)], files: [font_file(1, "otf"), font_file(2, "ttf"), font_file(3, "woff2")])
cases << classified("fonts: empty inferred values stored", links: [link_row(1, **FONTS, json_data: { inferred_taxonomy_attribute_values: {} }.to_json)], files: [font_file(1, "pdf")])
cases << classified("fonts: two files of the same type", links: [link_row(1, **FONTS)], files: [font_file(1, "otf"), font_file(2, "otf")])
cases << classified("fonts: a woff2 file and a variable name", links: [link_row(1, **FONTS)], files: [font_file(1, "woff2", display_name: "Family VF"), font_file(2, "woff2", display_name: "Family VF Italic")])
cases << classified("fonts: a variable-named file of another type", links: [link_row(1, **FONTS)], files: [font_file(1, "pdf", display_name: "Specimen"), font_file(2, "ttf", display_name: "Font-Variable")])
cases << classified("fonts: inferred values already stored", links: [link_row(1, **FONTS, json_data: { inferred_taxonomy_attribute_values: { "format" => "OTF" } }.to_json)], files: [font_file(1, "otf")])
cases << classified("fonts: stored inferred values the next pass keeps", links: [link_row(1, **FONTS, json_data: { inferred_taxonomy_attribute_values: { "format" => "TTF" } }.to_json)], files: [font_file(1, "otf"), font_file(2, "ttf")])
cases << classified("fonts: other json data kept", links: [link_row(1, **FONTS, json_data: { custom_receipt_text: "Thanks", taxonomy_attribute_values: { "format" => "OTF" } }.to_json)], files: [font_file(1, "otf"), font_file(2, "ttf")])
cases << classified("fonts: no attributes defined", links: [link_row(1, **FONTS)], files: [font_file(1, "otf"), font_file(2, "ttf")], attributes: { taxonomy_attributes: [] })
cases << classified("fonts: only the format attribute defined", links: [link_row(1, **FONTS)], files: [font_file(1, "otf"), font_file(2, "ttf")], attributes: attribute_rows(only: %w[format]))
cases << classified("fonts: a file already deleted", links: [link_row(1, **FONTS)], files: [font_file(1, "otf", deleted_at: SEEDED_AT), font_file(2, "ttf")])
cases << classified("fonts: an uppercase filetype", links: [link_row(1, **FONTS)], files: [file_row(1, url: "#{S3}attachments/abc/original/1.OTF", filetype: "OTF"), font_file(2, "ttf")])
cases << classified("a design taxonomy that has no classifier and stored values", links: [link_row(1, taxonomy_id: 2, json_data: { inferred_taxonomy_attribute_values: { "format" => "OTF" } }.to_json)], files: [file_row(1), file_row(2)], taxonomy: "3d")
cases << classified("a design taxonomy that has no classifier and none stored", links: [link_row(1, taxonomy_id: 2)], files: [file_row(1)], taxonomy: "3d")
cases << classified("a product with a missing taxonomy and stored values", links: [link_row(1, taxonomy_id: 77, json_data: { inferred_taxonomy_attribute_values: { "format" => "OTF" } }.to_json)], files: [file_row(1)], taxonomy: "fonts")
cases << classified("inferred values stored and no taxonomy", links: [link_row(1, json_data: { inferred_taxonomy_attribute_values: { "format" => "OTF" }, "x" => 1 }.to_json)], files: [file_row(1), file_row(2)])
cases << classified("the design root taxonomy", links: [link_row(1, taxonomy_id: 1)], files: [font_file(1, "otf")], taxonomy: "fonts")
cases << classified("fonts: seller values and a custom permalink", links: [link_row(1, **FONTS, custom_permalink: "mine", json_data: { taxonomy_attribute_values: { "format" => "WOFF2" } }.to_json)], files: [font_file(1, "otf"), font_file(2, "ttf")])

File.write(OUT, JSON.pretty_generate({ "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
