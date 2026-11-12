# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/stamp-pdf-for-purchase-job.golden.json: StampPdfForPurchaseJob run by the real app against
# a scratch database as a Sidekiq job (support/sidekiq_executor.rb). `Purchase.find` is the only read before the stamping (object
# storage and PDF work); a purchase reaches `PdfStampingService.stamp_for_purchase!`, which Node hands back, recorded up to there with
# a marker exception (`hands_back`). Run it like pdf-unstampable-notifier-job.rb (env as in publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/stamp-pdf-for-purchase-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[purchases].freeze

Rails.logger = ActiveSupport::Logger.new(nil)

class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

PdfStampingService.singleton_class.prepend(Module.new do
  def stamp_for_purchase!(*, **) = raise(HandBackMarker)
end)

def purchase_row(id, **overrides)
  { id:, link_id: 1, seller_id: 1, email: "buyer#{id}@example.com", purchase_state: "successful", price_cents: 100, flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def run(name, args, *purchases)
  hands_back = false
  result = capture(name, now: NOW, tables: TABLES, seed: { purchases: }, sidekiq: true, job: "StampPdfForPurchaseJob", args:) do
    StampPdfForPurchaseJob.new.perform(*args)
  rescue HandBackMarker
    hands_back = true
  end
  result.delete("rows")
  result.delete("seed")
  result.merge("hands_back" => hands_back)
end

cases = []
cases << run("a purchase that does not exist", [9])
cases << run("a purchase that does not exist among others", [9], purchase_row(1), purchase_row(2))
cases << run("a purchase", [1], purchase_row(1))
cases << run("a purchase among others", [2], purchase_row(1), purchase_row(2), purchase_row(3))
cases << run("a purchase with the notify flag", [1, true], purchase_row(1))
cases << run("a missing purchase with the notify flag", [9, true], purchase_row(1))
cases << run("a purchase id as a digit string", ["1"], purchase_row(1))
cases << run("a purchase id of nil", [nil], purchase_row(1))
cases << run("a purchase id as a float", [1.0], purchase_row(1))
cases << run("a purchase id as a word", ["one"], purchase_row(1))
cases << run("no arguments", [], purchase_row(1))
cases << run("one argument too many", [1, true, 1], purchase_row(1))

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
