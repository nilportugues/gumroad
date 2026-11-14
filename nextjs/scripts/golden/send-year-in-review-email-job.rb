# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/send-year-in-review-email-job.golden.json: SendYearInReviewEmailJob run by the real app
# against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). `User.find`, `Date.new(year)` and
# `User#financial_annual_report_url_for` read only `users`, `active_storage_attachments` and `active_storage_blobs`: a seller with no
# annual report for the year ends the run there. A report for the year goes on to build the blob's URL (the storage service and the CDN
# map), the analytics and the mail, which Node hands back to Rails; those cases are recorded up to `ActiveStorage::Blob#url`, which a
# marker exception stands in for. A run is checked to hold nothing but SELECT, SET and SHOW statements. Run it like
# pdf-unstampable-notifier-job.rb (env as in publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/send-year-in-review-email-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[users active_storage_attachments active_storage_blobs].freeze

Rails.logger = ActiveSupport::Logger.new(nil)

class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

ActiveStorage::Blob.prepend(Module.new do
  def url(*, **) = raise(HandBackMarker)
end)

def user_row(id, **overrides)
  { id:, email: "seller#{id}@example.com", username: "seller#{id}", external_id: (1000 + id).to_s, recommendation_type: "own_products",
    user_risk_state: "compliant", flags: 0, confirmed_at: nil, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def blob_row(id, metadata, **overrides)
  { id:, key: "key#{id}", filename: "report#{id}.csv", content_type: "text/csv", metadata:, byte_size: 10, checksum: "sum#{id}", created_at: SEEDED_AT, service_name: "test" }.merge(overrides)
end

def attachment_row(id, record_id, blob_id, **overrides)
  { id:, name: "annual_reports", record_type: "User", record_id:, blob_id:, created_at: SEEDED_AT }.merge(overrides)
end

def year_blob(id, year) = blob_row(id, %({"year":#{year},"identified":true}))

BASE = { users: [user_row(1)], active_storage_attachments: [], active_storage_blobs: [] }.freeze

def run(name, args = [1, 2025], **seed)
  hands_back = false
  data = BASE.merge(seed)
  result = capture(name, now: NOW, tables: TABLES, seed: data, sidekiq: true, job: "SendYearInReviewEmailJob", args:) do
    SendYearInReviewEmailJob.new.perform(*args)
  rescue HandBackMarker
    hands_back = true
  end
  result.delete("rows")
  result.delete("seed")
  unless result["statements"].all? { |s| s["sql"].match?(/\A\s*(SELECT|SET|SHOW)\b/i) }
    raise "#{name}: a write ran before the marker"
  end
  result.merge("hands_back" => hands_back)
end

def report(year, user: 1, id: 1) = { active_storage_blobs: [year_blob(id, year)], active_storage_attachments: [attachment_row(id, user, id)] }

cases = []
cases << run("a seller that does not exist", [9, 2025])
cases << run("a seller with no annual reports")
cases << run("a seller with a report for the year", **report(2025))
cases << run("a seller with a report for another year", **report(2024))
cases << run("a seller with a report for the next year", **report(2026))
cases << run("a seller with reports for several years", active_storage_blobs: [year_blob(1, 2023), year_blob(2, 2025), year_blob(3, 2024)], active_storage_attachments: [attachment_row(1, 1, 1), attachment_row(2, 1, 2), attachment_row(3, 1, 3)])
cases << run("a seller with reports for several years but not this one", active_storage_blobs: [year_blob(1, 2023), year_blob(3, 2024)], active_storage_attachments: [attachment_row(1, 1, 1), attachment_row(3, 1, 3)])
cases << run("a seller whose report is another seller's", **report(2025, user: 2))
cases << run("a seller whose report is of another kind", active_storage_blobs: [year_blob(1, 2025)], active_storage_attachments: [attachment_row(1, 1, 1, name: "avatar")])
cases << run("a seller whose report is of another record type", active_storage_blobs: [year_blob(1, 2025)], active_storage_attachments: [attachment_row(1, 1, 1, record_type: "Link")])
cases << run("a seller whose report year is a String", active_storage_blobs: [blob_row(1, '{"year":"2025"}')], active_storage_attachments: [attachment_row(1, 1, 1)])
cases << run("a seller whose report has no metadata", active_storage_blobs: [blob_row(1, nil)], active_storage_attachments: [attachment_row(1, 1, 1)])
cases << run("a seller whose report has no year", active_storage_blobs: [blob_row(1, '{"identified":true}')], active_storage_attachments: [attachment_row(1, 1, 1)])
cases << run("a seller whose report has an empty metadata object", active_storage_blobs: [blob_row(1, "{}")], active_storage_attachments: [attachment_row(1, 1, 1)])
cases << run("a seller whose report year is a list holding the year", active_storage_blobs: [blob_row(1, '{"year":[2024,2025]}')], active_storage_attachments: [attachment_row(1, 1, 1)])
cases << run("a seller whose report year is a Float", active_storage_blobs: [blob_row(1, '{"year":2025.0}')], active_storage_attachments: [attachment_row(1, 1, 1)])
cases << run("a seller whose attachment has no blob", active_storage_blobs: [], active_storage_attachments: [attachment_row(1, 1, 5)])
cases << run("a seller among others", [2, 2025], users: [user_row(1), user_row(2), user_row(3)], **report(2025, user: 2))
cases << run("a seller with two reports for the year", active_storage_blobs: [year_blob(1, 2025), year_blob(2, 2025)], active_storage_attachments: [attachment_row(1, 1, 1), attachment_row(2, 1, 2)])
[1, 1999, 2014, 9999].each { |year| cases << run("a report for the year #{year}", [1, year], **report(year)) }
[1, 2014, 9999].each { |year| cases << run("no report for the year #{year}", [1, year]) }
cases << run("a seller id given as a String", ["1", 2025], **report(2025))
cases << run("a seller id given as a String with no report", ["1", 2025])
cases << run("a seller id of nil", [nil, 2025])
cases << run("a seller id as a Float", [1.0, 2025], **report(2025))
cases << run("a seller id as a word", ["one", 2025])
cases << run("a recipient", [1, 2025, "other@example.com"], **report(2025))
cases << run("a recipient with no report", [1, 2025, "other@example.com"])
[0, -1, 10_000, 2025.0, "2025", nil, true, [2025]].each { |year| cases << run("a year of #{year.inspect}", [1, year], **report(2025)) }
cases << run("no arguments", [])
cases << run("one argument", [1])
cases << run("four arguments", [1, 2025, nil, 4])

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
