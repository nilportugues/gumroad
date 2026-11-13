# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/retry-stripe-rejected-payout-setups-job.golden.json: RetryStripeRejectedPayoutSetupsJob run
# by the real app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb), with the inline
# RetryStripeJpAddressResyncsJob it ends with. Run it like refund-all-for-fraud-worker.rb (USE_DB_WORKER_REPLICAS=true).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/retry-stripe-rejected-payout-setups-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[comments user_compliance_info_requests].freeze
ADMIN = GUMROAD_ADMIN_ID
BANK = StripeMerchantAccountManager::BANK_SYNC_FAILURE_NOTE_PREFIX
POSTAL = StripeMerchantAccountManager::POSTAL_CODE_FAILURE_NOTE_PREFIX
NO_VERDICT = StripeMerchantAccountManager::NO_VERDICT_FAILURE_NOTE_PREFIX
DAY = 86_400

Rails.logger = ActiveSupport::Logger.new(nil)

$replica_watches = 0
ReplicaLagWatcher.singleton_class.prepend(Module.new do
  def watch(*)
    $replica_watches += 1
  end
end)

def note(id, user_id, json: nil, content: "#{BANK}: details", **overrides)
  { id:, commentable_id: user_id, commentable_type: "User", author_id: ADMIN, author_name: "Admin", content:, comment_type: "payout_note",
    json_data: json && (json.is_a?(String) ? json : JSON.generate(json)), ancestry_depth: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def request_row(id, user_id, **overrides)
  { id:, user_id:, field_needed: "individual.address_kanji.line1", state: "requested", json_data: nil, flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def iso(time) = time.utc.iso8601

def run(name, comments, requests: [])
  $replica_watches = 0
  result = capture(name, now: NOW, tables: TABLES, seed: { comments:, user_compliance_info_requests: requests }, sidekiq: true, job: "RetryStripeRejectedPayoutSetupsJob", args: []) do
    RetryStripeRejectedPayoutSetupsJob.new.perform
  end
  result.delete("seed")
  result.delete("rows")
  # Flipper writes its feature set to Redis when its memoized flags expire mid-run: not the job's doing.
  result["redis"] = result["redis"].select { |key, _| key.start_with?("queue", "uniquejobs") }
  result["replica_watches"] = $replica_watches
  result
end

cases = []
cases << run("no notes", [])
cases << run("a note never retried", [note(1, 10)])
cases << run("each failure prefix", [note(1, 10, content: BANK), note(2, 11, content: POSTAL), note(3, 12, content: "#{NO_VERDICT} twice")])
cases << run("notes that are not rejected setups", [note(1, 10, content: "Stripe bank sync worked"), note(2, 11, content: "about #{BANK}"), note(3, 12, comment_type: "note"),
                                                   note(4, 13, commentable_type: "Purchase"), note(5, 14, author_id: ADMIN + 1), note(6, 15, deleted_at: SEEDED_AT)])
cases << run("two notes of one user", [note(1, 10), note(2, 10, content: POSTAL)])
cases << run("one due note and one not due for a user", [note(1, 10, json: { retry_count: 8 }), note(2, 10, json: { last_retried_at: iso(NOW) })])
cases << run("a note retried 3 days ago", [note(1, 10, json: { retry_count: 1, last_retried_at: iso(NOW - 3 * DAY) })])
cases << run("a note retried just under 3 days ago", [note(1, 10, json: { last_retried_at: iso(NOW - 3 * DAY + 1) })])
cases << run("a note retried 4 days ago", [note(1, 10, json: { last_retried_at: iso(NOW - 4 * DAY) })])
cases << run("a note retried in the future", [note(1, 10, json: { last_retried_at: iso(NOW + DAY) })])
cases << run("a retry time with an offset on the boundary", [note(1, 10, json: { last_retried_at: "2026-11-01T14:30:45.123+02:00" })])
cases << run("a retry time with microseconds past the boundary", [note(1, 10, json: { last_retried_at: "2026-11-01T12:30:45.123001Z" })])
cases << run("a retry time with microseconds before the boundary", [note(1, 10, json: { last_retried_at: "2026-11-01T12:30:45.122999Z" })])
cases << run("a retry time that is not a time", [note(1, 10, json: { last_retried_at: "yesterday" })])
cases << run("a retry time out of range", [note(1, 10, json: { last_retried_at: "2026-13-01T00:00:00Z" })])
cases << run("a retry time that is blank", [note(1, 10, json: { last_retried_at: "  " })])
cases << run("a retry time that is null", [note(1, 10, json: { last_retried_at: nil })])
cases << run("a retry time that is false", [note(1, 10, json: { last_retried_at: false })])
cases << run("a retry time that is an empty hash", [note(1, 10, json: { last_retried_at: {} })])
cases << run("a retry time that is a number", [note(1, 10, json: { last_retried_at: 5 })])
cases << run("a retry time that is true", [note(1, 10, json: { last_retried_at: true })])
cases << run("an abandoned note", [note(1, 10, json: { abandoned_at: iso(NOW - DAY), retry_count: 9 })])
cases << run("an abandoned_at that is blank", [note(1, 10, json: { abandoned_at: " ", retry_count: 9 })])
cases << run("an abandoned_at that is null", [note(1, 10, json: { abandoned_at: nil })])
cases << run("an abandoned_at that is false", [note(1, 10, json: { abandoned_at: false })])
cases << run("an abandoned_at that is a number", [note(1, 10, json: { abandoned_at: 1 })])
[0, 7, 8, 9].each { |count| cases << run("a count of #{count}", [note(1, 10, json: { retry_count: count, last_retried_at: iso(NOW) })]) }
cases << run("a count that is a string", [note(1, 10, json: { retry_count: "9", last_retried_at: iso(NOW) })])
cases << run("a count that is a string with text", [note(1, 10, json: { retry_count: "8 tries", last_retried_at: iso(NOW) })])
cases << run("a count that is a float at the limit", [note(1, 10, json: { retry_count: 8.5, last_retried_at: iso(NOW) })])
cases << run("a count that is a float below the limit", [note(1, 10, json: { retry_count: 7.9, last_retried_at: iso(NOW) })])
cases << run("a count that is a negative number", [note(1, 10, json: { retry_count: -3 })])
cases << run("a count that is null", [note(1, 10, json: { retry_count: nil })])
cases << run("a count that is true", [note(1, 10, json: { retry_count: true })])
cases << run("a count that is an array", [note(1, 10, json: { retry_count: [8] })])
cases << run("a count past the integer range", [note(1, 10, json: { retry_count: 10**20, last_retried_at: iso(NOW) })])
cases << run("json data that is null", [note(1, 10, json: "null")])
cases << run("json data that is an empty object", [note(1, 10, json: {})])
cases << run("json data that is an array", [note(1, 10, json: "[1]")])
cases << run("json data that is not json", [note(1, 10, json: "{oops")])
cases << run("json data that is a number", [note(1, 10, json: "5")])
cases << run("json data that is a string", [note(1, 10, json: '"x"')])
cases << run("json data that is an empty array", [note(1, 10, json: "[]")])
cases << run("json data that is empty text", [note(1, 10, json: "")])
cases << run("a kanji request after the notes", [note(1, 10)], requests: [request_row(1, 20)])
cases << run("a thousand and one notes of one user", (1..1001).map { |id| note(id, 10) })
cases << run("a batch boundary between two users", (1..1000).map { |id| note(id, 10) } + [note(1001, 11)])

now_f = travel_to(NOW, with_usec: true) { Time.now.to_f }
File.write(OUT, JSON.pretty_generate({ "now" => now_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
