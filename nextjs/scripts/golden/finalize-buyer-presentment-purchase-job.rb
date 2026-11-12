# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/finalize-buyer-presentment-purchase-job.golden.json: FinalizeBuyerPresentmentPurchaseJob run
# by the real app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). A purchase that is in progress is checked
# for settlement data (charge, flow of funds, merchant account reads) and synced with Stripe, which Node hands back to Rails; those cases
# are recorded up to the check, which a marker exception stands in for. Run it like pdf-unstampable-notifier-job.rb (env as in
# publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/finalize-buyer-presentment-purchase-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[purchases].freeze

Rails.logger = ActiveSupport::Logger.new(nil)

class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

Purchase.prepend(Module.new do
  def pending_processor_settlement? = in_progress? ? raise(HandBackMarker) : super
end)

def purchase_row(id, **overrides)
  { id:, link_id: 1, seller_id: 1, email: "buyer#{id}@example.com", purchase_state: "successful", price_cents: 100, flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def run(name, args, *purchases)
  hands_back = false
  result = capture(name, now: NOW, tables: TABLES, seed: { purchases: }, sidekiq: true, job: "FinalizeBuyerPresentmentPurchaseJob", args:) do
    FinalizeBuyerPresentmentPurchaseJob.new.perform(*args)
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
Purchase.state_machines[:purchase_state].states.map { _1.name.to_s }.each do |state|
  cases << run("a #{state} purchase", [1], purchase_row(1, purchase_state: state))
end
cases << run("a purchase without a state", [1], purchase_row(1, purchase_state: nil))
cases << run("an in-progress purchase among others", [2], purchase_row(1), purchase_row(2, purchase_state: "in_progress"), purchase_row(3, purchase_state: "in_progress"))
cases << run("an in-progress purchase on a later attempt", [1, 3], purchase_row(1, purchase_state: "in_progress"))
cases << run("a successful purchase on a later attempt", [1, 3], purchase_row(1))
cases << run("a purchase id as a digit string", ["1"], purchase_row(1))
cases << run("an in-progress purchase id as a digit string", ["1"], purchase_row(1, purchase_state: "in_progress"))
cases << run("a purchase id of nil", [nil], purchase_row(1))
cases << run("a purchase id as a float", [1.0], purchase_row(1))
cases << run("a purchase id as a word", ["one"], purchase_row(1))
cases << run("no arguments", [], purchase_row(1))
cases << run("one argument too many", [1, 0, 0], purchase_row(1))

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
