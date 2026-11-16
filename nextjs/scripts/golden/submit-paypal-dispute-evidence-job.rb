# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/submit-paypal-dispute-evidence-job.golden.json: SubmitPaypalDisputeEvidenceJob run by the
# real app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). The :submit_paypal_dispute_evidence Flipper feature
# is set in `setup` (`redis_before`). The job ends on the feature and on the four guards that read the dispute row; a dispute that passes
# them goes on to load its purchases, the evidence notes and PayPal, so those cases are recorded up to `Dispute#purchases`, which a marker
# exception stands in for and Node hands back. Run it like pdf-unstampable-notifier-job.rb (env as in publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/submit-paypal-dispute-evidence-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[disputes].freeze
FLAG = SubmitPaypalDisputeEvidenceJob::FEATURE_FLAG

Rails.logger = ActiveSupport::Logger.new(nil)

class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

Dispute.prepend(Module.new do
  def purchases = raise(HandBackMarker)
end)

def dispute_row(id, **overrides) = { id:, purchase_id: 1, charge_processor_id: "paypal", charge_processor_dispute_id: "PP-D-#{id}", state: "initiated", seller_id: 1, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)

def run(name, args, disputes, flag: :on)
  setup = lambda do
    case flag
    when :on then Feature.activate(FLAG)
    when :off then Feature.activate(FLAG).then { Feature.deactivate(FLAG) }
    when :time50 then Flipper.enable_percentage_of_time(FLAG, 50)
    when :time100 then Flipper.enable_percentage_of_time(FLAG, 100)
    when :actors100 then Feature.activate_percentage(FLAG, 100)
    end
  end
  hands_back = false
  result = capture(name, now: NOW, tables: TABLES, seed: { disputes: }, setup:, sidekiq: true, job: "SubmitPaypalDisputeEvidenceJob", args:) do
    SubmitPaypalDisputeEvidenceJob.new.perform(*args)
  rescue HandBackMarker
    hands_back = true
  end
  result.delete("rows")
  result.delete("seed")
  result.merge("hands_back" => hands_back)
end

D = [dispute_row(1)].freeze

cases = []
cases << run("a dispute to answer", [1], D)
cases << run("a dispute among others", [2], D + [dispute_row(2)])
cases << run("the feature off", [1], D, flag: :off)
cases << run("the feature never set", [1], D, flag: nil)
cases << run("the feature at 100 percent of time", [1], D, flag: :time100)
cases << run("the feature at 100 percent of actors", [1], D, flag: :actors100)
cases << run("the feature at 50 percent of time", [1], D, flag: :time50)
cases << run("a dispute of another processor", [1], [dispute_row(1, charge_processor_id: "stripe")])
cases << run("a dispute without a processor dispute id", [1], [dispute_row(1, charge_processor_dispute_id: nil)])
cases << run("a dispute with a blank processor dispute id", [1], [dispute_row(1, charge_processor_dispute_id: "")])
cases << run("a dispute won", [1], [dispute_row(1, won_at: SEEDED_AT)])
cases << run("a dispute lost", [1], [dispute_row(1, lost_at: SEEDED_AT)])
cases << run("a dispute that does not exist", [9], D)
cases << run("a dispute that does not exist with the feature off", [9], D, flag: :off)
cases << run("a dispute id of zero", [0], D)
cases << run("the dispute id as a digit string", ["1"], D)
cases << run("a dispute id of nil", [nil], D)
cases << run("a dispute id as a float", [1.0], D)
cases << run("a dispute id as a word", ["one"], D)
cases << run("no arguments", [], D)
cases << run("two arguments", [1, 2], D)

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
