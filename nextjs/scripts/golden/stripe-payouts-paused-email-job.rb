# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/stripe-payouts-paused-email-job.golden.json: StripePayoutsPausedEmailJob run by the real
# app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). Run it like delete-wishlist-products-job.rb:
#
#   bundle exec rails runner nextjs/scripts/golden/stripe-payouts-paused-email-job.rb   (env as in publish-scheduled-post.rb)
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/stripe-payouts-paused-email-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[users merchant_accounts balances purchases versions].freeze
PAUSED_INTERNALLY = 1 << 19
PAUSED_BY_USER = 1 << 40
TOKEN = "claim-token-1"

ActiveJob::Base.queue_adapter = :sidekiq
ActiveJob::Base.logger = Logger.new(nil)
$uuid_seq = 0
SecureRandom.singleton_class.prepend(Module.new do
  def uuid = format("00000000-0000-4000-8000-%012x", ($uuid_seq += 1))
end)
Rails.logger = ActiveSupport::Logger.new(nil)

def user_row(id, paused_by: "stripe", flags: PAUSED_INTERNALLY, **overrides)
  {
    id:, email: "seller#{id}@example.com", username: "seller#{id}", external_id: (1000 + id).to_s, recommendation_type: "own_products",
    user_risk_state: "compliant", flags:, json_data: paused_by ? %({"payouts_paused_by":"#{paused_by}"}) : nil,
    confirmed_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT
  }.merge(overrides)
end

def account_row(id = 1, user_id = 1, token: TOKEN, sent: "action_required", **overrides)
  data = { stripe_payouts_pause_email_sent: sent, stripe_payouts_pause_email_claim_token: token }.compact
  { id:, user_id:, charge_processor_id: "stripe", charge_processor_merchant_id: "acct_#{id}", json_data: data.to_json, country: "US", currency: "usd",
    charge_processor_alive_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def balance_row(id, amount, user_id: 1, state: "unpaid") = { id:, user_id:, date: "2026-10-01", amount_cents: amount, state:, created_at: SEEDED_AT, updated_at: SEEDED_AT }

def sale_row(id, state: "successful", seller: 1) = { id:, seller_id: seller, link_id: 1, purchase_state: state, email: "buyer@example.com", created_at: SEEDED_AT, updated_at: SEEDED_AT }

def run(name, args, seed)
  $uuid_seq = 0
  result = capture(name, now: NOW, tables: TABLES, seed:, sidekiq: true, job: "StripePayoutsPausedEmailJob", args:) do
    StripePayoutsPausedEmailJob.new.perform(*args)
  end
  result.delete("seed")
  result.delete("rows")
  result
end

def seed(user: user_row(1), account: account_row, **rest) = { users: [user], merchant_accounts: [account], **rest }

cases = []
cases << run("a user that does not exist", [9, 1, "action_required", TOKEN], { merchant_accounts: [account_row] })
cases << run("a merchant account that does not exist", [1, 9, "action_required", TOKEN], { users: [user_row(1)] })
cases << run("a stale claim token", [1, 1, "action_required", "older-token"], seed)
cases << run("an action required pause", [1, 1, "action_required", TOKEN], seed)
cases << run("the ids as digits", ["1", "1", "action_required", TOKEN], seed)
cases << run("an under review pause with a balance", [1, 1, "under_review", TOKEN], seed(balances: [balance_row(1, 500)]))
cases << run("an under review pause with a sale and no balance", [1, 1, "under_review", TOKEN], seed(purchases: [sale_row(1)]))
cases << run("an under review pause with nothing at stake", [1, 1, "under_review", TOKEN], seed)
cases << run("an under review pause with only paid balances and a failed sale", [1, 1, "under_review", TOKEN], seed(balances: [balance_row(1, 500, state: "paid")], purchases: [sale_row(1, state: "failed")]))
cases << run("an under review pause with balances that cancel out", [1, 1, "under_review", TOKEN], seed(balances: [balance_row(1, 500), balance_row(2, -500)]))
cases << run("an under review pause with a negative balance", [1, 1, "under_review", TOKEN], seed(balances: [balance_row(1, -500)]))
cases << run("an under review pause with only another seller's balance and sale", [1, 1, "under_review", TOKEN], seed(balances: [balance_row(1, 500, user_id: 2)], purchases: [sale_row(1, seller: 2)]))
cases << run("an email type nobody sends", [1, 1, "something_else", TOKEN], seed)
cases << run("a pause that resolved", [1, 1, "action_required", TOKEN], seed(user: user_row(1, flags: 0, paused_by: nil)))
cases << run("a pause by an admin", [1, 1, "action_required", TOKEN], seed(user: user_row(1, paused_by: nil)))
cases << run("a pause by the system", [1, 1, "action_required", TOKEN], seed(user: user_row(1, paused_by: "system")))
cases << run("a pause by the seller", [1, 1, "action_required", TOKEN], seed(user: user_row(1, flags: PAUSED_BY_USER, paused_by: nil)))
cases << run("a pause by both the seller and Stripe", [1, 1, "action_required", TOKEN], seed(user: user_row(1, flags: PAUSED_INTERNALLY | PAUSED_BY_USER)))
cases << run("a deleted seller", [1, 1, "action_required", TOKEN], seed(user: user_row(1, deleted_at: SEEDED_AT)))
cases << run("a suspended seller", [1, 1, "action_required", TOKEN], seed(user: user_row(1, user_risk_state: "suspended_for_fraud")))
cases << run("a claim with no token on either side", [1, 1, "action_required", nil], seed(account: account_row(token: nil)))
cases << run("a nil token against a stored token", [1, 1, "action_required", nil], seed)
cases << run("a claim whose email was not marked sent", [1, 1, "under_review", TOKEN], seed(account: account_row(sent: nil)))
cases << run("a stale claim after the pause resolved", [1, 1, "action_required", "older-token"], seed(user: user_row(1, flags: 0, paused_by: nil)))

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
