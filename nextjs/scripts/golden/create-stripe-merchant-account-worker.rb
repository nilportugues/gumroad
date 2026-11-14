# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/create-stripe-merchant-account-worker.golden.json: CreateStripeMerchantAccountWorker run by
# the real app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). A user that exists reaches
# StripeMerchantAccountManager.create_account (Stripe), which Node hands back to Rails; those cases are recorded up to it, which a marker
# exception stands in for. Run it like pdf-unstampable-notifier-job.rb (env as in publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/create-stripe-merchant-account-worker.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[users].freeze

Rails.logger = ActiveSupport::Logger.new(nil)

class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

StripeMerchantAccountManager.singleton_class.prepend(Module.new do
  def create_account(*, **) = raise(HandBackMarker)
end)

def user_row(id, **overrides)
  { id:, email: "seller#{id}@example.com", username: "seller#{id}", external_id: (1000 + id).to_s, recommendation_type: "own_products",
    user_risk_state: "compliant", flags: 0, confirmed_at: nil, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def run(name, args, *users)
  hands_back = false
  result = capture(name, now: NOW, tables: TABLES, seed: { users: }, sidekiq: true, job: "CreateStripeMerchantAccountWorker", args:) do
    CreateStripeMerchantAccountWorker.new.perform(*args)
  rescue HandBackMarker
    hands_back = true
  end
  result.delete("rows")
  result.delete("seed")
  result.merge("hands_back" => hands_back)
end

cases = []
cases << run("a user that does not exist", [9])
cases << run("a user that does not exist among others", [9], user_row(1), user_row(2))
cases << run("a user", [1], user_row(1))
cases << run("a user among others", [2], user_row(1), user_row(2), user_row(3))
cases << run("a suspended user", [1], user_row(1, user_risk_state: "suspended_for_fraud"))
cases << run("a deleted user", [1], user_row(1, deleted_at: SEEDED_AT))
cases << run("a user id as a digit string", ["1"], user_row(1))
cases << run("a user id of nil", [nil], user_row(1))
cases << run("a user id as a float", [1.0], user_row(1))
cases << run("a user id as a word", ["one"], user_row(1))

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
