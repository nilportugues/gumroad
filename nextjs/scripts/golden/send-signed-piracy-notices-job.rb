# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/send-signed-piracy-notices-job.golden.json: SendSignedPiracyNoticesJob run by the real
# app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). The `piracy_reports_sending` Flipper feature is set
# before each case (`redis_before`; REDIS_HOST and SIDEKIQ_REDIS_HOST must name the same Redis database). With the feature on, a signed
# report means PiracyReports::SendService (a locked state change and the mail), which Node hands back to Rails; those cases are recorded
# up to it, which a marker exception stands in for. Run it like pdf-unstampable-notifier-job.rb (env as in publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/send-signed-piracy-notices-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[piracy_reports].freeze
FLAG = PiracyReports::SendService::FLAG

Rails.logger = ActiveSupport::Logger.new(nil)

class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

PiracyReports::SendService.prepend(Module.new do
  def call = raise(HandBackMarker)
end)

def report_row(id, state: "signed", **overrides)
  { id:, external_id: "report#{id}", seller_id: 1, product_id: id, source: "web", state:, url: "https://example.com/#{id}", normalized_url_digest: "digest#{id}",
    created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def run(name, gate, seed)
  hands_back = false
  setup = -> { enable_gate(gate) }
  result = capture(name, now: NOW, tables: TABLES, seed:, setup:, sidekiq: true, job: "SendSignedPiracyNoticesJob", args: []) do
    SendSignedPiracyNoticesJob.new.perform
  rescue HandBackMarker
    hands_back = true
  end
  result.delete("rows")
  result.delete("seed")
  result.merge("hands_back" => hands_back, "gate" => gate.to_s)
end

def enable_gate(gate)
  case gate
  when :none then nil
  when :on then Feature.activate(FLAG)
  when :off
    Feature.activate(FLAG)
    Feature.deactivate(FLAG)
  when :actors100 then Feature.activate_percentage(FLAG, 100)
  when :actors50 then Feature.activate_percentage(FLAG, 50)
  when :time100 then Flipper.enable_percentage_of_time(FLAG, 100)
  when :time50 then Flipper.enable_percentage_of_time(FLAG, 50)
  when :time0 then Flipper.enable_percentage_of_time(FLAG, 0)
  when :actor then Feature.activate_user(FLAG, User.new.tap { _1.id = 5 })
  when :on_and_time50
    Feature.activate(FLAG)
    Flipper.enable_percentage_of_time(FLAG, 50)
  end
end

def seed(*reports) = { piracy_reports: reports }

cases = []
%i[none off on actors100 actors50 time100 time0 actor on_and_time50].each do |gate|
  cases << run("the feature is #{gate} and nothing is signed", gate, seed)
  cases << run("the feature is #{gate} and a report is signed", gate, seed(report_row(1)))
end
cases << run("a signed report among others", :on, seed(report_row(1, state: "draft"), report_row(2), report_row(3, state: "sent")))
cases << run("only reports in other states", :on, seed(report_row(1, state: "draft"), report_row(2, state: "sent"), report_row(3, state: "screened")))
cases << run("the second signed report", :on, seed(report_row(1, state: "sent"), report_row(2)))

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
