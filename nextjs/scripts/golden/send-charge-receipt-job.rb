# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/send-charge-receipt-job.golden.json: SendChargeReceiptJob run by the real app against a
# scratch database as a Sidekiq job (support/sidekiq_executor.rb). A charge whose receipt is not sent yet means reading its purchases,
# stamping and delivering mail; those cases are recorded up to `Charge#purchases`, which a marker exception stands in for. Run it like
# publish-scheduled-post.rb:
#
#   bundle exec rails runner nextjs/scripts/golden/send-charge-receipt-job.rb   (env as in publish-scheduled-post.rb)
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/send-charge-receipt-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[charges].freeze
RECEIPT_SENT = 1

Rails.logger = ActiveSupport::Logger.new(nil)

class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

Charge.prepend(Module.new do
  def purchases = raise(HandBackMarker)
end)

def charge_row(id, **overrides) = { id:, order_id: id, seller_id: 7, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)

def run(name, args, seed)
  hands_back = false
  result = capture(name, now: NOW, tables: TABLES, seed:, sidekiq: true, job: "SendChargeReceiptJob", args:) do
    SendChargeReceiptJob.new.perform(*args)
  rescue HandBackMarker
    hands_back = true
  end
  result.delete("rows")
  result.delete("seed")
  result.merge("hands_back" => hands_back)
end

cases = []
cases << run("a charge that does not exist", [9], {})
cases << run("a charge whose receipt is sent", [1], { charges: [charge_row(1, flags: RECEIPT_SENT)] })
cases << run("a charge whose receipt is sent on a later attempt", [1, 3], { charges: [charge_row(1, flags: RECEIPT_SENT)] })
cases << run("a charge whose receipt is sent with other flags set", [1], { charges: [charge_row(1, flags: RECEIPT_SENT | 2)] })
cases << run("a charge whose receipt is not sent", [1], { charges: [charge_row(1)] })
cases << run("a charge with only another flag set", [1], { charges: [charge_row(1, flags: 2)] })
cases << run("a charge whose receipt is not sent on a later attempt", [1, 2], { charges: [charge_row(1)] })
cases << run("a charge id as a digit string", ["1"], { charges: [charge_row(1, flags: RECEIPT_SENT)] })
cases << run("a charge id of nil", [nil], {})
cases << run("a charge id as a float", [1.0], {})
cases << run("a charge id as a word", ["one"], {})

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
