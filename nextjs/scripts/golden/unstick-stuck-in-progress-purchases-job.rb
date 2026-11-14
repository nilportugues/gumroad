# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/unstick-stuck-in-progress-purchases-job.golden.json: UnstickStuckInProgressPurchasesJob run
# by the real app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). A purchase to recover means the charge
# processor, and an aged-out one means a Sentry report: Node hands both back, so those cases are recorded up to there, where a marker
# exception stands in for the first Purchase#can_force_update? and for ErrorNotifier.notify. Run it like publish-scheduled-post.rb
# (env as there):
#
#   bundle exec rails runner nextjs/scripts/golden/unstick-stuck-in-progress-purchases-job.rb
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/unstick-stuck-in-progress-purchases-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[purchases].freeze
DAY = 86_400

Rails.logger = ActiveSupport::Logger.new(nil)

class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

Purchase.prepend(Module.new do
  def can_force_update? = raise(HandBackMarker)
end)
ErrorNotifier.singleton_class.prepend(Module.new do
  def notify(*, **) = raise(HandBackMarker)
end)

def at(time) = time.utc.strftime("%Y-%m-%d %H:%M:%S.%6N")

def purchase_row(id, age_days, **overrides)
  { id:, link_id: 1, seller_id: 1, purchase_state: "in_progress", charge_processor_id: "stripe", price_cents: 500, displayed_price_cents: 500, flags: 0,
    created_at: at(NOW - age_days * DAY), updated_at: SEEDED_AT }.merge(overrides)
end

def run(name, args, *purchases)
  hands_back = false
  result = capture(name, now: NOW, tables: TABLES, seed: { purchases: }, sidekiq: true, job: "UnstickStuckInProgressPurchasesJob", args:) do
    UnstickStuckInProgressPurchasesJob.new.perform(*args)
  rescue HandBackMarker
    hands_back = true
  end
  result.delete("rows")
  result.delete("seed")
  result.merge("hands_back" => hands_back)
end

cases = []
cases << run("nothing in progress", [])
cases << run("a purchase inside the window", [], purchase_row(1, 5))
cases << run("a purchase younger than the window", [], purchase_row(1, 1))
cases << run("a purchase exactly at the lower bound", [], purchase_row(1, 3))
cases << run("a purchase just inside the lower bound", [], purchase_row(1, 3.0001))
cases << run("a purchase exactly at the upper bound", [], purchase_row(1, 90))
cases << run("a purchase older than the window and its grace", [], purchase_row(1, 100))
cases << run("a purchase that is not in progress", [], purchase_row(1, 5, purchase_state: "successful"))
cases << run("a purchase ageing out", [], purchase_row(1, 92))
cases << run("a purchase at the end of the grace", [], purchase_row(1, 97))
cases << run("a purchase past the grace", [], purchase_row(1, 98))
cases << run("a purchase ageing out without a processor", [], purchase_row(1, 92, charge_processor_id: nil))
cases << run("a free purchase ageing out", [], purchase_row(1, 92, price_cents: 0))
cases << run("a purchase ageing out that is not in progress", [], purchase_row(1, 92, purchase_state: "failed"))
cases << run("a purchase inside the window and one ageing out", [], purchase_row(1, 5), purchase_row(2, 92))
cases << run("one hundred and one purchases inside the window", [], *(1..101).map { |id| purchase_row(id, 5) })
cases << run("explicit ids with a purchase", [[1]], purchase_row(1, 1))
cases << run("explicit ids of a purchase that is not in progress", [[1]], purchase_row(1, 5, purchase_state: "successful"))
cases << run("explicit ids of a missing purchase", [[999]])
cases << run("explicit ids of a purchase ageing out", [[1]], purchase_row(1, 92))
cases << run("explicit ids with an empty list", [[]], purchase_row(1, 5))
cases << run("explicit ids in descending order", [[2, 1]], purchase_row(1, 1), purchase_row(2, 1))
cases << run("explicit ids with a repeat", [[1, 1]], purchase_row(1, 1))
cases << run("explicit ids with a missing one first", [[999, 1]], purchase_row(1, 1))
cases << run("explicit ids as nil", [nil], purchase_row(1, 5))
cases << run("explicit ids as a single id", [1], purchase_row(1, 5))
cases << run("explicit ids as digit strings", [%w[1]], purchase_row(1, 5))
cases << run("explicit ids with a nil", [[nil]], purchase_row(1, 5))
cases << run("explicit ids with a float", [[1.0]], purchase_row(1, 5))
cases << run("explicit ids with a word", [%w[one]], purchase_row(1, 5))

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
