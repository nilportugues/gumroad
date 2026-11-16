# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/refund-purchase-for-fraud-worker.golden.json: RefundPurchaseForFraudWorker run by the real
# app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). `Purchase.find` is the only read before the refund (a
# Stripe or PayPal refund and, with block_buyers, a buyer block); a purchase that is found is recorded up to the refund call, and a missing
# one up to the ErrorNotifier report that precedes the re-raise, each with a marker exception that Node hands back. Run it like
# pdf-unstampable-notifier-job.rb (env as in publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/refund-purchase-for-fraud-worker.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[purchases].freeze

Rails.logger = ActiveSupport::Logger.new(nil)

class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

Purchase.prepend(Module.new do
  def refund_for_fraud!(*, **) = raise(HandBackMarker)
  def refund_for_fraud_and_block_buyer!(*, **) = raise(HandBackMarker)
end)
ErrorNotifier.singleton_class.prepend(Module.new do
  def notify(*, **) = raise(HandBackMarker)
end)

def purchase_row(id, **overrides) = { id:, link_id: 1, seller_id: 1, email: "buyer#{id}@example.com", purchase_state: "successful", price_cents: 100, flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)

def run(name, args, purchases)
  hands_back = false
  result = capture(name, now: NOW, tables: TABLES, seed: { purchases: }, sidekiq: true, job: "RefundPurchaseForFraudWorker", args:) do
    RefundPurchaseForFraudWorker.new.perform(*args)
  rescue HandBackMarker
    hands_back = true
  end
  result.delete("rows")
  result.delete("seed")
  result.merge("hands_back" => hands_back)
end

P = [purchase_row(1), purchase_row(2)].freeze

cases = []
cases << run("a purchase to refund as the seller's fraud", [1, 7], P)
cases << run("a purchase to refund with the buyer blocked", [1, 7, true], P)
cases << run("a purchase to refund without blocking the buyer", [1, 7, false], P)
cases << run("a purchase among others", [2, 7], P + [purchase_row(3)])
cases << run("an already refunded purchase", [1, 7], [purchase_row(1, purchase_state: "successful", stripe_refunded: true), purchase_row(2)])
cases << run("a purchase that does not exist", [9, 7], P)
cases << run("a purchase id of zero", [0, 7], P)
cases << run("the purchase id as a digit string", ["2", 7], P)
cases << run("a purchase id of nil", [nil, 7], P)
cases << run("a purchase id as a float", [1.0, 7], P)
cases << run("a purchase id as a word", ["one", 7], P)
cases << run("no arguments", [], P)
cases << run("one argument", [1], P)
cases << run("four arguments", [1, 7, false, 1], P)

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
