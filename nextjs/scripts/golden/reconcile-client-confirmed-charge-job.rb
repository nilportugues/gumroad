# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/reconcile-client-confirmed-charge-job.golden.json: ReconcileClientConfirmedChargeJob run by
# the real app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). The three guards that open the job read the charge
# and its purchases and return; a charge that passes them reaches `recover_missing_payment_intent!` (Stripe searches), which a marker
# exception stands in for and Node hands back. Run it like pdf-unstampable-notifier-job.rb (env as in publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/reconcile-client-confirmed-charge-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[charges charge_purchases purchases].freeze
RECEIPT_SENT = 1
CLIENT_CONFIRMED = 2

Rails.logger = ActiveSupport::Logger.new(nil)

class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

ReconcileClientConfirmedChargeJob.prepend(Module.new do
  private
    def recover_missing_payment_intent!(*) = raise(HandBackMarker)
end)

def charge_row(id, flags = CLIENT_CONFIRMED) = { id:, order_id: 1, seller_id: 1, flags:, created_at: SEEDED_AT, updated_at: SEEDED_AT }
def purchase_row(id, state) = { id:, link_id: 1, seller_id: 1, email: "buyer#{id}@example.com", purchase_state: state, price_cents: 100, flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }
def link_row(charge_id, purchase_id) = { id: (charge_id * 100) + purchase_id, charge_id:, purchase_id:, created_at: SEEDED_AT, updated_at: SEEDED_AT }

def run(name, args, charges, purchases = [], links = [])
  hands_back = false
  result = capture(name, now: NOW, tables: TABLES, seed: { charges:, purchases:, charge_purchases: links }, sidekiq: true, job: "ReconcileClientConfirmedChargeJob", args:) do
    ReconcileClientConfirmedChargeJob.new.perform(*args)
  rescue HandBackMarker
    hands_back = true
  end
  result.delete("rows")
  result.delete("seed")
  result.merge("hands_back" => hands_back)
end

IN_PROGRESS = [charge_row(1)].freeze

cases = []
cases << run("a charge that does not exist", [9], IN_PROGRESS, [purchase_row(1, "in_progress")], [link_row(1, 1)])
cases << run("a charge that is not client confirmed", [1], [charge_row(1, 0)], [purchase_row(1, "in_progress")], [link_row(1, 1)])
cases << run("a charge with only the receipt flag", [1], [charge_row(1, RECEIPT_SENT)], [purchase_row(1, "in_progress")], [link_row(1, 1)])
cases << run("a client confirmed charge with no purchases", [1], IN_PROGRESS)
cases << run("a client confirmed charge whose purchases are all successful", [1], IN_PROGRESS, [purchase_row(1, "successful"), purchase_row(2, "successful")], [link_row(1, 1), link_row(1, 2)])
cases << run("a client confirmed charge whose only purchase failed", [1], IN_PROGRESS, [purchase_row(1, "failed")], [link_row(1, 1)])
cases << run("a client confirmed charge with an in progress purchase", [1], IN_PROGRESS, [purchase_row(1, "in_progress")], [link_row(1, 1)])
cases << run("a client confirmed charge with one in progress purchase among successful ones", [1], IN_PROGRESS, [purchase_row(1, "successful"), purchase_row(2, "in_progress"), purchase_row(3, "successful")], [link_row(1, 1), link_row(1, 2), link_row(1, 3)])
cases << run("a charge with both flags", [1], [charge_row(1, RECEIPT_SENT | CLIENT_CONFIRMED)], [purchase_row(1, "in_progress")], [link_row(1, 1)])
cases << run("a charge among others", [2], [charge_row(1), charge_row(2), charge_row(3)], [purchase_row(1, "in_progress"), purchase_row(2, "successful")], [link_row(1, 1), link_row(2, 2)])
cases << run("a purchase of another charge in progress", [2], [charge_row(1), charge_row(2)], [purchase_row(1, "in_progress"), purchase_row(2, "successful")], [link_row(1, 1), link_row(2, 2)])
cases << run("an attempt as the second argument", [1, 3], IN_PROGRESS, [purchase_row(1, "in_progress")], [link_row(1, 1)])
cases << run("an attempt past the retry delays", [1, 30], IN_PROGRESS, [purchase_row(1, "successful")], [link_row(1, 1)])
cases << run("the charge id as a digit string", ["1"], IN_PROGRESS, [purchase_row(1, "in_progress")], [link_row(1, 1)])
cases << run("a charge id of nil", [nil], IN_PROGRESS, [purchase_row(1, "in_progress")], [link_row(1, 1)])
cases << run("a charge id of zero", [0], IN_PROGRESS, [purchase_row(1, "in_progress")], [link_row(1, 1)])
cases << run("a charge id as a float", [1.0], IN_PROGRESS, [purchase_row(1, "in_progress")], [link_row(1, 1)])
cases << run("a charge id as a word", ["one"], IN_PROGRESS, [purchase_row(1, "in_progress")], [link_row(1, 1)])
cases << run("no arguments", [], IN_PROGRESS)
cases << run("three arguments", [1, 0, 1], IN_PROGRESS)

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
