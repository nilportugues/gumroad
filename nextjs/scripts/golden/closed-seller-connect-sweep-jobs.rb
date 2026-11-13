# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/closed-seller-connect-sweep-jobs.golden.json: SweepClosedSellerConnectAccountsJob and
# AlertOnStripeDobDriftJob run by the real app as Sidekiq jobs (support/sidekiq_executor.rb). Both page through merchant accounts with a
# Redis cursor and read Stripe for each candidate. A run with candidates is recorded up to the first call the port does not make
# (`evaluate`, which reads Stripe, in the sweep; `Stripe::Account.retrieve` in the drift alert), which a marker exception stands in for and
# `hands_back` records; Node hands those runs back before writing the cursor. Run it like production-only-jobs.rb.
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/closed-seller-connect-sweep-jobs.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[users merchant_accounts].freeze

Rails.logger = ActiveSupport::Logger.new(nil)
ActiveJob::Base.queue_adapter = :sidekiq
ActiveJob::Base.logger = Logger.new(nil)

class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

SweepClosedSellerConnectAccountsJob.prepend(Module.new do
  private

  def evaluate(*, **) = raise(HandBackMarker)
end)
Stripe::Account.singleton_class.prepend(Module.new do
  def retrieve(*, **) = raise(HandBackMarker)
end)

def user_row(id, **overrides)
  { id:, email: "user#{id}@example.com", username: "user#{id}", external_id: (1000 + id).to_s, user_risk_state: "compliant",
    confirmed_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def account_row(id, user: 1, **overrides)
  { id:, user_id: user, charge_processor_id: "stripe", charge_processor_merchant_id: "acct_#{id}", charge_processor_alive_at: SEEDED_AT, json_data: nil,
    created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

CLOSED = { users: [user_row(1, deleted_at: SEEDED_AT)], merchant_accounts: [account_row(1)] }.freeze
LIVE = { users: [user_row(1)], merchant_accounts: [account_row(1)] }.freeze

def run(klass, name, seed, cursor: nil, args: [])
  hands_back = false
  setup = -> { $redis.set(klass == SweepClosedSellerConnectAccountsJob ? RedisKey.closed_seller_connect_sweep_cursor : RedisKey.stripe_dob_drift_sweep_cursor, cursor) unless cursor.nil? }
  result = capture(name, now: NOW, tables: TABLES, seed:, setup:, sidekiq: true, job: klass.name, args:, at: NOW.to_f) do
    klass.new.perform(*args)
  rescue HandBackMarker
    hands_back = true
  end
  result.delete("seed")
  result.delete("rows")
  result.merge("hands_back" => hands_back)
end

cases = []
{
  SweepClosedSellerConnectAccountsJob => {
    "no accounts at all" => [{}, nil],
    "a closed seller's account" => [CLOSED, nil],
    "a closed seller's account after the cursor" => [CLOSED, 0],
    "a closed seller's account before the cursor" => [CLOSED, 1],
    "a closed seller's account with the cursor past it" => [CLOSED, 7],
    "a live seller's account" => [LIVE, nil],
    "a live seller's account with the cursor past it" => [LIVE, 7],
    "a deleted seller with no account" => [{ users: CLOSED[:users] }, nil],
    "a closed seller's account with no stripe id" => [CLOSED.merge(merchant_accounts: [account_row(1, charge_processor_merchant_id: nil)]), nil],
    "a closed seller's account whose processor was deleted" => [CLOSED.merge(merchant_accounts: [account_row(1, charge_processor_deleted_at: SEEDED_AT)]), nil],
    "a closed seller's paypal account" => [CLOSED.merge(merchant_accounts: [account_row(1, charge_processor_id: "paypal")]), nil],
    "a closed seller's connect account" => [CLOSED.merge(merchant_accounts: [account_row(1, json_data: JSON.generate(meta: { stripe_connect: "true" }))]), nil],
    "a closed seller's account retired by adoption" => [CLOSED.merge(merchant_accounts: [account_row(1, json_data: JSON.generate(retired_by_adoption_at: SEEDED_AT))]), nil],
    "a closed seller's account whose processor is not alive" => [CLOSED.merge(merchant_accounts: [account_row(1, charge_processor_alive_at: nil)]), nil],
    "a closed seller's gumroad-owned account" => [CLOSED.merge(merchant_accounts: [account_row(1, user: nil)]), nil],
    "an account of another seller's connect" => [CLOSED.merge(merchant_accounts: [account_row(1, json_data: JSON.generate(meta: { stripe_connect: "true" })), account_row(2)]), nil],
    "a cursor of zero" => [{}, 0],
    "a cursor that is not a number" => [{}, "abc"],
    "a cursor of a number and a word" => [{}, "12abc"],
    "a negative cursor" => [CLOSED, -5],
    "a blank cursor" => [CLOSED, ""],
    "a cursor with leading whitespace" => [CLOSED, " 7"],
    "a fractional cursor" => [CLOSED, "0.9"],
    "a huge cursor" => [{}, "99999999999999999999"],
  },
  AlertOnStripeDobDriftJob => {
    "no accounts at all" => [{}, nil],
    "a live seller's account" => [LIVE, nil],
    "a live seller's account after the cursor" => [LIVE, 0],
    "a live seller's account with the cursor past it" => [LIVE, 7],
    "a closed seller's account" => [CLOSED, nil],
    "an account with no user" => [LIVE.merge(merchant_accounts: [account_row(1, user: nil)]), nil],
    "an account that is deleted" => [LIVE.merge(merchant_accounts: [account_row(1, deleted_at: SEEDED_AT)]), nil],
    "an account whose processor was deleted" => [LIVE.merge(merchant_accounts: [account_row(1, charge_processor_deleted_at: SEEDED_AT)]), nil],
    "an account whose processor is not alive" => [LIVE.merge(merchant_accounts: [account_row(1, charge_processor_alive_at: nil)]), nil],
    "a paypal account" => [LIVE.merge(merchant_accounts: [account_row(1, charge_processor_id: "paypal")]), nil],
    "a connect account" => [LIVE.merge(merchant_accounts: [account_row(1, json_data: JSON.generate(meta: { stripe_connect: "true" }))]), nil],
    "a connect account next to a managed one" => [LIVE.merge(merchant_accounts: [account_row(1, json_data: JSON.generate(meta: { stripe_connect: "true" })), account_row(2)]), nil],
    "a cursor that is not a number" => [{}, "abc"],
    "a negative cursor" => [LIVE, -5],
    "a blank cursor" => [LIVE, ""],
  },
}.each do |klass, scenarios|
  scenarios.each do |name, (seed, cursor)|
    cases << run(klass, "#{klass.name}: #{name}", seed, cursor:)
  end
  cases << run(klass, "#{klass.name}: an argument", LIVE, args: [1])
end

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
