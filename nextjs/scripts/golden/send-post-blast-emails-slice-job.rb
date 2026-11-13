# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/send-post-blast-emails-slice-job.golden.json: SendPostBlastEmailsSliceJob run by the real app
# against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). A slice of a live blast reaches `active_partition?`, which reads
# Redis for the partition marker: those cases are recorded up to there, which a marker exception stands in for, and Node hands them back to
# Rails (`hands_back`). Run it like release-chargeback-rate-payout-pause-for-seller-job.rb (env as in publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/send-post-blast-emails-slice-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[installments post_email_blasts].freeze
SEND_EMAILS = Installment.flag_mapping["flags"][:send_emails]
ARGS = ["part", 0, 2, [1, 2]].freeze

Rails.logger = ActiveSupport::Logger.new(nil)
ActiveJob::Base.queue_adapter = :sidekiq
ActiveJob::Base.logger = Logger.new(nil)

class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

SendPostBlastEmailsSliceJob.prepend(Module.new do
  private
    def active_partition?(*) = raise(HandBackMarker)
end)

def post_row(id, **overrides)
  { id:, seller_id: 1, link_id: nil, name: "Post #{id}", message: "Hello", flags: SEND_EMAILS, published_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def blast_row(id, post: 1, **overrides)
  { id:, post_id: post, seller_id: 1, requested_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

LIVE = { installments: [post_row(1)], post_email_blasts: [blast_row(1)] }.freeze

def run(name, seed, blast_id = 1, rest = ARGS)
  hands_back = false
  args = [blast_id, *rest]
  result = capture(name, now: NOW, tables: TABLES, seed:, sidekiq: true, job: "SendPostBlastEmailsSliceJob", args:, at: NOW.to_f) do
    SendPostBlastEmailsSliceJob.new.perform(*args)
  rescue HandBackMarker
    hands_back = true
  end
  result.delete("seed")
  result.delete("rows")
  result.merge("hands_back" => hands_back)
end

def live(**rest) = LIVE.merge(rest)

cases = []
cases << run("a blast that does not exist", {}, 9)
cases << run("a blast id of nil", LIVE, nil)
cases << run("a blast id as a digit string", LIVE, "1")
cases << run("a blast id as a float", LIVE, 1.0)
cases << run("a blast id as a word", LIVE, "abc")
cases << run("a blast whose post does not exist", live(installments: []))
cases << run("a blast whose post is of another id", live(installments: [post_row(2)]))
cases << run("a deleted post", live(installments: [post_row(1, deleted_at: SEEDED_AT)]))
cases << run("an unpublished post", live(installments: [post_row(1, published_at: nil)]))
cases << run("a post that does not send emails", live(installments: [post_row(1, flags: 0)]))
cases << run("a post that is only shown on the profile", live(installments: [post_row(1, flags: 1 << 7)]))
cases << run("a completed blast", live(post_email_blasts: [blast_row(1, completed_at: SEEDED_AT)]))
cases << run("an expired blast that is not completed", live(post_email_blasts: [blast_row(1, expired_at: SEEDED_AT)]))
cases << run("a live blast", LIVE)
cases << run("a live blast on a later chunk", LIVE, 1, ["part", 1, 2, [3]])
cases << run("a live blast with no members", LIVE, 1, ["part", 0, 1, []])
cases << run("a live blast among others", live(installments: [post_row(1), post_row(2, flags: 0)], post_email_blasts: [blast_row(1), blast_row(2, post: 2)]), 2)
cases << run("a deleted post that is also unpublished", live(installments: [post_row(1, deleted_at: SEEDED_AT, published_at: nil)]))
cases << run("a live blast with one argument too few", LIVE, 1, ["part", 0, 2])

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
