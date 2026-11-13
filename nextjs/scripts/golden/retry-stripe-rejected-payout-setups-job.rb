# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/retry-stripe-rejected-payout-setups-job.golden.json: RetryStripeRejectedPayoutSetupsJob
# run by the real app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). The per-seller jobs it pushes carry a
# unique-jobs lock, so a case's Redis snapshot holds the locks; ReplicaLagWatcher.watch calls are counted under `replica_watches`.
# Run it like retry-stripe-jp-address-resyncs-job.rb (env as in publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/retry-stripe-rejected-payout-setups-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[comments user_compliance_info_requests].freeze
BANK = "Stripe bank sync failed: invalid_account_number — x"
POSTAL = "Stripe postal code rejected: postal_code_invalid — x"
VERDICT = "Stripe payout setup failed without a verdict: Stripe::APIError — x"
DAY = 86_400

Rails.logger = ActiveSupport::Logger.new(nil)

$replica_watches = 0
ReplicaLagWatcher.singleton_class.prepend(Module.new do
  def watch(*)
    $replica_watches += 1
  end
end)

def note_row(id, user_id, content = BANK, json: nil, **overrides)
  {
    id:, commentable_id: user_id, commentable_type: "User", author_id: GUMROAD_ADMIN_ID, comment_type: "payout_note", content:,
    json_data: json && JSON.generate(json), ancestry_depth: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT
  }.merge(overrides)
end

def request_row(id, user_id, json: nil)
  { id:, user_id:, field_needed: "individual.address_kanji.line1", state: "requested", json_data: json && JSON.generate(json), flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }
end

def iso(time) = time.utc.iso8601

def run(name, notes, requests = [])
  $replica_watches = 0
  result = capture(name, now: NOW, tables: TABLES, seed: { comments: notes, user_compliance_info_requests: requests }, sidekiq: true, job: "RetryStripeRejectedPayoutSetupsJob", args: []) do
    RetryStripeRejectedPayoutSetupsJob.new.perform
  end
  result.delete("seed")
  result.delete("rows")
  result["replica_watches"] = $replica_watches
  result
end

