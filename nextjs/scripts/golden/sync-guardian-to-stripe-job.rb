# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/sync-guardian-to-stripe-job.golden.json: SyncGuardianToStripeJob run by the real app against
# a scratch database as a Sidekiq job (support/sidekiq_executor.rb). A seller who needs the Stripe call is what Node hands back to Rails:
# those cases are recorded up to `Stripe::Account.retrieve`, which a marker exception stands in for, so nothing reaches Stripe. Run it
# like publish-scheduled-post.rb (env as there):
#
#   bundle exec rails runner nextjs/scripts/golden/sync-guardian-to-stripe-job.rb
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/sync-guardian-to-stripe-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[users merchant_accounts user_compliance_info].freeze
USER_CHECK_MERCHANT_ACCOUNT_IS_LINKED = 1 << 24
LEGAL_ENTITY_ROUTING = :stripe_connect_routing_by_legal_entity_country

Rails.logger = ActiveSupport::Logger.new(nil)

class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

Stripe::Account.singleton_class.prepend(Module.new do
  def retrieve(*, **) = raise(HandBackMarker)
end)

def user_row(id, **overrides)
  {
    id:, email: "user#{id}@example.com", username: "user#{id}", external_id: (1000 + id).to_s, recommendation_type: "own_products",
    user_risk_state: "compliant", flags: 0, json_data: nil, confirmed_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT
  }.merge(overrides)
end

def merchant_account_row(id, **overrides)
  { id:, user_id: 1, charge_processor_id: "stripe", charge_processor_merchant_id: "acct_#{id}", country: "US", currency: "usd", charge_processor_alive_at: SEEDED_AT,
    created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def connect_row(id, **overrides) = merchant_account_row(id, json_data: { meta: { stripe_connect: "true" } }.to_json, **overrides)
def compliance_row(id = 1, **overrides) = { id:, user_id: 1, country: "United States", is_business: false, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)

def run(name, args = [1], accounts: [], compliance: [], features: [], user_flags: 0)
  hands_back = false
  setup = -> { features.each { |feature| Feature.activate_user(feature, User.find(1)) } }
  seed = { users: [user_row(1, flags: user_flags)], merchant_accounts: accounts, user_compliance_info: compliance }
  result = capture(name, now: NOW, tables: TABLES, seed:, setup:, sidekiq: true, job: "SyncGuardianToStripeJob", args:) do
    SyncGuardianToStripeJob.new.perform(*args)
  rescue HandBackMarker
    hands_back = true
  end
  result.delete("rows")
  result.delete("seed")
  result.merge("hands_back" => hands_back)
end

MIGRATION = %i[merchant_migration].freeze

cases = []
cases << run("a user that does not exist", [9])
cases << run("a user id as a digit string", ["1"])
cases << run("a user id of nil", [nil])
cases << run("a user id as a float", [1.0])
cases << run("a user id as a word", ["one"])
cases << run("a seller with no merchant account")
cases << run("a seller with a Gumroad-managed account", accounts: [merchant_account_row(1)])
cases << run("a seller with a managed account that was deleted", accounts: [merchant_account_row(1, deleted_at: SEEDED_AT)])
cases << run("a seller whose managed account processor is gone", accounts: [merchant_account_row(1, charge_processor_deleted_at: SEEDED_AT)])
cases << run("a seller whose managed account was never alive", accounts: [merchant_account_row(1, charge_processor_alive_at: nil)])
cases << run("a seller with a PayPal account only", accounts: [merchant_account_row(1, charge_processor_id: "paypal")])
cases << run("a seller with a managed account and a PayPal account", accounts: [merchant_account_row(1, charge_processor_id: "paypal"), merchant_account_row(2)])
cases << run("a seller with two managed accounts", accounts: [merchant_account_row(1), merchant_account_row(2)])
cases << run("a seller on a Connect account with merchant migration on", accounts: [connect_row(1)], compliance: [compliance_row], features: MIGRATION)
cases << run("a seller on a Connect account and a managed one with merchant migration on", accounts: [connect_row(1), merchant_account_row(2)], compliance: [compliance_row], features: MIGRATION)
cases << run("a seller on a Connect account with merchant migration off", accounts: [connect_row(1)], compliance: [compliance_row])
cases << run("a seller on a Connect account and a managed one with merchant migration off", accounts: [connect_row(1), merchant_account_row(2)], compliance: [compliance_row])
cases << run("a seller on a Brazilian Connect account", accounts: [connect_row(1, country: "BR")], compliance: [compliance_row], features: MIGRATION)
cases << run("a seller on a Brazilian Connect account and a managed one", accounts: [connect_row(1, country: "BR"), merchant_account_row(2)], compliance: [compliance_row], features: MIGRATION)
cases << run("a seller linked by the merchant account flag", accounts: [connect_row(1)], user_flags: USER_CHECK_MERCHANT_ACCOUNT_IS_LINKED)
cases << run("a seller linked by the flag without a Connect account", accounts: [merchant_account_row(1)], user_flags: USER_CHECK_MERCHANT_ACCOUNT_IS_LINKED)
cases << run("merchant migration on without compliance info", accounts: [connect_row(1), merchant_account_row(2)], features: MIGRATION)
cases << run("merchant migration on in a country Connect does not serve", accounts: [connect_row(1), merchant_account_row(2)], compliance: [compliance_row(country: "Afghanistan")], features: MIGRATION)
cases << run("legal entity routing on for a business in a served country", accounts: [connect_row(1), merchant_account_row(2)],
  compliance: [compliance_row(country: "Afghanistan", is_business: true, business_country: "United States")], features: MIGRATION + [LEGAL_ENTITY_ROUTING])
cases << run("legal entity routing on for a business in an unserved country", accounts: [connect_row(1), merchant_account_row(2)],
  compliance: [compliance_row(country: "United States", is_business: true, business_country: "Afghanistan")], features: MIGRATION + [LEGAL_ENTITY_ROUTING])
cases << run("legal entity routing off for a business in a served country", accounts: [connect_row(1), merchant_account_row(2)],
  compliance: [compliance_row(country: "Afghanistan", is_business: true, business_country: "United States")], features: MIGRATION)
cases << run("compliance info that was deleted", accounts: [connect_row(1), merchant_account_row(2)], compliance: [compliance_row(deleted_at: SEEDED_AT)], features: MIGRATION)
cases << run("two compliance records, the later one served", accounts: [connect_row(1), merchant_account_row(2)],
  compliance: [compliance_row(1, country: "Afghanistan"), compliance_row(2)], features: MIGRATION)
cases << run("a Connect account that was deleted", accounts: [connect_row(1, deleted_at: SEEDED_AT), merchant_account_row(2)], compliance: [compliance_row], features: MIGRATION)

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
