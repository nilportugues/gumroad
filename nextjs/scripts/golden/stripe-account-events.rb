# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/stripe-account-events.golden.json: HandleStripeEventWorker run by the real app
# against a scratch database as a Sidekiq job (support/sidekiq_executor.rb) for the `capability.updated` events of an account outside
# Japan and the `account.updated` events of a standard account of a connected account. Both end in local work: the payment method
# availability refresh job and the currency mismatch markers. Anything else of those two events calls Stripe or sends mail, and
# Node hands it back. The Stripe API key is the golden's own and no case reaches Stripe: HTTP is answered by WebMock and a request
# would be recorded under "http". Run it like stripe-payouts-paused-email-job.rb (env as in publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/stripe-account-events.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[users merchant_accounts user_compliance_info versions].freeze
capture_http!
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

def capability(extra = {}, object: {}) = { "id" => "evt_1", "type" => "capability.updated", "account" => "acct_1", "data" => { "object" => { "object" => "capability", "id" => "card_payments", "account" => "acct_1" }.merge(object) } }.merge(extra)

def updated(object: {}, previous: nil, **extra)
  data = { "object" => { "object" => "account", "id" => "acct_1", "type" => "standard" }.merge(object) }
  data["previous_attributes"] = previous unless previous.nil?
  { "id" => "evt_2", "type" => "account.updated", "account" => "acct_1", "data" => data }.merge(extra)
end

MARKERS = { "settlement_currency_mismatch_map" => { "eur" => "2026-11-04T10:00:00Z" } }.freeze

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
connect = { meta: { stripe_connect: "true" } }
managed = { meta: { stripe_connect: "false" } }
# capability.updated
cases << run("capability.updated of a Connect account enqueues the availability refresh", capability, seed)
cases << run("capability.updated of a Gumroad-managed account enqueues nothing", capability, seed(accounts: [account_row(1, json: managed)]))
cases << run("capability.updated of an unknown account", capability, seed(accounts: [account_row(1, merchant_id: "acct_other")]))
cases << run("capability.updated of a deleted account", capability, seed(accounts: [account_row(1, deleted_at: SEEDED_AT)]))
cases << run("capability.updated of an account that is not alive at the processor", capability, seed(accounts: [account_row(1, charge_processor_alive_at: nil, charge_processor_verified_at: nil)]))
cases << run("capability.updated of an account whose processor side was deleted", capability, seed(accounts: [account_row(1, charge_processor_deleted_at: SEEDED_AT)]))
cases << run("capability.updated of the newest of two alive accounts", capability, seed(accounts: [account_row(1, json: managed), account_row(2, merchant_id: "acct_1")]))
cases << run("capability.updated of the older Connect account behind a deleted newer one", capability, seed(accounts: [account_row(1), account_row(2, merchant_id: "acct_1", deleted_at: SEEDED_AT)]))
cases << run("capability.updated of an account with no seller", capability, seed(accounts: [account_row(1, user_id: nil)]))
cases << run("capability.updated of a Connect account in another country", capability, seed(accounts: [account_row(1, country: "CA", currency: "cad")]))
cases << run("capability.updated with the account id in user_id", capability({ "account" => nil, "user_id" => "acct_1" }), seed)
cases << run("capability.updated names another account in its object", capability({}, object: { "account" => "acct_other" }), seed)
cases << run("capability.updated of a Connect account with no json_data", capability, seed(accounts: [account_row(1, json: nil)]))
# account.updated, standard accounts
cases << run("account.updated of a Connect account enqueues the availability refresh", updated, seed)
cases << run("account.updated of a Gumroad-managed account enqueues nothing", updated, seed(accounts: [account_row(1, json: managed)]))
cases << run("account.updated with no matching account", updated, seed(accounts: [account_row(1, merchant_id: "acct_other")]))
cases << run("account.updated of a deleted account", updated, seed(accounts: [account_row(1, deleted_at: SEEDED_AT)]))
cases << run("account.updated of an account that is not alive at the processor", updated, seed(accounts: [account_row(1, charge_processor_alive_at: nil, charge_processor_verified_at: nil)]))
cases << run("account.updated clears the mismatch map when default_currency changed", updated(previous: { "default_currency" => "usd" }), seed(accounts: [account_row(1, json: connect.merge(MARKERS))]))
cases << run("account.updated clears the mismatch map when external_accounts changed", updated(previous: { "external_accounts" => { "data" => [] } }), seed(accounts: [account_row(1, json: connect.merge(MARKERS))]))
cases << run("account.updated clears the legacy marker", updated(previous: { "default_currency" => "usd" }), seed(accounts: [account_row(1, json: connect.merge("settlement_currency_mismatch_noticed_at" => "2026-11-04T10:00:00Z"))]))
cases << run("account.updated clears both markers of a managed account", updated(previous: { "default_currency" => "usd" }), seed(accounts: [account_row(1, json: managed.merge(MARKERS).merge("settlement_currency_mismatch_noticed_at" => "2026-11-04T10:00:00Z", "other" => "kept"))]))
cases << run("account.updated keeps the markers when another attribute changed", updated(previous: { "business_profile" => {} }), seed(accounts: [account_row(1, json: connect.merge(MARKERS))]))
cases << run("account.updated keeps the markers when previous_attributes is absent", updated, seed(accounts: [account_row(1, json: connect.merge(MARKERS))]))
cases << run("account.updated with an empty previous_attributes", updated(previous: {}), seed(accounts: [account_row(1, json: connect.merge(MARKERS))]))
cases << run("account.updated with nothing to clear", updated(previous: { "default_currency" => "usd" }), seed)
cases << run("account.updated with empty markers", updated(previous: { "default_currency" => "usd" }), seed(accounts: [account_row(1, json: connect.merge("settlement_currency_mismatch_map" => {}, "settlement_currency_mismatch_noticed_at" => ""))]))
cases << run("account.updated: a save that fails validation is swallowed", updated(previous: { "default_currency" => "usd" }), seed(accounts: [account_row(1, user_id: 1, json: managed.merge(MARKERS)), account_row(2, user_id: 2, json: managed.merge(MARKERS), merchant_id: "acct_1")], users: [user_row(1, flags: MERCHANT_LINKED), user_row(2)]))
cases << run("account.updated with the account id in user_id", updated("account" => nil, "user_id" => "acct_1"), seed)
cases << run("account.updated of an account with no seller clears its markers", updated(previous: { "default_currency" => "usd" }), seed(accounts: [account_row(1, user_id: nil, json: connect.merge(MARKERS))]))

Feature.deactivate(:merchant_migration)
File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
