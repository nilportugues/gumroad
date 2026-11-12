# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/handle-sendgrid-event-job.golden.json: HandleSendgridEventJob run by the real app
# against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). An event the job would hand to HandleEmailEventInfo
# is what Node hands back to Rails; those cases are recorded up to that call, which a marker exception stands in for. Run it like
# publish-scheduled-post.rb:
#
#   bundle exec rails runner nextjs/scripts/golden/handle-sendgrid-event-job.rb   (env as in publish-scheduled-post.rb)
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/handle-sendgrid-event-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
TABLES = %w[preorders purchases].freeze

Rails.logger = ActiveSupport::Logger.new(nil)

class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

HandleEmailEventInfo.singleton_class.prepend(Module.new do
  def perform(*) = raise(HandBackMarker)
end)

def record_level(event = "delivered", **fields)
  { "email" => "buyer@example.com", "event" => event, "timestamp" => 1_762_000_000, "purchase_id" => 3, "mailer_class" => "CustomerMailer", "mailer_method" => "receipt", "mailer_args" => "[3]" }.merge(fields.transform_keys(&:to_s))
end

def typed(event = "delivered", **fields)
  { "email" => "buyer@example.com", "event" => event, "timestamp" => 1_762_000_000, "type" => "CustomerMailer.receipt", "identifier" => "[3]" }.merge(fields.transform_keys(&:to_s))
end

def run(name, params)
  hands_back = false
  result = capture(name, now: NOW, tables: TABLES, sidekiq: true, job: "HandleSendgridEventJob", args: [params]) do
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
cases << run("no _json key", {})
cases << run("a null _json", { "_json" => nil })
cases << run("a string for an event", { "_json" => ["x"] })
cases << run("a number for an event", { "_json" => [5] })
cases << run("a null event", { "_json" => [nil] })
cases << run("a list for an event", { "_json" => [[]] })
cases << run("a string for _json", { "_json" => "x" })

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
