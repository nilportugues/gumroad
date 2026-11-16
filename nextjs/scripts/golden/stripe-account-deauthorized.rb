# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/stripe-account-deauthorized.golden.json: HandleStripeEventWorker run by the real app
# against a scratch database as a Sidekiq job (support/sidekiq_executor.rb) for the `account.application.deauthorized` events of a
# connected account, which StripeMerchantAccountManager.handle_stripe_event_account_deauthorized handles with local writes only. The
# Stripe API key is the golden's own and nothing is stubbed in to reach Stripe, so a call would fail the case. Run it like
# stripe-payouts-paused-email-job.rb (env as in publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/stripe-account-deauthorized.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[users merchant_accounts user_compliance_info versions].freeze
MERCHANT_LINKED = User.flag_mapping["flags"][:check_merchant_account_is_linked]

ActiveJob::Base.queue_adapter = :sidekiq
ActiveJob::Base.logger = Logger.new(nil)
$uuid_seq = 0
SecureRandom.singleton_class.prepend(Module.new do
  def uuid = format("00000000-0000-4000-8000-%012x", ($uuid_seq += 1))
end)
Rails.logger = ActiveSupport::Logger.new(nil)

def user_row(id, **overrides)
  {
    id:, email: "seller#{id}@example.com", username: "seller#{id}", external_id: (1000 + id).to_s, recommendation_type: "own_products",
    user_risk_state: "compliant", flags: 0, confirmed_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT
  }.merge(overrides)
end

def account_row(id, user_id: 1, merchant_id: "acct_#{id}", json: { meta: { stripe_connect: "true" } }, **overrides)
  {
    id:, user_id:, charge_processor_id: "stripe", charge_processor_merchant_id: merchant_id, json_data: json && JSON.generate(json), country: "US", currency: "usd",
    charge_processor_alive_at: SEEDED_AT, charge_processor_verified_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT
  }.merge(overrides)
end

def info_row(id, **overrides) = { id:, user_id: 1, country: "United States", is_business: false, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)

def event(extra = {}) = { "id" => "evt_1", "type" => "account.application.deauthorized", "account" => "acct_1" }.merge(extra)

# The merchant_migration feature is off in every case: a seller on it is handed back by Node (see the test).
def run(name, params, seed, merchant_migration: false)
  $uuid_seq = 0
  # Flipper's gates live in a Redis the capture does not flush, so the feature is set either way.
  setup = -> { merchant_migration ? Feature.activate(:merchant_migration) : Feature.deactivate(:merchant_migration) }
  result = capture(name, now: NOW, tables: TABLES, seed:, setup:, sidekiq: true, job: "HandleStripeEventWorker", args: [params], merchant_migration:) do
    HandleStripeEventWorker.new.perform(params)
  end
  result.delete("seed")
  result.delete("rows")
  result
end

def seed(user: user_row(1, flags: MERCHANT_LINKED), accounts: [account_row(1)], **rest) = { users: [user], merchant_accounts: accounts, **rest }

cases = []
cases << run("no account matches the Stripe account id", event, seed(accounts: [account_row(1, merchant_id: "acct_other")]))
cases << run("a Connect account of a seller with the link flag on", event, seed)
cases << run("a Connect account of a seller with the link flag off", event, seed(user: user_row(1)))
cases << run("a Gumroad-managed account loses its meta", event, seed(accounts: [account_row(1, json: { meta: { stripe_connect: "false" }, other: "kept" })]))
cases << run("an account with no json_data", event, seed(accounts: [account_row(1, json: nil)]))
cases << run("an account already deleted", event, seed(accounts: [account_row(1, deleted_at: SEEDED_AT)]))
cases << run("an account that is not alive at the processor is still deleted", event, seed(accounts: [account_row(1, charge_processor_alive_at: nil, charge_processor_verified_at: nil)]))
cases << run("the newest of two alive accounts with the same Stripe id", event, seed(accounts: [account_row(1, merchant_id: "acct_1"), account_row(2, merchant_id: "acct_1")]))
cases << run("an alive account behind a deleted one", event, seed(accounts: [account_row(1, merchant_id: "acct_1"), account_row(2, merchant_id: "acct_1", deleted_at: SEEDED_AT)]))
cases << run("the account id in user_id", event("account" => nil, "user_id" => "acct_1"), seed)
cases << run("user_id wins over account", event("user_id" => "acct_1", "account" => "acct_other"), seed)
cases << run("a blank user_id falls back to account", event("user_id" => "  "), seed)
cases << run("an account of a seller that does not exist fails after the delete", event, seed(accounts: [account_row(1, user_id: 9)]))
cases << run("an account with no seller fails after the delete", event, seed(accounts: [account_row(1, user_id: nil)]))
cases << run("an event with no account id is the platform account's", event("account" => STRIPE_PLATFORM_ACCOUNT_ID), seed)

Feature.deactivate(:merchant_migration)
File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
