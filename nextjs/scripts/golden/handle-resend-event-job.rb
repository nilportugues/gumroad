# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/handle-resend-event-job.golden.json: HandleResendEventJob run by the real app
# against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). An event the job would hand to HandleEmailEventInfo
# (and an event whose parsing raises) is what Node hands back to Rails; those cases are recorded up to that call, which a marker
# exception stands in for. The headers are encrypted with MailerInfo under the key the recorder boots with. Run it like
# publish-scheduled-post.rb:
#
#   bundle exec rails runner nextjs/scripts/golden/handle-resend-event-job.rb   (env as in publish-scheduled-post.rb)
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/handle-resend-event-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
TABLES = %w[users].freeze
CREATED_AT = "2025-01-02 00:14:11.140106+00"

Rails.logger = ActiveSupport::Logger.new(nil)

class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

HandleEmailEventInfo.singleton_class.prepend(Module.new do
  def perform(*) = raise(HandBackMarker)
end)

def header(field, value)
  { "name" => MailerInfo.header_name(field), "value" => MailerInfo.encrypt(value) }
end

def tracked(**overrides)
  { mailer_class: "CustomerMailer", mailer_method: "receipt" }.merge(overrides).compact.map { header(_1, _2) }
end

def event(type = "email.delivered", headers: tracked, data: {}, **extra)
  { "type" => type, "data" => { "created_at" => CREATED_AT, "to" => ["buyer@example.com"], "headers" => headers }.merge(data) }.merge(extra.transform_keys(&:to_s))
end

def run(name, event_json)
  hands_back = false
  result = capture(name, now: NOW, tables: TABLES, sidekiq: true, job: "HandleResendEventJob", args: [event_json]) do
    HandleResendEventJob.new.perform(event_json)
  rescue HandBackMarker
    hands_back = true
  end
  result.delete("rows")
  result.delete("seed")
  result.merge("hands_back" => hands_back)
end

cases = []
cases << run("a delivered receipt", event)
cases << run("an opened receipt", event("email.opened"))
cases << run("a clicked receipt", event("email.clicked", data: { "click" => { "link" => "https://example.com/x" } }))
cases << run("a bounced installment", event("email.bounced", headers: tracked(mailer_method: "purchase_installment", post_id: "12")))
cases << run("a complaint", event("email.complained"))
cases << run("an event type that is not tracked", event("email.sent"))
cases << run("a sent event with no type", event(nil))
cases << run("a missing mailer class", event(headers: tracked(mailer_class: nil)))
cases << run("a missing mailer method", event(headers: tracked(mailer_method: nil)))
cases << run("a blank mailer class", event(headers: tracked(mailer_class: " ")))
cases << run("no headers", event(headers: []))
cases << run("headers of another provider", event(headers: [{ "name" => "X-Other", "value" => "v" }]))
cases << run("an untracked type with workflow ids that do not parse", event("email.sent", headers: tracked(workflow_ids: "{")))
cases << run("a delivered event with workflow ids", event(headers: tracked(workflow_ids: "[1,2]")))
cases << run("a delivered event with workflow ids that do not parse", event(headers: tracked(workflow_ids: "{")))
cases << run("a delivered event with a charge id and purchase id", event(headers: tracked(charge_id: "7", purchase_id: "3")))
cases << run("an untracked type with no created_at", event("email.sent", data: { "created_at" => nil }))
cases << run("an untracked type with a created_at that does not parse", event("email.sent", data: { "created_at" => "yesterday" }))
cases << run("a delivered event with a created_at that does not parse", event(data: { "created_at" => "yesterday" }))
cases << run("a number for created_at", event("email.sent", data: { "created_at" => 5 }))
cases << run("no recipients", event("email.sent", data: { "to" => [] }))
cases << run("recipients that are null", event("email.sent", data: { "to" => nil }))
cases << run("no data", { "type" => "email.delivered" })
cases << run("data that is a string", { "type" => "email.delivered", "data" => "x" })
cases << run("headers that are not a list", event(headers: "x"))
cases << run("a header that is not a hash", event(headers: ["x"]))
cases << run("a header value that is not encrypted", event(headers: [{ "name" => MailerInfo.header_name(:mailer_class), "value" => "plain" }]))
cases << run("a header value that is a number", event(headers: [{ "name" => MailerInfo.header_name(:mailer_class), "value" => 5 }]))
cases << run("click that is not a hash", event("email.sent", data: { "click" => "x" }))
cases << run("headers that are null", event("email.sent", headers: nil))

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
