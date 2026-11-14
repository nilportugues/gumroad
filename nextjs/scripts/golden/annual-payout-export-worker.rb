# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/annual-payout-export-worker.golden.json: AnnualPayoutExportWorker run by the real app
# against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). `User.find` is the only read before
# `WithMaxExecutionTime.timeout_queries` (a session `set max_execution_time` on two connections, which a pooled Node connection cannot
# hold), then come the payments scan, the attachment and the mail. Every user that is found reaches it, recorded up to there with a
# marker exception, and Node hands those back. Run it like pdf-unstampable-notifier-job.rb (env as in publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/annual-payout-export-worker.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[users payments].freeze

Rails.logger = ActiveSupport::Logger.new(nil)

class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

WithMaxExecutionTime.singleton_class.prepend(Module.new do
  def timeout_queries(*, **) = raise(HandBackMarker)
end)

def user_row(id, **overrides)
  { id:, email: "seller#{id}@example.com", username: "seller#{id}", external_id: (1000 + id).to_s, recommendation_type: "own_products",
    user_risk_state: "compliant", flags: 0, confirmed_at: nil, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def payment_row(id, user_id, created_at, **overrides)
  { id:, user_id:, state: "completed", flags: 0, amount_cents: 1000, currency: "usd", processor: "STRIPE", created_at:, updated_at: created_at }.merge(overrides)
end

def run(name, args, users, payments = [])
  hands_back = false
  result = capture(name, now: NOW, tables: TABLES, seed: { users:, payments: }, sidekiq: true, job: "AnnualPayoutExportWorker", args:) do
    AnnualPayoutExportWorker.new.perform(*args)
  rescue HandBackMarker
    hands_back = true
  end
  result.delete("rows")
  result.delete("seed")
  result.merge("hands_back" => hands_back)
end

U = [user_row(1), user_row(2)].freeze

cases = []
cases << run("a seller that does not exist", [9, 2025], U)
cases << run("a seller with no payments", [1, 2025], U)
cases << run("a seller with a payment in the year", [1, 2025], U, [payment_row(1, 1, "2025-06-01 10:00:00")])
cases << run("a seller with a payment in the year, to send the email", [1, 2025, true], U, [payment_row(1, 1, "2025-06-01 10:00:00")])
cases << run("a seller with a payment in the year, without the email", [1, 2025, false], U, [payment_row(1, 1, "2025-06-01 10:00:00")])
cases << run("a seller among others", [2, 2025], [user_row(1), user_row(2), user_row(3)])
cases << run("a deleted seller", [1, 2025], [user_row(1, deleted_at: SEEDED_AT), user_row(2)])
cases << run("the seller id as a digit string", ["2", 2025], U)
cases << run("a seller id of nil", [nil, 2025], U)
cases << run("a seller id as a float", [1.0, 2025], U)
cases << run("a seller id as a word", ["one", 2025], U)
cases << run("the year as a digit string", [1, "2025"], U)
cases << run("the year as a float", [1, 2025.0], U)
cases << run("the year as nil", [1, nil], U)
cases << run("year zero", [1, 0], U)
cases << run("a negative year", [1, -5], U)
cases << run("a five digit year", [1, 12_025], U)
cases << run("a three digit year", [1, 999], U)
cases << run("no arguments", [], U)
cases << run("one argument", [1], U)
cases << run("four arguments", [1, 2025, false, 1], U)

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
