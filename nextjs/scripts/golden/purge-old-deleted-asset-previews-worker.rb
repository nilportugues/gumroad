# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/purge-old-deleted-asset-previews-worker.golden.json: PurgeOldDeletedAssetPreviewsWorker run
# by the real app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). Run it like
# delete-product-files-archives-worker.rb:
#
#   bundle exec rails runner nextjs/scripts/golden/purge-old-deleted-asset-previews-worker.rb   (env as in publish-scheduled-post.rb)
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/purge-old-deleted-asset-previews-worker.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[links users asset_previews active_storage_attachments active_storage_blobs active_storage_variant_records product_cached_values versions].freeze

Rails.logger = ActiveSupport::Logger.new(nil)
ActiveJob::Base.queue_adapter = :sidekiq
ActiveJob::Base.logger = Logger.new(nil)

# The scratch schema keeps Active Storage's foreign keys, which TRUNCATE refuses; production has none.
ActiveRecord::Base.connection.execute("SELECT table_name, constraint_name FROM information_schema.table_constraints WHERE constraint_type = 'FOREIGN KEY' AND table_schema = DATABASE()").to_a.each do |table, constraint|
  ActiveRecord::Base.connection.execute("ALTER TABLE `#{table}` DROP FOREIGN KEY `#{constraint}`")
end

# ActiveJob's job_id, which is a random UUID.
$uuid_seq = 0
SecureRandom.singleton_class.prepend(Module.new do
  def uuid = format("00000000-0000-4000-8000-%012x", ($uuid_seq += 1))
end)

def link_row(id, **overrides)
  { id:, name: "Product #{id}", user_id: 1, unique_permalink: "p#{id}", price_currency_type: "usd", flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def preview_row(id, link_id, deleted_at: "2026-09-01 00:00:00", **overrides)
  { id:, link_id:, guid: "guid#{id}", position: id, deleted_at:, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def blob_row(id, **overrides)
  { id:, key: "key#{id}", filename: "cover#{id}.png", content_type: "image/png", metadata: "{}", byte_size: 1000, checksum: "sum#{id}", service_name: "test", created_at: SEEDED_AT }.merge(overrides)
end

def attachment_row(id, preview_id, blob_id) = { id:, name: "file", record_type: "AssetPreview", record_id: preview_id, blob_id:, created_at: SEEDED_AT }

def cached_value_row(id, product_id, **overrides) = { id:, product_id:, expired: false, successful_sales_count: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)

def run(name, args, seed: {})
  $uuid_seq = 0
  result = capture(name, now: NOW, tables: TABLES, seed:, sidekiq: true, job: "PurgeOldDeletedAssetPreviewsWorker", args:) do
    PurgeOldDeletedAssetPreviewsWorker.new.perform(*args)
  end
  result.delete("rows")
  result.delete("seed")
  result
end

cases = []
cases << run("no previews", [])
cases << run("an argument", [{ "to" => "2026-01-01" }])
cases << run("a preview deleted two months ago", [], seed: { links: [link_row(1)], asset_previews: [preview_row(1, 1)] })
cases << run("a preview deleted ten days ago", [], seed: { links: [link_row(1)], asset_previews: [preview_row(1, 1, deleted_at: "2026-10-25 00:00:00")] })
cases << run("a preview that is not deleted", [], seed: { links: [link_row(1)], asset_previews: [preview_row(1, 1, deleted_at: nil)] })
cases << run("a preview deleted a second before the cutoff", [], seed: { links: [link_row(1)], asset_previews: [preview_row(1, 1, deleted_at: "2026-10-04 12:30:44")] })
cases << run("a preview deleted at the second of the cutoff", [], seed: { links: [link_row(1)], asset_previews: [preview_row(1, 1, deleted_at: "2026-10-04 12:30:45")] })
cases << run("a preview deleted a second after the cutoff", [], seed: { links: [link_row(1)], asset_previews: [preview_row(1, 1, deleted_at: "2026-10-04 12:30:46")] })
cases << run("a preview whose product does not exist", [], seed: { asset_previews: [preview_row(1, 99)] })
cases << run("a preview without a product", [], seed: { asset_previews: [preview_row(1, nil)] })
cases << run("a preview of a deleted product", [], seed: { links: [link_row(1, deleted_at: "2026-10-01 00:00:00")], asset_previews: [preview_row(1, 1)] })
cases << run("a preview with an embed and an unsplash url", [], seed: { links: [link_row(1)], asset_previews: [preview_row(1, 1, oembed: "---\nhtml: <iframe></iframe>\nwidth: 560\nheight: 315\n", unsplash_url: "https://images.unsplash.com/photo")] })
cases << run("a product with cached values", [], seed: { links: [link_row(1)], asset_previews: [preview_row(1, 1)], product_cached_values: [cached_value_row(1, 1), cached_value_row(2, 1, expired: true), cached_value_row(3, 1)] })
cases << run("a preview with an attached file", [], seed: { links: [link_row(1)], asset_previews: [preview_row(1, 1)], active_storage_blobs: [blob_row(1)], active_storage_attachments: [attachment_row(1, 1, 1)] })
cases << run("an attachment whose blob is missing", [], seed: { links: [link_row(1)], asset_previews: [preview_row(1, 1)], active_storage_attachments: [attachment_row(1, 1, 7)] })
cases << run("an attachment under another name", [], seed: { links: [link_row(1)], asset_previews: [preview_row(1, 1)], active_storage_blobs: [blob_row(1)], active_storage_attachments: [attachment_row(1, 1, 1).merge(name: "poster")] })
cases << run("an attachment of another record", [], seed: { links: [link_row(1)], asset_previews: [preview_row(1, 1)], active_storage_blobs: [blob_row(1)], active_storage_attachments: [attachment_row(1, 2, 1)] })
cases << run("a preview with a file and no product", [], seed: { asset_previews: [preview_row(1, nil)], active_storage_blobs: [blob_row(1)], active_storage_attachments: [attachment_row(1, 1, 1)] })
cases << run("a preview with a file whose product has cached values", [], seed: { links: [link_row(1)], asset_previews: [preview_row(1, 1)], active_storage_blobs: [blob_row(1)], active_storage_attachments: [attachment_row(1, 1, 1)], product_cached_values: [cached_value_row(1, 1)] })
cases << run("two previews of one product", [], seed: { links: [link_row(1)], asset_previews: [preview_row(1, 1), preview_row(2, 1)] })
cases << run("two previews of two products, one with a file", [], seed: { links: [link_row(1), link_row(2)], asset_previews: [preview_row(1, 1), preview_row(2, 2)], active_storage_blobs: [blob_row(2)], active_storage_attachments: [attachment_row(1, 2, 2)] })
cases << run("two previews sharing a blob", [], seed: { links: [link_row(1)], asset_previews: [preview_row(1, 1), preview_row(2, 1)], active_storage_blobs: [blob_row(1)], active_storage_attachments: [attachment_row(1, 1, 1), attachment_row(2, 2, 1)] })
cases << run("a preview with a blob that has variant records", [], seed: { links: [link_row(1)], asset_previews: [preview_row(1, 1)], active_storage_blobs: [blob_row(1)], active_storage_attachments: [attachment_row(1, 1, 1)], active_storage_variant_records: [{ id: 1, blob_id: 1, variation_digest: "abc" }] })
cases << run("101 previews take two batches", [], seed: { links: [link_row(1)], asset_previews: (1..101).map { preview_row(_1, 1) } })

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
