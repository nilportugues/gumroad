# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/handle-resend-event-job.golden.json: HandleResendEventJob run by the real app
# against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). The receipt path of HandleEmailEventInfo runs for real
# (CustomerEmailInfo rows and their state machine, for a purchase or a charge); the installment, abandoned cart and piracy handlers and a purchase
# id that is not a plain integer are what Node hands back to Rails, so those are recorded up to the call a marker exception
# stands in for. An event whose parsing raises is handed back too. The headers are encrypted with MailerInfo under the key the
# recorder boots with. Run it like publish-scheduled-post.rb:
#
#   bundle exec rails runner nextjs/scripts/golden/handle-resend-event-job.rb   (env as in publish-scheduled-post.rb)
require_relative "support/rails_cases"
include RailsCases
require_relative "support/piracy_notice_rows"
include PiracyNoticeRows

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/handle-resend-event-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
TABLES = %w[users email_infos email_info_charges charges links piracy_reports].freeze
CREATED_AT = "2025-01-02 00:14:11.140106+00"

Rails.logger = ActiveSupport::Logger.new(nil)

class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

[HandleEmailEventInfo::ForInstallmentEmail, HandleEmailEventInfo::ForAbandonedCartEmail].each do |handler|
  handler.singleton_class.prepend(Module.new do
    def perform(*) = raise(HandBackMarker)
  end)
