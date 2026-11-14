# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/reverse-deferred-internal-transfer-job.golden.json: ReverseDeferredInternalTransferJob
# run by the real app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb), and the block of its
# sidekiq_retries_exhausted. A failed, returned or cancelled payment with an internal transfer reaches `Stripe::Transfer.retrieve`
# (perform) or `StripePayoutProcessor.reverse_internal_transfer_or_hold_payouts!` (the hook), both Stripe calls, which Node hands
# back; those cases are recorded up to there, which a marker exception stands in for (`hands_back`). Run it like
# pdf-unstampable-notifier-job.rb (env as in publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/reverse-deferred-internal-transfer-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[payments].freeze

Rails.logger = ActiveSupport::Logger.new(nil)

class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

Stripe::Transfer.singleton_class.prepend(Module.new do
  def retrieve(*, **) = raise(HandBackMarker)
end)
StripePayoutProcessor.singleton_class.prepend(Module.new do
  def reverse_internal_transfer_or_hold_payouts!(*, **) = raise(HandBackMarker)
end)

def payment_row(id, **overrides)
  { id:, user_id: 1, state: "failed", processor: "STRIPE", stripe_internal_transfer_id: "tr_#{id}", failure_reason: "account_closed", currency: "usd",
    flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def run(name, args, *payments, hook: false)
  hands_back = false
  extra = hook ? { hook: true } : {}
  result = capture(name, now: NOW, tables: TABLES, seed: { payments: }, sidekiq: true, job: "ReverseDeferredInternalTransferJob", args:, **extra) do
    if hook
      ReverseDeferredInternalTransferJob.sidekiq_retries_exhausted_block.call({ "args" => args }, StandardError.new("boom"))
    else
      ReverseDeferredInternalTransferJob.new.perform(*args)
    end
  rescue HandBackMarker
    hands_back = true
  end
  result.delete("rows")
  result.delete("seed")
  result.merge("hands_back" => hands_back)
end

cases = []
cases << run("a payment that does not exist", [9])
cases << run("a payment that does not exist among others", [9], payment_row(1), payment_row(2))
cases << run("a payment without an internal transfer", [1], payment_row(1, stripe_internal_transfer_id: nil))
%w[failed returned cancelled].each { |state| cases << run("a #{state} payment with an internal transfer", [1], payment_row(1, state:)) }
%w[creating processing completed reversed unclaimed].each { |state| cases << run("a #{state} payment with an internal transfer", [1], payment_row(1, state:)) }
cases << run("a failed payment among others", [2], payment_row(1), payment_row(2), payment_row(3))
cases << run("a payment id as a digit string", ["1"], payment_row(1))
cases << run("a payment id of nil", [nil], payment_row(1))
cases << run("a payment id as a float", [1.0], payment_row(1))
cases << run("a payment id as a word", ["one"], payment_row(1))
cases << run("no arguments", [], payment_row(1))
cases << run("one argument too many", [1, 1], payment_row(1))

cases << run("exhausted: a payment that does not exist", [9], payment_row(1), hook: true)
cases << run("exhausted: a payment without an internal transfer", [1], payment_row(1, stripe_internal_transfer_id: nil), hook: true)
cases << run("exhausted: a failed payment with an internal transfer", [1], payment_row(1), hook: true)
cases << run("exhausted: a completed payment with an internal transfer", [1], payment_row(1, state: "completed"), hook: true)
cases << run("exhausted: a payment among others", [2], payment_row(1), payment_row(2), hook: true)
cases << run("exhausted: a payment id of nil", [nil], payment_row(1), hook: true)
cases << run("exhausted: a payment id as a digit string", ["1"], payment_row(1), hook: true)
cases << run("exhausted: a payment id as a float", [1.0], payment_row(1), hook: true)
cases << run("exhausted: a payment id as a word", ["one"], payment_row(1), hook: true)
cases << run("exhausted: no arguments", [], payment_row(1), hook: true)

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
