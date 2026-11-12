# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/alert-on-stuck-piracy-reports-job.golden.json: AlertOnStuckPiracyReportsJob run by the
# real app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). The :piracy_reports_sending Flipper feature is set
# in `setup` (`redis_before`). A run with something to report goes on to build the message (which asks PiracyReports::SendService for
# the reason each signed report is blocked) and pushes an InternalNotificationWorker; Node stops after the six reads and hands that run
# back, so those cases record the whole run. Run it like alert-on-zero-buyer-currency-wallet-purchases-job.rb (env as in
# publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/alert-on-stuck-piracy-reports-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[piracy_reports].freeze
FLAG = PiracyReports::SendService::FLAG

Rails.logger = ActiveSupport::Logger.new(nil)

def ago(duration) = (NOW - duration).utc.strftime("%Y-%m-%d %H:%M:%S")

def report(id, state, **overrides)
  { id:, external_id: "pr#{id}", seller_id: 1, product_id: 1, source: "api", state:, url: "https://pirate#{id}.example.com/a", normalized_url_digest: "digest#{id}",
    created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def run(name, reports = [], flag: :on)
  setup = lambda do
    case flag
    when :on then Feature.activate(FLAG)
    when :off then Feature.activate(FLAG).then { Feature.deactivate(FLAG) }
    when :time50 then Flipper.enable_percentage_of_time(FLAG, 50)
    when :time100 then Flipper.enable_percentage_of_time(FLAG, 100)
    when :actors100 then Feature.activate_percentage(FLAG, 100)
    end
  end
  result = capture(name, now: NOW, tables: TABLES, seed: { piracy_reports: reports }, setup:, sidekiq: true, job: "AlertOnStuckPiracyReportsJob", args: []) do
    AlertOnStuckPiracyReportsJob.new.perform
  end
  result.delete("seed")
  result.delete("rows")
  result
end

cases = []
cases << run("nothing to report")
cases << run("nothing to report with sending off", flag: :off)
cases << run("nothing to report with sending at 100 percent of time", flag: :time100)
cases << run("nothing to report with sending at 100 percent of actors", flag: :actors100)
cases << run("nothing to report with sending at 50 percent of time", flag: :time50)
cases << run("reports that wait on nobody", [
  report(1, "screening", screening_verdict: "fail"), report(2, "sent", delivered_at: ago(1.hour), sent_at: ago(3.days)),
  report(3, "sent", sent_at: ago(1.hour)), report(4, "signed", signed_at: ago(30.minutes)), report(5, "requested", updated_at: ago(1.hour)),
  report(6, "screening", screening_verdict: "pass", seller_id: 2, product_id: 2).merge(state: "cancelled"), report(7, "resolved"),
])
cases << run("a report blocked on its recipient", [report(1, "screening", screening_verdict: "pass", screened_at: SEEDED_AT)])
cases << run("a report that needs review", [report(1, "screening", screening_verdict: "review", screened_at: SEEDED_AT)])
cases << run("a report whose delivery failed", [report(1, "sent", delivery_failed_at: ago(1.hour), sent_at: ago(2.hours))])
cases << run("a report whose delivery failed and later arrived", [report(1, "sent", delivery_failed_at: ago(2.hours), delivered_at: ago(1.hour), sent_at: ago(3.hours))])
cases << run("a delivery unconfirmed just over 24 hours", [report(1, "sent", sent_at: ago(24.hours + 1.second))])
cases << run("a delivery unconfirmed exactly 24 hours", [report(1, "sent", sent_at: ago(24.hours))])
cases << run("a delivery unconfirmed just under 24 hours", [report(1, "sent", sent_at: ago(24.hours - 1.second))])
cases << run("a signed report unsent for two hours", [report(1, "signed", signed_at: ago(2.hours))])
cases << run("a signed report unsent for two hours with sending off", [report(1, "signed", signed_at: ago(2.hours))], flag: :off)
cases << run("a signed report unsent for exactly an hour", [report(1, "signed", signed_at: ago(1.hour))])
cases << run("a signed report unsent for an hour and a second", [report(1, "signed", signed_at: ago(1.hour + 1.second))])
cases << run("a report never started", [report(1, "requested", updated_at: ago(7.hours))])
cases << run("a report never started and recent", [report(1, "requested", updated_at: ago(5.hours))])
cases << run("a report never started for exactly six hours", [report(1, "requested", updated_at: ago(6.hours))])
cases << run("a report screening with no verdict", [report(1, "screening", updated_at: ago(7.hours))])
cases << run("a report screening with no verdict and recent", [report(1, "screening", updated_at: ago(1.hour))])
cases << run("two counter-notices from one seller", [
  report(1, "resolved", counter_notice_received_on: (NOW - 10.days).to_date.to_s), report(2, "resolved", counter_notice_received_on: (NOW - 20.days).to_date.to_s),
])
cases << run("one counter-notice from one seller", [report(1, "resolved", counter_notice_received_on: (NOW - 10.days).to_date.to_s)])
cases << run("two counter-notices from two sellers", [
  report(1, "resolved", counter_notice_received_on: (NOW - 10.days).to_date.to_s), report(2, "resolved", counter_notice_received_on: (NOW - 20.days).to_date.to_s, seller_id: 2),
])
cases << run("two counter-notices, one on the edge of the window", [
  report(1, "resolved", counter_notice_received_on: (NOW - 90.days).to_date.to_s), report(2, "resolved", counter_notice_received_on: (NOW - 20.days).to_date.to_s),
])
cases << run("two counter-notices, one just outside the window", [
  report(1, "resolved", counter_notice_received_on: (NOW - 91.days).to_date.to_s), report(2, "resolved", counter_notice_received_on: (NOW - 20.days).to_date.to_s),
])
cases << run("26 reports blocked on their recipient", (1..26).map { |i| report(i, "screening", screening_verdict: "pass", screened_at: SEEDED_AT) })
cases << run("every kind at once", [
  report(1, "screening", screening_verdict: "pass", screened_at: SEEDED_AT), report(2, "screening", screening_verdict: "review", screened_at: SEEDED_AT),
  report(3, "sent", delivery_failed_at: ago(1.hour), sent_at: ago(2.hours)), report(4, "signed", signed_at: ago(2.hours)),
  report(5, "requested", updated_at: ago(7.hours)), report(6, "resolved", counter_notice_received_on: (NOW - 10.days).to_date.to_s),
  report(7, "resolved", counter_notice_received_on: (NOW - 20.days).to_date.to_s),
])

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