end
CustomerEmailInfo.singleton_class.prepend(Module.new do
  def find_or_initialize_for_charge(charge_id:, **)
    charge_id.to_s.match?(/\A\d{1,15}\z/) ? super : raise(HandBackMarker)
  end

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
  cases << run("a delivered receipt with a charge id that is not an integer", event(headers: tracked(charge_id: "abc")), seed: { email_infos: [info_row(1, "sent")] })
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
def charge_cases(cases)
  charge = { id: 9, order_id: 1, seller_id: 1, created_at: "2026-01-01 00:00:00", updated_at: "2026-01-01 00:00:00" }
  link = ->(id, email_info_id, charge_id = 9) { { id:, email_info_id:, charge_id: } }
  charged = ->(id, state, **o) { info_row(id, state, purchase_id: nil, **o) }
  charged_headers = ->(**o) { tracked(charge_id: "9", purchase_id: nil, **o) }
  %w[email.delivered email.opened email.bounced email.clicked email.complained].each do |type|
    %w[sent delivered opened bounced].each do |state|
      cases << run("#{type} for a charge receipt in a #{state} row", event(type, headers: charged_headers.()), seed: { charges: [charge], email_infos: [charged.(1, state, delivered_at: ("2026-01-02 00:00:00" if %w[delivered opened].include?(state)), opened_at: ("2026-01-03 00:00:00" if state == "opened"))], email_info_charges: [link.(1, 1)] })
    end
    cases << run("#{type} for a charge receipt with no row", event(type, headers: charged_headers.()), seed: { charges: [charge] })
  end
  cases << run("a delivered charge receipt with a charge that does not exist", event(headers: charged_headers.()))
  cases << run("an opened charge receipt with a charge that does not exist", event("email.opened", headers: charged_headers.()))
  cases << run("a bounced charge receipt with a charge that does not exist", event("email.bounced", headers: charged_headers.()))
  cases << run("a delivered receipt with a charge id and a purchase id", event(headers: tracked(charge_id: "9", purchase_id: "5")), seed: { charges: [charge], email_infos: [info_row(2, "sent"), charged.(1, "sent")], email_info_charges: [link.(1, 1)] })
  cases << run("a delivered preorder receipt for a charge", event(headers: charged_headers.(mailer_method: "preorder_receipt")), seed: { charges: [charge] })
  cases << run("a delivered preorder receipt for a charge with a receipt row", event(headers: charged_headers.(mailer_method: "preorder_receipt")), seed: { charges: [charge], email_infos: [charged.(1, "sent")], email_info_charges: [link.(1, 1)] })
  cases << run("a delivered charge receipt for another charge", event(headers: charged_headers.()), seed: { charges: [charge], email_infos: [charged.(1, "sent")], email_info_charges: [link.(1, 1, 8)] })
  cases << run("a delivered charge receipt for a row of another type", event(headers: charged_headers.()), seed: { charges: [charge], email_infos: [charged.(1, "sent", type: "CreatorContactingCustomersEmailInfo")], email_info_charges: [link.(1, 1)] })
  cases << run("a delivered charge receipt for a row of another email name", event(headers: charged_headers.()), seed: { charges: [charge], email_infos: [charged.(1, "sent", email_name: "other")], email_info_charges: [link.(1, 1)] })
  cases << run("a delivered charge receipt with two sends, the event after both", event(headers: charged_headers.()), seed: { charges: [charge], email_infos: [charged.(1, "sent", sent_at: "2026-01-01 00:00:00"), charged.(2, "sent", sent_at: "2026-02-01 00:00:00")], email_info_charges: [link.(1, 1), link.(2, 2)] })
  cases << run("a delivered charge receipt with two sends, the event between them", event(headers: charged_headers.(), data: { "created_at" => "2026-01-15 00:00:00.5+00" }), seed: { charges: [charge], email_infos: [charged.(1, "sent", sent_at: "2026-01-01 00:00:00"), charged.(2, "sent", sent_at: "2026-02-01 00:00:00")], email_info_charges: [link.(1, 1), link.(2, 2)] })
  cases << run("a delivered charge receipt with two sends, the event before both", event(headers: charged_headers.(), data: { "created_at" => "2025-12-01 00:00:00+00" }), seed: { charges: [charge], email_infos: [charged.(1, "sent", sent_at: "2026-01-01 00:00:00"), charged.(2, "sent", sent_at: "2026-02-01 00:00:00")], email_info_charges: [link.(1, 1), link.(2, 2)] })
  cases << run("a delivered charge receipt with the ids out of send order", event(headers: charged_headers.()), seed: { charges: [charge], email_infos: [charged.(2, "sent", sent_at: "2026-01-01 00:00:00"), charged.(1, "sent", sent_at: "2026-02-01 00:00:00")], email_info_charges: [link.(1, 2), link.(2, 1)] })
  cases << run("a delivered charge receipt with a link to a missing row", event(headers: charged_headers.()), seed: { charges: [charge], email_info_charges: [link.(1, 5)] })
  cases << run("a delivered charge receipt with a charge id of leading zeros", event(headers: tracked(charge_id: "009", purchase_id: nil)), seed: { charges: [charge], email_infos: [charged.(1, "sent")], email_info_charges: [link.(1, 1)] })
end
charge_cases(cases)

def piracy_cases(cases)
  notice = ->(**o) { tracked(mailer_class: "PiracyReportMailer", mailer_method: "notice", mailer_args: "[4]", purchase_id: nil, **o) }
  report = ->(**o) { piracy_report_row(4, **o) }
  %w[email.delivered email.bounced email.opened email.clicked email.complained].each do |type|
    cases << run("#{type} piracy notice for a sent report", event(type, headers: notice.()), seed: piracy_seed(report.()))
    cases << run("#{type} piracy notice for a report that was delivered and failed", event(type, headers: notice.()), seed: piracy_seed(report.(delivered_at: "2026-01-03 00:00:00", delivery_failed_at: "2026-01-04 00:00:00")))
  end
  cases << run("a delivered piracy notice for a report with a delivery failure", event(headers: notice.()), seed: piracy_seed(report.(delivery_failed_at: "2026-01-04 00:00:00")))
  cases << run("a bounced piracy notice for a delivered report", event("email.bounced", headers: notice.()), seed: piracy_seed(report.(delivered_at: "2026-01-03 00:00:00")))
  cases << run("a delivered piracy notice for a report that is gone", event(headers: notice.()))
  cases << run("a delivered piracy notice for another report", event(headers: notice.()), seed: piracy_seed(report.(id: 5)))
  cases << run("a delivered piracy notice to another address", event(data: { "to" => ["other@example.com"] }, headers: notice.()), seed: piracy_seed(report.()))
  cases << run("a delivered piracy notice to the address in another case", event(data: { "to" => ["BUYER@Example.COM"] }, headers: notice.()), seed: piracy_seed(report.()))
  cases << run("a delivered piracy notice to the first of two recipients", event(data: { "to" => ["buyer@example.com", "other@example.com"] }, headers: notice.()), seed: piracy_seed(report.()))
  cases << run("a delivered piracy notice to the second of two recipients", event(data: { "to" => ["other@example.com", "buyer@example.com"] }, headers: notice.()), seed: piracy_seed(report.()))
  cases << run("a delivered piracy notice to nobody", event(data: { "to" => [] }, headers: notice.()), seed: piracy_seed(report.(sent_to_email: nil)))
  cases << run("a delivered piracy notice for a report with no recipient", event(headers: notice.()), seed: piracy_seed(report.(sent_to_email: nil)))
  cases << run("a delivered piracy notice with a recipient that is not text", event(data: { "to" => [5] }, headers: notice.()), seed: piracy_seed(report.(sent_to_email: "5")))
  cases << run("a delivered piracy notice with a non-ASCII recipient", event(data: { "to" => ["BÜYER@example.com"] }, headers: notice.()), seed: piracy_seed(report.(sent_to_email: "büyer@example.com")))
  cases << run("a delivered piracy notice with a created_at of microseconds", event(data: { "created_at" => "2026-03-04 05:06:07.891234+00" }, headers: notice.()), seed: piracy_seed(report.()))
  cases << run("a bounced piracy notice with a time zone offset", event("email.bounced", data: { "created_at" => "2026-03-04T05:06:07.891+02:00" }, headers: notice.()), seed: piracy_seed(report.()))
  cases << run("a delivered piracy notice with the report id among other text", event(headers: notice.(mailer_args: "[4, 'x9']")), seed: piracy_seed(report.()))
  cases << run("a delivered piracy notice with a bare report id", event(headers: notice.(mailer_args: "4")), seed: piracy_seed(report.()))
  cases << run("a delivered piracy notice with a report id of leading zeros", event(headers: notice.(mailer_args: "[004]")), seed: piracy_seed(report.()))
  cases << run("a delivered piracy notice with args that hold no number", event(headers: notice.(mailer_args: "[x]")), seed: piracy_seed(report.()))
  cases << run("a delivered piracy notice with no args", event(headers: notice.(mailer_args: nil)), seed: piracy_seed(report.()))
  cases << run("a delivered piracy notice with a report id too long for a plain integer", event(headers: notice.(mailer_args: "[99999999999999999999]")), seed: piracy_seed(report.()))
  cases << run("a delivered piracy notice for a report whose seller is gone", event(headers: notice.()), seed: piracy_seed(report.(), users: []))
  cases << run("a delivered piracy notice for a report whose product is gone", event(headers: notice.()), seed: piracy_seed(report.(), links: []))
  cases << run("a delivered piracy notice for a report whose seller and product are gone", event(headers: notice.()), seed: piracy_seed(report.(), users: [], links: []))
  cases << run("a bounced piracy notice for a report whose product is gone", event("email.bounced", headers: notice.()), seed: piracy_seed(report.(), links: []))
  cases << run("a delivered piracy notice for a report with a stale url digest", event(headers: notice.()), seed: piracy_seed(report.(normalized_url_digest: "0" * 64)))
  cases << run("a delivered piracy notice for a report whose url normalizes differently", event(headers: notice.()), seed: piracy_seed(report.(url: "HTTPS://Www.Example.org:443/a/b/?z=1&a=2#top")))
  cases << run("a delivered piracy notice for a report with a port", event(headers: notice.()), seed: piracy_seed(report.(url: "http://example.org:8080/a/")))
  cases << run("a delivered piracy notice for a report with an invalid url", event(headers: notice.()), seed: piracy_seed(report.(url: "ftp://example.org/a")))
  cases << run("a delivered piracy notice for a report with a url that does not parse", event(headers: notice.()), seed: piracy_seed(report.(url: "http://exa mple.org/")))
  cases << run("a delivered piracy notice for a report with a url holding another url", event(headers: notice.()), seed: piracy_seed(report.(url: "https://example.org/?u=https://other.example.net")))
  cases << run("a delivered piracy notice for a report with credentials in the url", event(headers: notice.()), seed: piracy_seed(report.(url: "https://user@example.org/")))
  cases << run("a delivered piracy notice for a report with an invalid source", event(headers: notice.()), seed: piracy_seed(report.(source: "other")))
  cases << run("a delivered piracy notice for a report with a long recipient email", event(headers: notice.()), seed: piracy_seed(report.(recipient_email: "#{"a" * 250}@example.com")))
  cases << run("a delivered piracy notice for a report with a blank state", event(headers: notice.()), seed: piracy_seed(report.(state: "")))
  %w[requested screening awaiting_signature declined signed counter_noticed resolved cancelled bogus].each do |state|
    cases << run("a delivered piracy notice for a #{state} report", event(headers: notice.()), seed: piracy_seed(report.(state:)))
  end
  cases << run("a delivered piracy notice with a purchase id too", event(headers: tracked(mailer_class: "PiracyReportMailer", mailer_method: "notice", mailer_args: "[4]")), seed: piracy_seed(report.()))
  cases << run("a delivered piracy notice with an installment id", event(headers: notice.(post_id: "12")), seed: piracy_seed(report.()))
end
piracy_cases(cases)
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
