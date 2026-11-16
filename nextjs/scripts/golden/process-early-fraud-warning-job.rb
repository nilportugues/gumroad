# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/process-early-fraud-warning-job.golden.json: ProcessEarlyFraudWarningJob run by the real
# app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). An unresolved warning reaches
# EarlyFraudWarning#update_from_stripe! (a Stripe read), which Node hands back to Rails; those cases are recorded up to it, which a
# marker exception stands in for. Run it like pdf-unstampable-notifier-job.rb (env as in publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/process-early-fraud-warning-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[purchase_early_fraud_warnings].freeze

Rails.logger = ActiveSupport::Logger.new(nil)

class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

EarlyFraudWarning.prepend(Module.new do
  def update_from_stripe! = raise(HandBackMarker)
end)

def warning_row(id, **overrides)
  { id:, purchase_id: id, processor_id: "issfr_#{id}", fraud_type: "fraudulent", actionable: true, charge_risk_level: "normal",
    processor_created_at: SEEDED_AT, resolution: "unknown", created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def run(name, args, *rows)
  hands_back = false
  result = capture(name, now: NOW, tables: TABLES, seed: { purchase_early_fraud_warnings: rows }, sidekiq: true, job: "ProcessEarlyFraudWarningJob", args:) do
    ProcessEarlyFraudWarningJob.new.perform(*args)
  rescue HandBackMarker
    hands_back = true
  end
  result.delete("rows")
  result.delete("seed")
  result.merge("hands_back" => hands_back)
end

cases = []
cases << run("a warning that does not exist", [9])
cases << run("a warning that does not exist among others", [9], warning_row(1), warning_row(2))
cases << run("an unresolved warning", [1], warning_row(1))
cases << run("an unresolved warning among others", [2], warning_row(1, resolved_at: SEEDED_AT), warning_row(2), warning_row(3))
cases << run("an unresolved warning that is not actionable", [1], warning_row(1, actionable: false))
EarlyFraudWarning::RESOLUTIONS.each do |resolution|
  cases << run("a warning resolved as #{resolution}", [1], warning_row(1, resolution:, resolved_at: SEEDED_AT))
end
cases << run("a resolved warning with a different resolution than its time says", [1], warning_row(1, resolution: "unknown", resolved_at: SEEDED_AT))
cases << run("a resolution without a resolved time", [1], warning_row(1, resolution: "resolved_ignored"))
cases << run("a warning id as a digit string", ["1"], warning_row(1, resolved_at: SEEDED_AT))
cases << run("an unresolved warning id as a digit string", ["1"], warning_row(1))
cases << run("a warning id of nil", [nil], warning_row(1))
cases << run("a warning id as a float", [1.0], warning_row(1))
cases << run("a warning id as a word", ["one"], warning_row(1))

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
