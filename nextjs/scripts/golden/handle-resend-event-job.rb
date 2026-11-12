# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/handle-resend-event-job.golden.json: HandleResendEventJob run by the real app
# against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). The receipt path of HandleEmailEventInfo runs for real
# (CustomerEmailInfo rows and their state machine); the installment, abandoned cart and piracy handlers, a charge id and a purchase
# id that is not a plain integer are what Node hands back to Rails, so those are recorded up to the call a marker exception
# stands in for. An event whose parsing raises is handed back too. The headers are encrypted with MailerInfo under the key the
# recorder boots with. Run it like publish-scheduled-post.rb:
#
#   bundle exec rails runner nextjs/scripts/golden/handle-resend-event-job.rb   (env as in publish-scheduled-post.rb)
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/handle-resend-event-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
TABLES = %w[users email_infos email_info_charges].freeze
CREATED_AT = "2025-01-02 00:14:11.140106+00"

Rails.logger = ActiveSupport::Logger.new(nil)

class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

[HandleEmailEventInfo::ForInstallmentEmail, HandleEmailEventInfo::ForAbandonedCartEmail, HandleEmailEventInfo::ForPiracyNotice].each do |handler|
  handler.singleton_class.prepend(Module.new do
    def perform(*) = raise(HandBackMarker)
  end)
end
CustomerEmailInfo.singleton_class.prepend(Module.new do
  def find_or_initialize_for_charge(**) = raise(HandBackMarker)

  def find_or_initialize_for_purchase(purchase_id:, **)
    purchase_id.to_s.match?(/\A\d{1,15}\z/) ? super : raise(HandBackMarker)
  end
end)

def header(field, value)
  { "name" => MailerInfo.header_name(field), "value" => MailerInfo.encrypt(value) }
end

def tracked(**overrides)
  { mailer_class: "CustomerMailer", mailer_method: "receipt", purchase_id: "5" }.merge(overrides).compact.map { header(_1, _2) }
end

def event(type = "email.delivered", headers: tracked, data: {}, **extra)
  { "type" => type, "data" => { "created_at" => CREATED_AT, "to" => ["buyer@example.com"], "headers" => headers }.merge(data) }.merge(extra.transform_keys(&:to_s))
end

def info_row(id, state, purchase_id: 5, email_name: "receipt", **overrides)
  { id:, purchase_id:, type: "CustomerEmailInfo", email_name:, state:, sent_at: "2026-01-01 00:00:00" }.merge(overrides)
end

