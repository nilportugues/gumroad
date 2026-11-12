# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/handle-sendgrid-event-job.golden.json: HandleSendgridEventJob run by the real app
# against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). The receipt path of HandleEmailEventInfo runs for real
# (CustomerEmailInfo rows and their state machine); the installment, abandoned cart and piracy handlers, a receipt of a charge, a
# spam report on a receipt and a purchase id that is not a plain integer are what Node hands back to Rails, so those are recorded up
# to the call a marker exception stands in for. Run it like publish-scheduled-post.rb:
#
#   bundle exec rails runner nextjs/scripts/golden/handle-sendgrid-event-job.rb   (env as in publish-scheduled-post.rb)
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/handle-sendgrid-event-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
TABLES = %w[preorders purchases email_infos].freeze

Rails.logger = ActiveSupport::Logger.new(nil)

class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

[HandleEmailEventInfo::ForInstallmentEmail, HandleEmailEventInfo::ForAbandonedCartEmail, HandleEmailEventInfo::ForPiracyNotice].each do |handler|
  handler.singleton_class.prepend(Module.new do
    def perform(*) = raise(HandBackMarker)
  end)
end
HandleEmailEventInfo::ForReceiptEmail.prepend(Module.new do
  def perform = email_event_info.type == :complained ? raise(HandBackMarker) : super
end)
CustomerEmailInfo.singleton_class.prepend(Module.new do
  def find_or_initialize_for_charge(**) = raise(HandBackMarker)

  def find_or_initialize_for_purchase(purchase_id:, **)
    purchase_id.to_s.match?(/\A\d{1,15}\z/) ? super : raise(HandBackMarker)
  end
end)

def info_row(id, state, purchase_id: 3, email_name: "receipt", **overrides)
  { id:, purchase_id:, type: "CustomerEmailInfo", email_name:, state:, sent_at: "2026-01-01 00:00:00" }.merge(overrides)
end

def record_level(event = "delivered", **fields)
  { "email" => "buyer@example.com", "event" => event, "timestamp" => 1_762_000_000, "purchase_id" => 3, "mailer_class" => "CustomerMailer", "mailer_method" => "receipt", "mailer_args" => "[3]" }.merge(fields.transform_keys(&:to_s))
end

def typed(event = "delivered", **fields)
  { "email" => "buyer@example.com", "event" => event, "timestamp" => 1_762_000_000, "type" => "CustomerMailer.receipt", "identifier" => "[3]" }.merge(fields.transform_keys(&:to_s))
end

def run(name, params, seed: {})
  hands_back = false
  result = capture(name, now: NOW, tables: TABLES, seed:, sidekiq: true, job: "HandleSendgridEventJob", args: [params]) do
    HandleSendgridEventJob.new.perform(params)
  rescue HandBackMarker
    hands_back = true
  end
  result.delete("rows")
  result.delete("seed")
  result.merge("hands_back" => hands_back)
end

