# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/send-post-blast-emails-job.golden.json: SendPostBlastEmailsJob run by the real app against
# a scratch database as a Sidekiq job (support/sidekiq_executor.rb). The five guards that open the job read the blast and its post and end
# it; a blast that passes them is recorded up to `stop_for_retired_newsletter?`, which precedes the first write (`started_at`), with a
# marker exception that Node hands back. Run it like pdf-unstampable-notifier-job.rb (env as in publish-scheduled-post.rb, USE_DB_WORKER_REPLICAS=true).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/send-post-blast-emails-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[installments post_email_blasts].freeze
SEND_EMAILS = 1 << 8

Rails.logger = ActiveSupport::Logger.new(nil)

class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

SendPostBlastEmailsJob.prepend(Module.new do
  def stop_for_retired_newsletter? = raise(HandBackMarker)
end)

def post_row(id, **overrides) = { id:, seller_id: 1, name: "Post #{id}", message: "Hello", installment_type: "audience", flags: SEND_EMAILS, published_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
def blast_row(id, post_id: 1, **overrides) = { id:, post_id:, seller_id: 1, requested_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)

def run(name, args, posts, blasts)
  hands_back = false
  result = capture(name, now: NOW, tables: TABLES, seed: { installments: posts, post_email_blasts: blasts }, sidekiq: true, job: "SendPostBlastEmailsJob", args:) do
    SendPostBlastEmailsJob.new.perform(*args)
  rescue HandBackMarker
    hands_back = true
  end
  result.delete("rows")
  result.delete("seed")
  result.merge("hands_back" => hands_back)
end

P = [post_row(1)].freeze
B = [blast_row(1)].freeze

cases = []
cases << run("a blast to send", [1], P, B)
cases << run("a blast among others", [2], P + [post_row(2)], B + [blast_row(2, post_id: 2)])
cases << run("a blast with a recipient filter", [1], P, [blast_row(1, recipient_filter: "unopened")])
cases << run("a blast that already started", [1], P, [blast_row(1, started_at: SEEDED_AT)])
cases << run("a blast that completed", [1], P, [blast_row(1, completed_at: SEEDED_AT)])
cases << run("a blast that expired", [1], P, [blast_row(1, expired_at: SEEDED_AT, expiry_reason: "abandoned")])
cases << run("a deleted post", [1], [post_row(1, deleted_at: SEEDED_AT)], B)
cases << run("an unpublished post", [1], [post_row(1, published_at: nil)], B)
cases << run("a post that sends no emails", [1], [post_row(1, flags: 0)], B)
cases << run("a post of another type", [1], [post_row(1, installment_type: "follower")], B)
cases << run("a blast that does not exist", [9], P, B)
cases << run("a blast id of zero", [0], P, B)
cases << run("the blast id as a digit string", ["1"], P, B)
cases << run("a blast id of nil", [nil], P, B)
cases << run("a blast id as a float", [1.0], P, B)
cases << run("a blast id as a word", ["one"], P, B)
cases << run("no arguments", [], P, B)
cases << run("two arguments", [1, 2], P, B)

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