cases = []
cases << run("no notes", [])
cases << run("a note never retried", [note_row(1, 10)])
cases << run("a postal code note", [note_row(1, 10, POSTAL)])
cases << run("a no verdict note", [note_row(1, 10, VERDICT)])
cases << run("a note with another content", [note_row(1, 10, "Payout failed: x"), note_row(2, 11, "bank sync failed")])
cases << run("a note with the prefix in the middle", [note_row(1, 10, "Retry of Stripe bank sync failed")])
cases << run("a deleted note", [note_row(1, 10, deleted_at: SEEDED_AT)])
cases << run("a note of another comment type", [note_row(1, 10, comment_type: "note")])
cases << run("a note of another author", [note_row(1, 10, author_id: 5)])
cases << run("a note on another commentable type", [note_row(1, 10, commentable_type: "Link")])
cases << run("a note with no commentable", [note_row(1, nil)])
cases << run("two notes of one user", [note_row(1, 10), note_row(2, 10, POSTAL)])
cases << run("notes of three users", [note_row(1, 10), note_row(2, 11), note_row(3, 12, VERDICT)])
cases << run("one due note and one not due for a user", [note_row(1, 10, json: { retry_count: 1, last_retried_at: iso(NOW - DAY) }), note_row(2, 10)])
cases << run("an abandoned note", [note_row(1, 10, json: { abandoned_at: iso(NOW) })])
cases << run("an abandoned note that reached the retry limit", [note_row(1, 10, json: { abandoned_at: iso(NOW), retry_count: 9 })])
cases << run("an abandoned_at that is blank", [note_row(1, 10, json: { abandoned_at: " ", retry_count: 1, last_retried_at: iso(NOW - DAY) })])
cases << run("an abandoned_at that is false", [note_row(1, 10, json: { abandoned_at: false })])
cases << run("an abandoned_at that is an empty hash", [note_row(1, 10, json: { abandoned_at: {} })])
cases << run("an abandoned_at that is a number", [note_row(1, 10, json: { abandoned_at: 0 })])
[0, 7, 8, 9].each { |count| cases << run("a retry count of #{count} retried a day ago", [note_row(1, 10, json: { retry_count: count, last_retried_at: iso(NOW - DAY) })]) }
cases << run("a retry count that is a string at the limit", [note_row(1, 10, json: { retry_count: "8", last_retried_at: iso(NOW - DAY) })])
cases << run("a retry count that is a word", [note_row(1, 10, json: { retry_count: "many", last_retried_at: iso(NOW - DAY) })])
cases << run("a retry count that is a float", [note_row(1, 10, json: { retry_count: 8.9, last_retried_at: iso(NOW - DAY) })])
cases << run("a retry count that is null", [note_row(1, 10, json: { retry_count: nil, last_retried_at: iso(NOW - DAY) })])
cases << run("a retry count that is true", [note_row(1, 10, json: { retry_count: true })])
cases << run("a retry count that is an array", [note_row(1, 10, json: { retry_count: [8] })])
cases << run("a retry count that is a hash", [note_row(1, 10, json: { retry_count: { a: 1 } })])
cases << run("a retry count past the integer range", [note_row(1, 10, json: { retry_count: 10**20, last_retried_at: iso(NOW - DAY) })])
cases << run("a note retried 3 days ago", [note_row(1, 10, json: { retry_count: 1, last_retried_at: iso(NOW - 3 * DAY) })])
cases << run("a note retried just under 3 days ago", [note_row(1, 10, json: { retry_count: 1, last_retried_at: iso(NOW - 3 * DAY + 1) })])
cases << run("a note retried 4 days ago", [note_row(1, 10, json: { retry_count: 1, last_retried_at: iso(NOW - 4 * DAY) })])
cases << run("a note retried a day ago", [note_row(1, 10, json: { retry_count: 1, last_retried_at: iso(NOW - DAY) })])
cases << run("a note retried in the future", [note_row(1, 10, json: { retry_count: 1, last_retried_at: iso(NOW + DAY) })])
cases << run("a retry time with an offset on the boundary", [note_row(1, 10, json: { last_retried_at: "2026-11-01T14:30:45.123+02:00" })])
cases << run("a retry time with microseconds past the boundary", [note_row(1, 10, json: { last_retried_at: "2026-11-01T12:30:45.123001Z" })])
cases << run("a retry time with microseconds before the boundary", [note_row(1, 10, json: { last_retried_at: "2026-11-01T12:30:45.122999Z" })])
cases << run("a retry time that is not a time", [note_row(1, 10, json: { last_retried_at: "yesterday" })])
cases << run("a retry time that is the date alone", [note_row(1, 10, json: { last_retried_at: "2026-10-01" })])
cases << run("a retry time out of range", [note_row(1, 10, json: { last_retried_at: "2026-13-01T00:00:00Z" })])
cases << run("a retry time that is blank", [note_row(1, 10, json: { last_retried_at: "  " })])
cases << run("a retry time that is empty", [note_row(1, 10, json: { last_retried_at: "" })])
cases << run("a retry time that is null", [note_row(1, 10, json: { last_retried_at: nil })])
cases << run("a retry time that is false", [note_row(1, 10, json: { last_retried_at: false })])
cases << run("a retry time that is an empty array", [note_row(1, 10, json: { last_retried_at: [] })])
cases << run("a retry time that is a number", [note_row(1, 10, json: { last_retried_at: 5 })])
cases << run("a retry time that is true", [note_row(1, 10, json: { last_retried_at: true })])
cases << run("a retry time that is an array", [note_row(1, 10, json: { last_retried_at: ["x"] })])
cases << run("a retry time with a year before 1000", [note_row(1, 10, json: { last_retried_at: "0900-01-01T00:00:00Z" })])
cases << run("json data that is null", [note_row(1, 10, json_data: "null")])
cases << run("json data that is an empty object", [note_row(1, 10, json: {})])
cases << run("json data that is an array", [note_row(1, 10, json_data: "[1]")])
cases << run("json data that is not json", [note_row(1, 10, json_data: "{oops")])
cases << run("json data that is empty text", [note_row(1, 10, json_data: "")])
cases << run("a thousand and one notes of one user", (1..1001).map { |id| note_row(id, 10) })
cases << run("a batch boundary between two users", (1..1000).map { |id| note_row(id, 10) } + [note_row(1001, 11)])
cases << run("an address request due for a resync", [], [request_row(1, 20)])
cases << run("a note and an address request of different users", [note_row(1, 10)], [request_row(1, 20)])
cases << run("a note that fails and an address request", [note_row(1, 10, json: { retry_count: true })], [request_row(1, 20)])

File.write(OUT, "{\n\"now\": #{NOW.to_f.to_json},\n\"cases\": [\n#{cases.map(&:to_json).join(",\n")}\n]\n}\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