def run(name, event_json, seed: {})
  hands_back = false
  result = capture(name, now: NOW, tables: TABLES, seed:, sidekiq: true, job: "HandleResendEventJob", args: [event_json]) do
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
def receipt_cases(cases)
  [["email.delivered", %w[created sent delivered opened bounced]], ["email.opened", %w[created sent delivered opened bounced]], ["email.bounced", %w[created sent delivered opened bounced]]].each do |type, states|
    cases << run("#{type} with no row", event(type))
    states.each { |state| cases << run("#{type} for a #{state} row", event(type), seed: { email_infos: [info_row(1, state, delivered_at: ("2026-01-02 00:00:00" if %w[delivered opened].include?(state)), opened_at: ("2026-01-03 00:00:00" if state == "opened"))] }) }
  end
  cases << run("email.clicked with no row", event("email.clicked", data: { "click" => { "link" => "https://example.com/x" } }))
  cases << run("email.clicked for a sent row", event("email.clicked", data: { "click" => { "link" => "https://example.com/x" } }), seed: { email_infos: [info_row(1, "sent")] })
  cases << run("email.complained for a sent row", event("email.complained"), seed: { email_infos: [info_row(1, "sent")] })
  cases << run("email.complained with no row", event("email.complained"))
  cases << run("a delivered preorder receipt", event(headers: tracked(mailer_method: "preorder_receipt")), seed: { email_infos: [info_row(1, "sent", email_name: "preorder_receipt")] })
  cases << run("a delivered preorder receipt for a receipt row", event(headers: tracked(mailer_method: "preorder_receipt")), seed: { email_infos: [info_row(1, "sent")] })
  cases << run("a delivered receipt for another purchase", event, seed: { email_infos: [info_row(1, "sent", purchase_id: 6)] })
  cases << run("a delivered receipt for a row of another type", event, seed: { email_infos: [info_row(1, "sent", type: "CreatorContactingCustomersEmailInfo")] })
  cases << run("a delivered receipt with two sends, the event after both", event, seed: { email_infos: [info_row(1, "sent", sent_at: "2026-01-01 00:00:00"), info_row(2, "sent", sent_at: "2026-02-01 00:00:00")] })
  cases << run("a delivered receipt with two sends, the event between them", event(data: { "created_at" => "2026-01-15 00:00:00.5+00" }), seed: { email_infos: [info_row(1, "sent", sent_at: "2026-01-01 00:00:00"), info_row(2, "sent", sent_at: "2026-02-01 00:00:00")] })
  cases << run("a delivered receipt with two sends, the event before both", event(data: { "created_at" => "2025-12-01 00:00:00+00" }), seed: { email_infos: [info_row(1, "sent", sent_at: "2026-01-01 00:00:00"), info_row(2, "sent", sent_at: "2026-02-01 00:00:00")] })
  cases << run("a delivered receipt with two sends, the event at the second send", event(data: { "created_at" => "2026-02-01 00:00:00+00" }), seed: { email_infos: [info_row(1, "sent", sent_at: "2026-01-01 00:00:00"), info_row(2, "sent", sent_at: "2026-02-01 00:00:00")] })
  cases << run("a delivered receipt with a row sent at a fraction of a second", event(data: { "created_at" => "2026-01-01 00:00:00.5+00" }), seed: { email_infos: [info_row(1, "sent", sent_at: "2026-01-01 00:00:00")] })
  cases << run("a delivered receipt with a row that was never sent", event, seed: { email_infos: [info_row(1, "created", sent_at: nil), info_row(2, "sent", sent_at: "2026-01-01 00:00:00")] })
  cases << run("a delivered receipt with a time zone offset", event(data: { "created_at" => "2026-03-04T05:06:07.891+02:00" }))
  cases << run("a delivered receipt with a whole-second time", event(data: { "created_at" => "2026-03-04T05:06:07Z" }))
  cases << run("a delivered receipt with microseconds", event(data: { "created_at" => "2026-03-04 05:06:07.891234+00" }))
  cases << run("a delivered receipt with a purchase id of leading zeros", event(headers: tracked(purchase_id: "005")), seed: { email_infos: [info_row(1, "sent")] })
  cases << run("a delivered receipt with a purchase id that is not an integer", event(headers: tracked(purchase_id: "abc")))
  cases << run("a delivered receipt with no purchase id", event(headers: tracked(purchase_id: nil)))
  cases << run("a delivered receipt with a charge id", event(headers: tracked(charge_id: "9")), seed: { email_infos: [info_row(1, "sent")] })
  cases << run("a delivered receipt with a blank charge id", event(headers: tracked(charge_id: " ")), seed: { email_infos: [info_row(1, "sent")] })
  cases << run("a delivered event of another mailer", event(headers: tracked(mailer_class: "OtherMailer")))
  cases << run("a delivered event of another customer mailer method", event(headers: tracked(mailer_method: "something_else")))
  cases << run("a delivered event of a customer mailer receipt in another case", event(headers: tracked(mailer_method: "Receipt")))
  cases << run("a delivered abandoned cart", event(headers: tracked(mailer_method: "abandoned_cart", workflow_ids: "[3]")))
  cases << run("a delivered piracy notice", event(headers: tracked(mailer_class: "PiracyReportMailer", mailer_method: "notice", mailer_args: "[4]")))
  cases << run("a piracy mailer with another method", event(headers: tracked(mailer_class: "PiracyReportMailer", mailer_method: "other")))
  cases << run("a delivered receipt with a post id", event(headers: tracked(post_id: "12")), seed: { email_infos: [info_row(1, "sent")] })
  cases << run("a delivered receipt with a blank post id", event(headers: tracked(post_id: " ")), seed: { email_infos: [info_row(1, "sent")] })
  cases << run("a delivered purchase installment", event(headers: tracked(mailer_method: "purchase_installment", post_id: "12")))
  cases << run("an opened email of another mailer with a post id", event("email.opened", headers: tracked(mailer_class: "OtherMailer", post_id: "12")))
end
receipt_cases(cases)

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
