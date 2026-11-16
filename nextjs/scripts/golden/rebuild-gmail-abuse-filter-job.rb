# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/rebuild-gmail-abuse-filter-job.golden.json: RebuildGmailAbuseFilterJob run by the
# real app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). Run it like
# delete-expired-oauth-device-authorizations-job.rb (env as in publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/rebuild-gmail-abuse-filter-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[users].freeze
KEY = GmailAbuseFilter::REDIS_KEY
BATCH_SIZE = 1_000

Rails.logger = ActiveSupport::Logger.new(nil)

def user_row(id, email, state = "suspended_for_fraud", **overrides)
  { id:, email:, username: "user#{id}", external_id: (1000 + id).to_s, user_risk_state: state, flags: 0, json_data: nil,
    confirmed_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def run(name, users, filter: nil, temp: nil)
  setup = (filter || temp) && -> { Array(filter).each { redis.sadd(KEY, _1) }; Array(temp).each { redis.sadd("#{KEY}:rebuild", _1) } }
  capture(name, now: NOW, tables: TABLES, seed: { users: }, setup:, sidekiq: true, job: "RebuildGmailAbuseFilterJob", args: []) do
    RebuildGmailAbuseFilterJob.new.perform
  end
end

cases = []
cases << run("no users", [])
cases << run("a suspended gmail user", [user_row(1, "bad@gmail.com")])
cases << run("every abusive risk state", User::EmailNormalization::ABUSIVE_RISK_STATES.each_with_index.map { |s, i| user_row(i + 1, "u#{i}@gmail.com", s) })
cases << run("states that are not abusive", %w[compliant not_reviewed on_probation].each_with_index.map { |s, i| user_row(i + 1, "u#{i}@gmail.com", s) })
cases << run("a googlemail address is stored as gmail", [user_row(1, "Some.One+tag@googlemail.com")])
cases << run("dots, plus tags and case collapse to one entry", [user_row(1, "a.b@gmail.com"), user_row(2, "AB+x@GMAIL.COM"), user_row(3, "a.b+y@googlemail.com", "flagged_for_fraud")])
cases << run("a domain that is not gmail", [user_row(1, "bad@example.com"), user_row(2, "bad@notgmail.com"), user_row(3, "bad@gmail.com.example.org")])
cases << run("an address with two at signs", [user_row(1, "a@b@gmail.com"), user_row(2, "x@gmail.com@example.com")])
cases << run("a stale filter is replaced", [user_row(1, "new@gmail.com")], filter: %w[old@gmail.com other@gmail.com])
cases << run("a stale filter is emptied when nobody qualifies", [user_row(1, "ok@gmail.com", "compliant")], filter: %w[old@gmail.com])
cases << run("a leftover temp key is dropped first", [user_row(1, "new@gmail.com")], filter: %w[old@gmail.com], temp: %w[leftover@gmail.com])
cases << run("an address with no domain part", [user_row(1, "plain")])
cases << run("one batch exactly", (1..BATCH_SIZE).map { user_row(_1, "u#{_1}@gmail.com") })
cases << run("one user past a batch", (1..(BATCH_SIZE + 1)).map { user_row(_1, "u#{_1}@gmail.com") })

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases.each { _1.delete("rows") } }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
