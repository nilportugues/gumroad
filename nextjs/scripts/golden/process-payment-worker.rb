# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/process-payment-worker.golden.json: ProcessPaymentWorker run by the real app against
# a scratch database as a Sidekiq job (support/sidekiq_executor.rb). A processing payment would be sent to its payout processor
# (Stripe or PayPal); the processors are replaced here by a recorder, so nothing leaves the machine, and the golden keeps what they
# were asked under `processed` (processor key and payment ids). Run it like expiring-credit-card-message-worker.rb
# (env as in publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases
capture_http!

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/process-payment-worker.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[payments].freeze

Rails.logger = ActiveSupport::Logger.new(nil)

$processed = []
recorder = Class.new do
  def initialize(key) = @key = key
  def process_payments(payments) = $processed << [@key, payments.map(&:id)]
end
PayoutProcessorType.singleton_class.prepend(Module.new do
  define_method(:get) { |processor| recorder.new(processor) }
end)

abort "payout processors are not stubbed" unless PayoutProcessorType.get("STRIPE").is_a?(recorder)

def payment_row(id, state, **overrides) = { id:, user_id: 1, state:, processor: "STRIPE", amount_cents: 1000, currency: "usd", flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)

def run(name, args, rows)
  $processed = []
  result = capture(name, now: NOW, tables: TABLES, seed: { payments: rows }, sidekiq: true, job: "ProcessPaymentWorker", args:) do
    ProcessPaymentWorker.new.perform(*args)
  end
  result.delete("seed")
  result.merge("processed" => $processed.dup)
end

cases = []
cases << run("a payment that does not exist", [99], [])
cases << run("a payment id of nil", [nil], [payment_row(1, "processing")])
cases << run("a payment id given as a digit string", ["1"], [payment_row(1, "processing")])
cases << run("a payment id given as a float", [1.0], [payment_row(1, "processing")])
cases << run("a payment id given as a word", ["abc"], [payment_row(1, "processing")])
Payment.state_machine.states.map { _1.name.to_s }.each do |state|
  cases << run("a #{state} payment", [1], [payment_row(1, state)])
end
cases << run("a payment with no state", [1], [payment_row(1, nil)])
cases << run("a state the machine does not know", [1], [payment_row(1, "mystery")])
cases << run("a processing paypal payment", [1], [payment_row(1, "processing", processor: "PAYPAL")])
cases << run("a processing payment with no processor", [1], [payment_row(1, "processing", processor: nil)])
cases << run("a processing payment of another processor", [1], [payment_row(1, "processing", processor: "WIRE")])
cases << run("another payment is processing", [2], [payment_row(1, "processing"), payment_row(2, "failed")])

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
