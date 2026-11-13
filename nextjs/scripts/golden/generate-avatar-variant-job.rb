# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/generate-avatar-variant-job.golden.json: GenerateAvatarVariantJob run by the real app
# against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). A user with an avatar attached is where Node hands back
# (`stored_avatar_variant` processes the image and writes the variant to storage); those cases are recorded up to that call, which a
# marker exception stands in for, so nothing leaves the machine. Run it like send-bundles-marketing-email-job.rb
# (USE_DB_WORKER_REPLICAS=true).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/generate-avatar-variant-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[users active_storage_attachments active_storage_blobs].freeze

Rails.logger = ActiveSupport::Logger.new(nil)
ActiveRecord::Base.connection.execute("SET FOREIGN_KEY_CHECKS=0") # the scratch tables are truncated whole

class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

User.prepend(Module.new do
  def stored_avatar_variant(*, **) = raise(HandBackMarker)
end)

def user_row(id, **overrides)
  { id:, email: "seller#{id}@example.com", username: "seller#{id}", external_id: (1000 + id).to_s, recommendation_type: "own_products", user_risk_state: "compliant", flags: 0,
    created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def blob_row(id) = { id:, key: "key#{id}", filename: "avatar#{id}.png", content_type: "image/png", metadata: "{}", service_name: "test", byte_size: 10, checksum: "abc", created_at: SEEDED_AT }

def attachment_row(id, record_id, blob_id, **overrides) = { id:, name: "avatar", record_type: "User", record_id:, blob_id:, created_at: SEEDED_AT }.merge(overrides)

def run(name, args: [1], users: [user_row(1)], attachments: [], blobs: [])
  hands_back = false
  result = capture(name, now: NOW, tables: TABLES, seed: { users:, active_storage_attachments: attachments, active_storage_blobs: blobs }, sidekiq: true, job: "GenerateAvatarVariantJob", args:) do
    GenerateAvatarVariantJob.new.perform(*args)
  rescue HandBackMarker
    hands_back = true
  end
  result.delete("rows")
  result.delete("seed")
  result.merge("hands_back" => hands_back)
end

AVATAR = { attachments: [attachment_row(1, 1, 1)], blobs: [blob_row(1)] }.freeze

cases = []
cases << run("a user that does not exist", args: [9])
cases << run("a user with no avatar")
cases << run("a user with an avatar attached", **AVATAR)
cases << run("a user id as a digit string", args: ["1"])
cases << run("a user id as a digit string with an avatar attached", args: ["1"], **AVATAR)
cases << run("a user id of nil", args: [nil])
cases << run("a user id as a float", args: [1.0])
cases << run("a user id as a word", args: ["one"])
cases << run("an avatar attached to another user", users: [user_row(1), user_row(2)], attachments: [attachment_row(1, 2, 1)], blobs: [blob_row(1)])
cases << run("another attachment of the user", attachments: [attachment_row(1, 1, 1, name: "banner")], blobs: [blob_row(1)])
cases << run("an attachment of another record type", attachments: [attachment_row(1, 1, 1, record_type: "Link")], blobs: [blob_row(1)])
cases << run("two users, only the second with an avatar", args: [2], users: [user_row(1), user_row(2)], attachments: [attachment_row(1, 2, 1)], blobs: [blob_row(1)])
cases << run("a deleted user", users: [user_row(1, deleted_at: SEEDED_AT)])
cases << run("a deleted user with an avatar attached", users: [user_row(1, deleted_at: SEEDED_AT)], **AVATAR)

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