cases = []
cases << run("a delivered receipt", { "_json" => [record_level] })
%w[bounce open click spamreport].each { |e| cases << run("a #{e} event", { "_json" => [record_level(e)] }) }
cases << run("a delivered receipt sent as one event", { "_json" => record_level })
cases << run("an event type that is not tracked", { "_json" => [record_level("processed")] })
cases << run("an event with no type", { "_json" => [record_level(nil)] })
cases << run("an event with no mailer args", { "_json" => [record_level(mailer_args: nil)] })
cases << run("an event with blank mailer args", { "_json" => [record_level(mailer_args: "  ")] })
cases << run("an event with empty mailer args", { "_json" => [record_level(mailer_args: [])] })
cases << run("an event with no mailer class and method", { "_json" => [record_level(mailer_class: nil, mailer_method: nil)] })
cases << run("an event with no purchase", { "_json" => [record_level(purchase_id: nil)] })
cases << run("an event with no timestamp", { "_json" => [record_level.except("timestamp")] })
cases << run("an event with a null timestamp", { "_json" => [record_level(timestamp: nil)] })
cases << run("an event with a string timestamp", { "_json" => [record_level(timestamp: "1762000000")] })
cases << run("an event with a float timestamp", { "_json" => [record_level(timestamp: 1_762_000_000.5)] })
cases << run("an untracked event with a string timestamp", { "_json" => [record_level("processed", timestamp: "x")] })
cases << run("an untracked event with a null timestamp", { "_json" => [record_level("processed", timestamp: nil)] })
cases << run("an event of the old shape", { "_json" => [typed] })
cases << run("an untracked event of the old shape", { "_json" => [typed("processed")] })
cases << run("an event of the old shape whose args are not a string", { "_json" => [typed("processed", identifier: 5)] })
cases << run("an event with a type and no identifier", { "_json" => [record_level("processed", type: "CustomerMailer.receipt")] })
cases << run("an event with an identifier and no type", { "_json" => [record_level("processed", identifier: "[3]")] })
cases << run("an untracked event with a type that is not a string", { "_json" => [typed("processed", type: 5)] })
cases << run("no events", { "_json" => [] })
cases << run("a list of untracked events", { "_json" => [record_level("processed"), record_level("processed", mailer_args: nil)] })
cases << run("an untracked event before a tracked one", { "_json" => [record_level("processed"), record_level] })
cases << run("a tracked event before an untracked one", { "_json" => [record_level, record_level("processed")] })
def receipt_cases(cases)
  %w[delivered open bounce click spamreport].each do |type|
    cases << run("a #{type} receipt event with no row", { "_json" => [record_level(type)] })
    cases << run("a #{type} receipt event for a sent row", { "_json" => [record_level(type)] }, seed: { email_infos: [info_row(1, "sent")] })
    cases << run("a #{type} receipt event of the old shape for a sent row", { "_json" => [typed(type)] }, seed: { email_infos: [info_row(1, "sent")] })
  end
  %w[created delivered opened bounced].each do |state|
    %w[delivered open bounce].each { |type| cases << run("a #{type} receipt event for a #{state} row", { "_json" => [record_level(type)] }, seed: { email_infos: [info_row(1, state, delivered_at: ("2026-01-02 00:00:00" if %w[delivered opened].include?(state)), opened_at: ("2026-01-03 00:00:00" if state == "opened"))] }) }
  end
  cases << run("a delivered receipt event without a timestamp", { "_json" => [record_level.except("timestamp")] }, seed: { email_infos: [info_row(1, "sent")] })
  cases << run("a delivered receipt event with a float timestamp", { "_json" => [record_level(timestamp: 1_762_000_000.75)] }, seed: { email_infos: [info_row(1, "sent")] })
  cases << run("a delivered receipt event before the send", { "_json" => [record_level(timestamp: 1_700_000_000)] }, seed: { email_infos: [info_row(1, "sent", sent_at: "2026-01-01 00:00:00"), info_row(2, "sent", sent_at: "2026-02-01 00:00:00")] })
  cases << run("a delivered receipt event between two sends", { "_json" => [record_level(timestamp: 1_768_000_000)] }, seed: { email_infos: [info_row(1, "sent", sent_at: "2026-01-01 00:00:00"), info_row(2, "sent", sent_at: "2026-02-01 00:00:00")] })
  cases << run("a delivered receipt event with a purchase id as a string", { "_json" => [record_level(purchase_id: "3")] }, seed: { email_infos: [info_row(1, "sent")] })
  cases << run("a delivered receipt event with a purchase id that is not an integer", { "_json" => [record_level(purchase_id: "x")] })
  cases << run("a delivered receipt event with a float purchase id", { "_json" => [record_level(purchase_id: 3.5)] })
  cases << run("a delivered receipt event with a negative purchase id", { "_json" => [record_level(purchase_id: -3)] })
  cases << run("a delivered receipt event with a charge id", { "_json" => [record_level(charge_id: 9)] }, seed: { email_infos: [info_row(1, "sent")] })
  cases << run("a delivered receipt event with a zero charge id", { "_json" => [record_level(charge_id: 0)] })
  cases << run("a delivered receipt event with a blank charge id", { "_json" => [record_level(charge_id: "")] }, seed: { email_infos: [info_row(1, "sent")] })
  cases << run("a delivered preorder receipt event", { "_json" => [record_level(mailer_method: "preorder_receipt", mailer_args: "[8]")] }, seed: { email_infos: [info_row(1, "sent", email_name: "preorder_receipt")] })
  cases << run("a delivered preorder receipt event of the old shape", { "_json" => [typed(type: "CustomerMailer.preorder_receipt", identifier: "[8]")] })
  cases << run("a delivered event of the old shape with a type without a method", { "_json" => [typed(type: "CustomerMailer")] })
  cases << run("a delivered event of the old shape with identifier words", { "_json" => [typed(identifier: "abc")] })
  cases << run("a delivered event of the old shape with a spaced identifier", { "_json" => [typed(identifier: " [ 3 , 4 ]")] }, seed: { email_infos: [info_row(1, "sent")] })
  cases << run("a delivered event of the old shape with a negative identifier", { "_json" => [typed(identifier: "[-3]")] })
  cases << run("a delivered event of the old shape with a leading comma", { "_json" => [typed(identifier: "[,3]")] }, seed: { email_infos: [info_row(1, "sent", purchase_id: 0)] })
  cases << run("a delivered event of another mailer", { "_json" => [record_level(mailer_class: "OtherMailer")] })
  cases << run("a delivered event whose mailer class is not a string", { "_json" => [record_level(mailer_class: 5)] })
  cases << run("a delivered event whose mailer method is not a string", { "_json" => [record_level(mailer_method: ["receipt"])] })
  cases << run("a delivered event of a mailer method in another case", { "_json" => [record_level(mailer_method: "Receipt")] })
  cases << run("a delivered abandoned cart event", { "_json" => [record_level(mailer_method: "abandoned_cart", mailer_args: "[3, {\"5\"=>[1]}]")] })
  cases << run("a delivered piracy notice event", { "_json" => [record_level(mailer_class: "PiracyReportMailer", mailer_method: "notice", mailer_args: "[4]")] })
  cases << run("a delivered receipt event with an installment id", { "_json" => [record_level(installment_id: 12)] })
  cases << run("a delivered receipt event with a blank installment id", { "_json" => [record_level(installment_id: "")] }, seed: { email_infos: [info_row(1, "sent")] })
  cases << run("a delivered receipt event with a null installment id", { "_json" => [record_level(installment_id: nil)] }, seed: { email_infos: [info_row(1, "sent")] })
  cases << run("a delivered receipt event with a zero installment id", { "_json" => [record_level(installment_id: 0)] })
  cases << run("a delivered event of another mailer with an installment id", { "_json" => [record_level(mailer_class: "OtherMailer", installment_id: 12)] })
  cases << run("a delivered purchase installment event", { "_json" => [record_level(mailer_class: "CustomerMailer", mailer_method: "purchase_installment", installment_id: 12)] })
  cases << run("two receipt events for two purchases", { "_json" => [record_level, record_level("open", purchase_id: 4)] }, seed: { email_infos: [info_row(1, "sent"), info_row(2, "sent", purchase_id: 4)] })
  cases << run("two receipt events for one purchase", { "_json" => [record_level, record_level("open")] }, seed: { email_infos: [info_row(1, "sent")] })
  cases << run("a delivered and an opened event, opened first", { "_json" => [record_level("open"), record_level] }, seed: { email_infos: [info_row(1, "sent")] })
  cases << run("a receipt event followed by an installment event", { "_json" => [record_level, record_level(installment_id: 12)] }, seed: { email_infos: [info_row(1, "sent")] })
  cases << run("a receipt event followed by a charge receipt", { "_json" => [record_level, record_level(charge_id: 9)] }, seed: { email_infos: [info_row(1, "sent")] })
  cases << run("a receipt event followed by a string timestamp", { "_json" => [record_level, record_level(timestamp: "x")] }, seed: { email_infos: [info_row(1, "sent")] })
  cases << run("a receipt event followed by an untracked one", { "_json" => [record_level, record_level("processed")] }, seed: { email_infos: [info_row(1, "sent")] })
  cases << run("a receipt event as one event", { "_json" => record_level("open") }, seed: { email_infos: [info_row(1, "sent")] })
end
receipt_cases(cases)

cases << run("no _json key", {})
cases << run("a null _json", { "_json" => nil })
cases << run("a string for an event", { "_json" => ["x"] })
cases << run("a number for an event", { "_json" => [5] })
cases << run("a null event", { "_json" => [nil] })
cases << run("a list for an event", { "_json" => [[]] })
cases << run("a string for _json", { "_json" => "x" })

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
