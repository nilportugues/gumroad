# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/alert-on-stalled-post-email-blasts-job.golden.json: AlertOnStalledPostEmailBlastsJob run
# by the real app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). Node runs the abandoned-blast expiry and
# the candidate scan, and finishes a run with no candidate; a run with candidates goes on to scan Sidekiq's dead, retry and busy sets
# and to resolve and push the alert, which Node hands back. Those runs are recorded up to the dead set scan, which a marker exception
# stands in for. Run it like publish-scheduled-post.rb:
#
#   bundle exec rails runner nextjs/scripts/golden/alert-on-stalled-post-email-blasts-job.rb   (env as in publish-scheduled-post.rb)
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/alert-on-stalled-post-email-blasts-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[post_email_blasts sent_post_emails].freeze

Rails.logger = ActiveSupport::Logger.new(nil)
ErrorNotifier.singleton_class.prepend(Module.new { def notify(*) = nil })

class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

AlertOnStalledPostEmailBlastsJob.prepend(Module.new do
  private

  def dead_blast_entries = raise(HandBackMarker)
end)

# A sale lands between the expiry's first read and its re-check, so the re-check finds nothing left to expire.
$race_email = nil
PostEmailBlast.singleton_class.prepend(Module.new do
  def expire(*, **)
    if $race_email
      row = $race_email
      $race_email = nil
      ActiveRecord::Base.connection.execute("INSERT INTO sent_post_emails (#{row.keys.join(", ")}) VALUES (#{row.values.map { ActiveRecord::Base.connection.quote(_1) }.join(", ")})")
    end
    super
  end
end)

def hours_ago(hours) = (NOW - (hours * 3600)).strftime("%Y-%m-%d %H:%M:%S.%6N")
def days_ago(days) = hours_ago(days * 24)

def blast(id, requested_at, post: id, **overrides)
  { id:, post_id: post, seller_id: 1, requested_at:, created_at: SEEDED_AT, updated_at: SEEDED_AT, delivery_count: 0 }.merge(overrides)
end

def sent_email(id, post, created_at) = { id:, post_id: post, email: "buyer#{id}@example.com", created_at:, updated_at: created_at }

def run(name, blasts: [], sent: [], race: nil)
  hands_back = false
  $race_email = race
  result = capture(name, now: NOW, tables: TABLES, seed: { post_email_blasts: blasts, sent_post_emails: sent }, sidekiq: true, job: "AlertOnStalledPostEmailBlastsJob", args: []) do
    AlertOnStalledPostEmailBlastsJob.new.perform
  rescue HandBackMarker
    hands_back = true
  end
  result.delete("seed")
  result.merge("hands_back" => hands_back)
end

cases = []
cases << run("no blasts")
cases << run("an abandoned blast", blasts: [blast(1, days_ago(20))])
cases << run("an abandoned blast of a later original blast", blasts: [blast(1, days_ago(20), post: 7), blast(2, days_ago(19), post: 7)])
cases << run("three abandoned blasts", blasts: [blast(1, days_ago(15)), blast(2, days_ago(25)), blast(3, days_ago(20))])
cases << run("a blast that delivered its first email", blasts: [blast(1, days_ago(20), first_email_delivered_at: days_ago(20))])
cases << run("a blast with a sent post email after it", blasts: [blast(1, days_ago(20))], sent: [sent_email(1, 1, days_ago(19))])
cases << run("a blast with a sent post email before it", blasts: [blast(1, days_ago(20))], sent: [sent_email(1, 1, days_ago(21))])
cases << run("a blast with a sent post email after a later blast", blasts: [blast(1, days_ago(20), post: 4), blast(2, days_ago(19), post: 4)], sent: [sent_email(1, 4, days_ago(18))])
cases << run("a blast with a sent post email of another post", blasts: [blast(1, days_ago(20))], sent: [sent_email(1, 2, days_ago(19))])
cases << run("a non-opener resend", blasts: [blast(1, days_ago(20), recipient_filter: "unopened")])
cases << run("a completed blast", blasts: [blast(1, days_ago(20), completed_at: days_ago(20))])
cases << run("an expired blast", blasts: [blast(1, days_ago(20), expired_at: days_ago(18), expiry_reason: "quota")])
cases << run("a blast older than the expiry window", blasts: [blast(1, days_ago(30))])
cases << run("a blast exactly at the oldest expiry bound", blasts: [blast(1, days_ago(28))])
cases << run("a blast exactly at the lookback", blasts: [blast(1, days_ago(14))])
cases << run("a blast without a request time", blasts: [blast(1, nil)])
cases << run("a blast that is sent to between the expiry reads", blasts: [blast(1, days_ago(20))], race: sent_email(1, 1, days_ago(19)))
cases << run("a blast requested an hour ago", blasts: [blast(1, hours_ago(1))])
cases << run("a blast requested exactly four hours ago", blasts: [blast(1, hours_ago(4))])
cases << run("a blast requested five hours ago", blasts: [blast(1, hours_ago(5))])
cases << run("a started blast requested a day ago", blasts: [blast(1, hours_ago(24), started_at: hours_ago(23), first_email_delivered_at: hours_ago(23), delivery_count: 40)])
cases << run("a completed blast requested a day ago", blasts: [blast(1, hours_ago(24), completed_at: hours_ago(23))])
cases << run("an expired blast requested a day ago", blasts: [blast(1, hours_ago(24), expired_at: hours_ago(2), expiry_reason: "quota")])
cases << run("a blast requested thirteen days ago", blasts: [blast(1, days_ago(13))])
cases << run("an abandoned blast and a candidate", blasts: [blast(1, days_ago(20)), blast(2, hours_ago(6))])
cases << run("two candidates", blasts: [blast(1, hours_ago(6)), blast(2, hours_ago(10))])
cases << run("a candidate and a recent blast", blasts: [blast(1, hours_ago(6)), blast(2, hours_ago(1))])

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
