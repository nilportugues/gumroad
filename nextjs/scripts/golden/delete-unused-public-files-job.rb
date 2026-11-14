# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/delete-unused-public-files-job.golden.json: DeleteUnusedPublicFilesJob run
# by the real app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). Run it like
# purge-old-deleted-asset-previews-worker.rb:
#
#   bundle exec rails runner nextjs/scripts/golden/delete-unused-public-files-job.rb   (env as in publish-scheduled-post.rb)
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/delete-unused-public-files-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[links users public_files active_storage_attachments active_storage_blobs active_storage_variant_records versions].freeze

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

def file_row(id, scheduled: "2026-11-01 00:00:00", **overrides)
  { id:, seller_id: 1, resource_type: "Link", resource_id: 1, public_id: "abcdefghij#{format('%06d', id)}", display_name: "File #{id}", original_file_name: "file#{id}.png",
    file_type: "png", file_group: "image", scheduled_for_deletion_at: scheduled, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def link_row(id, **overrides)
  { id:, name: "Product #{id}", user_id: 1, unique_permalink: "p#{id}", price_currency_type: "usd", flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def user_row(id) = { id:, email: "user#{id}@example.com", username: "user#{id}", external_id: (1000 + id).to_s, user_risk_state: "compliant", flags: 0, confirmed_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT }

def blob_row(id, **overrides)
  { id:, key: "key#{id}", filename: "file#{id}.png", content_type: "image/png", metadata: "{}", byte_size: 1000, checksum: "sum#{id}", service_name: "test", created_at: SEEDED_AT }.merge(overrides)
end

def attachment_row(id, record_id, blob_id, record_type: "PublicFile") = { id:, name: "file", record_type:, record_id:, blob_id:, created_at: SEEDED_AT }

def run(name, args, seed: {})
  $uuid_seq = 0
  seed = { links: [link_row(1)] }.merge(seed)
  result = capture(name, now: NOW, tables: TABLES, seed:, sidekiq: true, job: "DeleteUnusedPublicFilesJob", args:) do
    DeleteUnusedPublicFilesJob.new.perform(*args)
  end
  result.delete("rows")
  result.delete("seed")
  result
end

DELETED = { deleted_at: "2026-10-01 00:00:00" }.freeze

cases = []
cases << run("no public files", [])
cases << run("an argument", [1])
cases << run("a file scheduled for deletion with no attachment", [], seed: { public_files: [file_row(1)] })
cases << run("a file whose product does not exist", [], seed: { links: [], public_files: [file_row(1)] })
cases << run("a file of a deleted product", [], seed: { links: [link_row(1, **DELETED)], public_files: [file_row(1)] })
cases << run("a file that belongs to a user", [], seed: { users: [user_row(1)], public_files: [file_row(1, resource_type: "User")] })
cases << run("a file of a user that does not exist", [], seed: { public_files: [file_row(1, resource_type: "User")] })
cases << run("hands a file of a resource type Node has no model for", [], seed: { public_files: [file_row(1, resource_type: "Nothing")] })
cases << run("a file scheduled in the future", [], seed: { public_files: [file_row(1, scheduled: "2026-12-01 00:00:00")] })
cases << run("a file never scheduled", [], seed: { public_files: [file_row(1, scheduled: nil)] })
cases << run("a file already deleted", [], seed: { public_files: [file_row(1, **DELETED)] })
cases << run("a file scheduled a second before now", [], seed: { public_files: [file_row(1, scheduled: "2026-11-04 12:30:44")] })
cases << run("a file scheduled at the second of now", [], seed: { public_files: [file_row(1, scheduled: "2026-11-04 12:30:45")] })
cases << run("a file with an attached blob", [], seed: { public_files: [file_row(1)], active_storage_blobs: [blob_row(1)], active_storage_attachments: [attachment_row(1, 1, 1)] })
cases << run("a file whose blob is missing", [], seed: { public_files: [file_row(1)], active_storage_attachments: [attachment_row(1, 1, 7)] })
cases << run("an attachment under another name", [], seed: { public_files: [file_row(1)], active_storage_blobs: [blob_row(1)], active_storage_attachments: [attachment_row(1, 1, 1).merge(name: "poster")] })
cases << run("an attachment of another record type", [], seed: { public_files: [file_row(1)], active_storage_blobs: [blob_row(1)], active_storage_attachments: [attachment_row(1, 1, 1, record_type: "AssetPreview")] })
cases << run("a blob shared with a record of another type", [], seed: { public_files: [file_row(1)], active_storage_blobs: [blob_row(1)], active_storage_attachments: [attachment_row(1, 1, 1), attachment_row(2, 1, 1, record_type: "AssetPreview")] })
cases << run("a blob shared with another public file", [], seed: { public_files: [file_row(1), file_row(2, scheduled: nil)], active_storage_blobs: [blob_row(1)], active_storage_attachments: [attachment_row(1, 1, 1), attachment_row(2, 2, 1)] })
cases << run("a blob shared with another attachment of the same file", [], seed: { public_files: [file_row(1)], active_storage_blobs: [blob_row(1)], active_storage_attachments: [attachment_row(1, 1, 1), attachment_row(2, 1, 1).merge(name: "poster")] })
cases << run("a blob with variant records", [], seed: { public_files: [file_row(1)], active_storage_blobs: [blob_row(1)], active_storage_attachments: [attachment_row(1, 1, 1)], active_storage_variant_records: [{ id: 1, blob_id: 1, variation_digest: "abc" }] })
cases << run("three files, two attached to one blob", [], seed: { public_files: [file_row(1), file_row(2), file_row(3)], active_storage_blobs: [blob_row(1), blob_row(2)], active_storage_attachments: [attachment_row(1, 1, 1), attachment_row(2, 2, 1), attachment_row(3, 3, 2)] })
cases << run("a file without a display name", [], seed: { public_files: [file_row(1, display_name: "")] })
cases << run("a file with a public id of the wrong shape", [], seed: { public_files: [file_row(1, public_id: "Short")] })
cases << run("a file with a blank original file name", [], seed: { public_files: [file_row(1, original_file_name: "")] })
cases << run("a file without a seller", [], seed: { public_files: [file_row(1, seller_id: nil)] })
cases << run("hands a file without a file type or group", [], seed: { public_files: [file_row(1, file_type: nil, file_group: nil)] })
cases << run("hands a file without a public id", [], seed: { public_files: [file_row(1, public_id: "")] })
cases << run("hands a blank display name with an attached file", [], seed: { public_files: [file_row(1, display_name: "")], active_storage_blobs: [blob_row(1)], active_storage_attachments: [attachment_row(1, 1, 1)] })
cases << run("hands a file with a file type and no group", [], seed: { public_files: [file_row(1, file_group: nil)] })
cases << run("hands the second file of a batch with no public id", [], seed: { public_files: [file_row(1), file_row(2, public_id: "")] })
cases << run("blobs attached in descending order", [], seed: { public_files: [file_row(1), file_row(2)], active_storage_blobs: [blob_row(1), blob_row(2)], active_storage_attachments: [attachment_row(1, 1, 2), attachment_row(2, 2, 1)] })
cases << run("one blob that exists and one that is missing", [], seed: { public_files: [file_row(1), file_row(2)], active_storage_blobs: [blob_row(1)], active_storage_attachments: [attachment_row(1, 1, 7), attachment_row(2, 2, 1)] })
cases << run("a file with two file attachments", [], seed: { public_files: [file_row(1)], active_storage_blobs: [blob_row(1), blob_row(2)], active_storage_attachments: [attachment_row(1, 1, 1), attachment_row(2, 1, 2)] })
cases << run("a file with an empty-string display name and no attachment", [], seed: { public_files: [file_row(1, display_name: "  ")] })
cases << run("a failing file stops the batch", [], seed: { public_files: [file_row(1), file_row(2, display_name: ""), file_row(3)] })

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
