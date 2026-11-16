# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/retry-stripe-jp-address-resyncs-job.golden.json: RetryStripeJpAddressResyncsJob run by
# the real app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). The per-seller jobs it pushes carry a
# unique-jobs lock, so a case's Redis snapshot holds the locks; ReplicaLagWatcher.watch calls are counted under `replica_watches`.
# Run it like update-sales-related-products-infos-job.rb (env as in publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/retry-stripe-jp-address-resyncs-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[user_compliance_info_requests].freeze
KANJI = "individual.address_kanji.line1"
KANA = "individual.address_kana.city"

Rails.logger = ActiveSupport::Logger.new(nil)

$replica_watches = 0
ReplicaLagWatcher.singleton_class.prepend(Module.new do
  def watch(*)
    $replica_watches += 1
  end
end)

def request_row(id, user_id, field = KANJI, json: nil, state: "requested", **overrides)
  { id:, user_id:, field_needed: field, state:, json_data: json && JSON.generate(json), flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def iso(time) = time.utc.iso8601

def run(name, rows)
  $replica_watches = 0
  result = capture(name, now: NOW, tables: TABLES, seed: { user_compliance_info_requests: rows }, sidekiq: true, job: "RetryStripeJpAddressResyncsJob", args: []) do
    RetryStripeJpAddressResyncsJob.new.perform
  end
  result.delete("seed")
  result.delete("rows")
  result["replica_watches"] = $replica_watches
  result
end

DAY = 86_400
cases = []
cases << run("no requests", [])
cases << run("a request never retried", [request_row(1, 10)])
cases << run("a kana request", [request_row(1, 10, KANA)])
cases << run("a request for another field", [request_row(1, 10, "individual.first_name"), request_row(2, 11, "individual.address.line1"), request_row(3, 12, "company.address_kanji.line1")])
cases << run("a provided request", [request_row(1, 10, state: "provided")])
cases << run("a request with no user", [request_row(1, nil)])
cases << run("two requests of one user", [request_row(1, 10), request_row(2, 10, KANA)])
cases << run("requests of three users", [request_row(1, 10), request_row(2, 11), request_row(3, 12)])
cases << run("one due request and one not due for a user", [request_row(1, 10, json: { address_resync_count: 8 }), request_row(2, 10)])
cases << run("a request retried 7 days ago", [request_row(1, 10, json: { address_resync_count: 1, address_resync_at: iso(NOW - 7 * DAY) })])
cases << run("a request retried just under 7 days ago", [request_row(1, 10, json: { address_resync_count: 1, address_resync_at: iso(NOW - 7 * DAY + 1) })])
cases << run("a request retried 8 days ago", [request_row(1, 10, json: { address_resync_count: 1, address_resync_at: iso(NOW - 8 * DAY) })])
cases << run("a request retried a day ago", [request_row(1, 10, json: { address_resync_count: 1, address_resync_at: iso(NOW - DAY) })])
cases << run("a request retried in the future", [request_row(1, 10, json: { address_resync_count: 1, address_resync_at: iso(NOW + DAY) })])
cases << run("a retry time with an offset", [request_row(1, 10, json: { address_resync_at: "2026-10-28T12:30:45.123+00:00" })])
cases << run("a retry time with an offset on the boundary", [request_row(1, 10, json: { address_resync_at: "2026-10-28T14:30:45.123+02:00" })])
cases << run("a retry time with microseconds past the boundary", [request_row(1, 10, json: { address_resync_at: "2026-10-28T12:30:45.123001Z" })])
cases << run("a retry time with microseconds before the boundary", [request_row(1, 10, json: { address_resync_at: "2026-10-28T12:30:45.122999Z" })])
cases << run("a retry time that is not a time", [request_row(1, 10, json: { address_resync_at: "yesterday" })])
cases << run("a retry time that is the date alone", [request_row(1, 10, json: { address_resync_at: "2026-10-01" })])
cases << run("a retry time out of range", [request_row(1, 10, json: { address_resync_at: "2026-13-01T00:00:00Z" })])
cases << run("a retry time that is blank", [request_row(1, 10, json: { address_resync_at: "  " })])
cases << run("a retry time that is empty", [request_row(1, 10, json: { address_resync_at: "" })])
cases << run("a retry time that is null", [request_row(1, 10, json: { address_resync_at: nil })])
cases << run("a retry time that is false", [request_row(1, 10, json: { address_resync_at: false })])
cases << run("a retry time that is an empty array", [request_row(1, 10, json: { address_resync_at: [] })])
cases << run("a retry time that is a number", [request_row(1, 10, json: { address_resync_at: 5 })])
cases << run("a retry time that is true", [request_row(1, 10, json: { address_resync_at: true })])
cases << run("a retry time that is an array", [request_row(1, 10, json: { address_resync_at: ["x"] })])
cases << run("a retry time with a year before 1000", [request_row(1, 10, json: { address_resync_at: "0900-01-01T00:00:00Z" })])
[0, 7, 8, 9].each { |count| cases << run("a count of #{count}", [request_row(1, 10, json: { address_resync_count: count })]) }
cases << run("a count that is a string", [request_row(1, 10, json: { address_resync_count: "9" })])
cases << run("a count that is a string below the limit", [request_row(1, 10, json: { address_resync_count: "7" })])
cases << run("a count that is a string with text", [request_row(1, 10, json: { address_resync_count: "8 tries" })])
cases << run("a count that is a word", [request_row(1, 10, json: { address_resync_count: "many" })])
cases << run("a count that is a float below the limit", [request_row(1, 10, json: { address_resync_count: 7.9 })])
cases << run("a count that is a float at the limit", [request_row(1, 10, json: { address_resync_count: 8.5 })])
cases << run("a count that is a negative number", [request_row(1, 10, json: { address_resync_count: -3 })])
cases << run("a count that is null", [request_row(1, 10, json: { address_resync_count: nil })])
cases << run("a count that is true", [request_row(1, 10, json: { address_resync_count: true })])
cases << run("a count that is an array", [request_row(1, 10, json: { address_resync_count: [8] })])
cases << run("a count past the integer range", [request_row(1, 10, json: { address_resync_count: 10**20 })])
cases << run("json data that is null", [request_row(1, 10, json_data: "null")])
cases << run("json data that is an empty object", [request_row(1, 10, json: {})])
cases << run("json data that is an array", [request_row(1, 10, json_data: "[1]")])
cases << run("json data that is not json", [request_row(1, 10, json_data: "{oops")])
cases << run("json data that is empty text", [request_row(1, 10, json_data: "")])
cases << run("a retry time and a count that stop the retry", [request_row(1, 10, json: { address_resync_count: 8, address_resync_at: iso(NOW - 30 * DAY) })])
cases << run("a thousand and one requests of one user", (1..1001).map { |id| request_row(id, 10) })
cases << run("a batch boundary between two users", (1..1000).map { |id| request_row(id, 10) } + [request_row(1001, 11)])

File.write(OUT, "{\n\"now\": #{NOW.to_f.to_json},\n\"cases\": [\n#{cases.map(&:to_json).join(",\n")}\n]\n}\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
