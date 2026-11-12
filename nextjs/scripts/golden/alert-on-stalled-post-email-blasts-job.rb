# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/alert-on-stalled-post-email-blasts-job.golden.json: AlertOnStalledPostEmailBlastsJob run
# by the real app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). Node runs the abandoned-blast expiry and
# the candidate scan, the dead, retry, queued and busy set scans, each blast's resume decision (markers, SendPostBlastEmailsJob
# pushes, dead entries removed) and the alert push. The Sidekiq sets, Flipper flag and blast keys a case starts from are its
# `redis_before` (REDIS_HOST and SIDEKIQ_REDIS_HOST must name the same database). Run it like publish-scheduled-post.rb:
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

# A sender that appears between the scans and the resume decision (`$after_scan`), as a live one can in production.
AlertOnStalledPostEmailBlastsJob.prepend(Module.new do
  private

  def resolve_action(entry, live:)
    if $after_scan
      hook = $after_scan
      $after_scan = nil
      hook.call
    end
    super
  end
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

LIVE = "auto_resume_stalled_post_blasts"

def entry(klass, id, jid: "jid#{id}") = { class: klass, args: [id], jid:, queue: "default", retry: 10, created_at: 1.0, enqueued_at: 1.0 }.to_json
def dead(klass, id, **) = ->(r) { r.zadd("dead", 1_700_000_000, entry(klass, id, **)) }
def retrying(klass, id, **) = ->(r) { r.zadd("retry", 1_700_000_000, entry(klass, id, **)) }
def queued(klass, id, **) = ->(r) { r.lpush("queue:default", entry(klass, id, **)) }
def busy(klass, id, payload: nil, process: "host:1:abc") = lambda do |r|
  r.sadd("processes", process)
  r.hset(process, "info", "{}")
  r.hset("#{process}:work", "tid#{id}", { queue: "default", payload: payload || entry(klass, id), run_at: 1_700_000_000 }.to_json)
end
def key(id, name, value, ex: nil) = ->(r) { ex ? r.set("blast:#{id}:#{name}", value, ex:) : r.set("blast:#{id}:#{name}", value) }
SENDER = "SendPostBlastEmailsJob"
SLICE = "SendPostBlastEmailsSliceJob"

def run(name, blasts: [], sent: [], race: nil, live: false, redis_setup: [], after_scan: nil)
  $race_email = race
  $after_scan = after_scan ? -> { after_scan.call(redis) } : nil
  setup = lambda do
    case live
    when true then Feature.activate(LIVE)
    when :actors100 then Feature.activate_percentage(LIVE, 100)
    when :actors50 then Feature.activate_percentage(LIVE, 50)
    when :time100 then Flipper.enable_percentage_of_time(LIVE, 100)
    when :time0 then Flipper.enable_percentage_of_time(LIVE, 0)
    when :off
      Feature.activate(LIVE)
      Feature.deactivate(LIVE)
    end
    redis_setup.each { _1.call(redis) }
  end
  result = capture(name, now: NOW, tables: TABLES, seed: { post_email_blasts: blasts, sent_post_emails: sent }, setup:, sidekiq: true, job: "AlertOnStalledPostEmailBlastsJob", args: []) do
    AlertOnStalledPostEmailBlastsJob.new.perform
  end
  result.delete("seed")
  result
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

# The scans and the resume decision.
STALLED = -> { blast(1, hours_ago(6)) }
cases << run("an unaccounted blast, auto-resume off", blasts: [STALLED.()])
cases << run("an unaccounted blast, auto-resume on", blasts: [STALLED.()], live: true)
cases << run("a dead blast, auto-resume off", blasts: [STALLED.()], redis_setup: [dead(SENDER, 1)])
cases << run("a dead blast, auto-resume on", blasts: [STALLED.()], live: true, redis_setup: [dead(SENDER, 1)])
cases << run("a dead slice, auto-resume on", blasts: [STALLED.()], live: true, redis_setup: [dead(SLICE, 1)])
cases << run("a dead sender and a dead slice of one blast", blasts: [STALLED.()], live: true, redis_setup: [dead(SENDER, 1), dead(SLICE, 1, jid: "slice")])
cases << run("a dead job of another class", blasts: [STALLED.()], live: true, redis_setup: [dead("OtherJob", 1)])
cases << run("a dead entry of another blast", blasts: [STALLED.()], live: true, redis_setup: [dead(SENDER, 2)])
cases << run("a retrying sender, auto-resume off", blasts: [STALLED.()], redis_setup: [retrying(SENDER, 1)])
cases << run("a retrying slice, auto-resume on", blasts: [STALLED.()], live: true, redis_setup: [retrying(SLICE, 1)])
cases << run("a queued sender, auto-resume off", blasts: [STALLED.()], redis_setup: [queued(SENDER, 1)])
cases << run("a queued slice among other jobs", blasts: [STALLED.()], redis_setup: [queued("OtherJob", 1), queued(SLICE, 1)])
cases << run("a busy sender, auto-resume off", blasts: [STALLED.()], redis_setup: [busy(SENDER, 1)])
cases << run("a busy slice", blasts: [STALLED.()], redis_setup: [busy(SLICE, 1)])
cases << run("a busy job of another class", blasts: [STALLED.()], redis_setup: [busy("OtherJob", 1)])
cases << run("a busy worker whose payload is not JSON", blasts: [STALLED.()], redis_setup: [busy(SENDER, 1, payload: "not json")])
cases << run("an idle process", blasts: [STALLED.()], redis_setup: [->(r) { r.sadd("processes", "host:2:def"); r.hset("host:2:def", "info", "{}") }])
cases << run("a blast that emailed ten minutes ago", blasts: [blast(1, hours_ago(6), last_email_delivered_at: hours_ago(0.1666))])
cases << run("a blast that emailed an hour ago, auto-resume on", blasts: [blast(1, hours_ago(6), last_email_delivered_at: hours_ago(1))], live: true)
cases << run("a blast deferred until tomorrow", blasts: [STALLED.()], redis_setup: [key(1, "quota_deferred_until", (NOW + 86_400).utc.iso8601)])
cases << run("a blast whose deferral passed, auto-resume on", blasts: [STALLED.()], live: true, redis_setup: [key(1, "quota_deferred_until", (NOW - 3600).utc.iso8601)])
cases << run("a blast past the window whose deferral passed, auto-resume on", blasts: [blast(1, hours_ago(30))], live: true, redis_setup: [key(1, "quota_deferred_until", (NOW - 3600).utc.iso8601)])
cases << run("a blast past the window, auto-resume on", blasts: [blast(1, hours_ago(30))], live: true)
cases << run("a blast past the window, auto-resume off", blasts: [blast(1, hours_ago(30))])
cases << run("a blast past the window with recipients owed", blasts: [blast(1, hours_ago(30))], live: true, redis_setup: [key(1, "pending_recipients", "12")])
cases << run("a blast past the window with none owed", blasts: [blast(1, hours_ago(30))], live: true, redis_setup: [key(1, "pending_recipients", "0")])
cases << run("a blast with an empty owed count", blasts: [blast(1, hours_ago(30))], live: true, redis_setup: [key(1, "pending_recipients", "")])
cases << run("a blast already auto-resumed", blasts: [STALLED.()], live: true, redis_setup: [key(1, "auto_resumed", "2026-11-04T10:00:00Z", ex: 14_400)])
cases << run("a dead blast already auto-resumed, auto-resume off", blasts: [STALLED.()], redis_setup: [dead(SENDER, 1), key(1, "auto_resumed", "2026-11-04T10:00:00Z", ex: 14_400)])
cases << run("an unaccounted non-opener resend, auto-resume on", blasts: [blast(1, hours_ago(6), recipient_filter: "unopened")], live: true)
cases << run("a dead non-opener resend, auto-resume on", blasts: [blast(1, hours_ago(6), recipient_filter: "unopened")], live: true, redis_setup: [dead(SENDER, 1)])
cases << run("a fully delivered blast, auto-resume off", blasts: [STALLED.()], redis_setup: [key(1, "pending_recipients", "0")])
cases << run("a fully delivered blast, auto-resume on", blasts: [STALLED.()], live: true, redis_setup: [key(1, "pending_recipients", "0")])
cases << run("a fully delivered dead blast past the window", blasts: [blast(1, hours_ago(30))], live: true, redis_setup: [key(1, "pending_recipients", "0"), dead(SENDER, 1)])
cases << run("a fully delivered non-opener resend", blasts: [blast(1, hours_ago(30), recipient_filter: "unopened")], live: true, redis_setup: [key(1, "pending_recipients", "0")])
cases << run("a fully delivered blast already resumed to complete", blasts: [STALLED.()], live: true, redis_setup: [key(1, "pending_recipients", "0"), key(1, "completion_resumed", "2026-11-04T10:00:00Z", ex: 14_400)])
cases << run("a fully delivered blast with a negative count", blasts: [STALLED.()], live: true, redis_setup: [key(1, "pending_recipients", "-3")])
cases << run("a fully delivered blast whose sender reappears", blasts: [STALLED.()], live: true, redis_setup: [key(1, "pending_recipients", "0")], after_scan: ->(r) { queued(SENDER, 1).call(r) })
cases << run("an unaccounted blast whose sender reappears", blasts: [STALLED.()], live: true, after_scan: ->(r) { retrying(SLICE, 1).call(r) })
cases << run("a dead blast whose sender reappears busy", blasts: [STALLED.()], live: true, redis_setup: [dead(SENDER, 1)], after_scan: ->(r) { busy(SENDER, 1).call(r) })
cases << run("a held blast among resumed ones", blasts: [blast(1, hours_ago(6)), blast(2, hours_ago(30)), blast(3, hours_ago(7))], live: true, redis_setup: [dead(SENDER, 1)])
cases << run("two dead blasts resumed", blasts: [blast(1, hours_ago(6)), blast(2, hours_ago(7))], live: true, redis_setup: [dead(SENDER, 1), dead(SENDER, 2)])
cases << run("a retrying blast and a held one", blasts: [blast(1, hours_ago(6)), blast(2, hours_ago(30))], live: true, redis_setup: [retrying(SENDER, 1)])
cases << run("a never started blast and a started one", blasts: [blast(1, hours_ago(6)), blast(2, hours_ago(7), started_at: hours_ago(6), delivery_count: 12)])
cases << run("a blast requested 5.55 hours ago", blasts: [blast(1, hours_ago(5.55))])
cases << run("a blast requested 12.25 hours ago", blasts: [blast(1, hours_ago(12.25))])
cases << run("thirty candidates, auto-resume off", blasts: (1..30).map { blast(_1, hours_ago(5 + _1 * 0.1)) })
cases << run("thirty candidates, auto-resume on", blasts: (1..30).map { blast(_1, hours_ago(5 + _1 * 0.1)) }, live: true, redis_setup: [dead(SENDER, 3)])
cases << run("thirty held blasts", blasts: (1..30).map { blast(_1, hours_ago(30 + _1)) }, live: true)
cases << run("five hundred and one candidates, auto-resume off", blasts: (1..501).map { blast(_1, hours_ago(5 + _1 * 0.01)) })
cases << run("a blast that emailed 29 minutes ago", blasts: [blast(1, hours_ago(6), last_email_delivered_at: hours_ago(29 / 60.0))])
cases << run("a blast that emailed exactly 30 minutes ago", blasts: [blast(1, hours_ago(6), last_email_delivered_at: hours_ago(0.5))])
cases << run("a blast that emailed 30.5 minutes ago", blasts: [blast(1, hours_ago(6), last_email_delivered_at: hours_ago(30.5 / 60.0))])
cases << run("a retrying blast and a would-resume one", blasts: [blast(1, hours_ago(6)), blast(2, hours_ago(7))], redis_setup: [retrying(SENDER, 1)])
cases << run("a blast that emailed 31 minutes ago", blasts: [blast(1, hours_ago(6), last_email_delivered_at: hours_ago(31 / 60.0))])
cases << run("a blast requested 23 hours ago, auto-resume on", blasts: [blast(1, hours_ago(23))], live: true)
cases << run("a blast requested 25 hours ago, auto-resume on", blasts: [blast(1, hours_ago(25))], live: true)
cases << run("auto-resume on for every actor", blasts: [STALLED.()], live: :actors100)
cases << run("auto-resume on for half the actors", blasts: [STALLED.()], live: :actors50)
cases << run("auto-resume on for all of the time", blasts: [STALLED.()], live: :time100)
cases << run("auto-resume on for none of the time", blasts: [STALLED.()], live: :time0)
cases << run("auto-resume switched off", blasts: [STALLED.()], live: :off)
cases << run("five hundred candidates", blasts: (1..500).map { blast(_1, hours_ago(5 + _1 * 0.01)) })

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
