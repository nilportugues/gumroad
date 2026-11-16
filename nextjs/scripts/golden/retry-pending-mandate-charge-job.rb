# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/retry-pending-mandate-charge-job.golden.json: RetryPendingMandateChargeJob run by the real
# app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). An order that exists means Order::ConfirmService charging
# held groups through Stripe; those cases are recorded up to that point, which a marker exception stands in for. Run it like
# publish-scheduled-post.rb:
#
#   bundle exec rails runner nextjs/scripts/golden/retry-pending-mandate-charge-job.rb   (env as in publish-scheduled-post.rb)
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/retry-pending-mandate-charge-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[orders].freeze

Rails.logger = ActiveSupport::Logger.new(nil)

class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

Order::ConfirmService.singleton_class.prepend(Module.new do
  def new(*, **) = raise(HandBackMarker)
end)

def order_row(id) = { id:, purchaser_id: nil, created_at: SEEDED_AT, updated_at: SEEDED_AT }

def run(name, args, seed)
  hands_back = false
  result = capture(name, now: NOW, tables: TABLES, seed:, sidekiq: true, job: "RetryPendingMandateChargeJob", args:) do
    RetryPendingMandateChargeJob.new.perform(*args)
  rescue HandBackMarker
    hands_back = true
  end
  result.delete("rows")
  result.delete("seed")
  result.merge("hands_back" => hands_back)
end

cases = []
cases << run("an order that does not exist", [9], {})
cases << run("an order that does not exist with a buyer currency quote", [9, "quote_1"], {})
cases << run("another order only", [9], { orders: [order_row(1)] })
cases << run("an order that exists", [1], { orders: [order_row(1)] })
cases << run("an order that exists with a buyer currency quote", [1, "quote_1"], { orders: [order_row(1)] })
cases << run("an order id as a digit string", ["1"], { orders: [order_row(1)] })
cases << run("a missing order id as a digit string", ["9"], {})
cases << run("an order id of nil", [nil], { orders: [order_row(1)] })
cases << run("an order id as a float", [1.0], { orders: [order_row(1)] })
cases << run("an order id as a word", ["one"], {})

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
