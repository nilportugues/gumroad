# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/stripe-create-merchant-accounts-worker.golden.json: StripeCreateMerchantAccountsWorker run by
# the real app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). It pushes CreateStripeMerchantAccountWorker for
# every seller the discovery query finds whose payout country is native and not blocked. Run it like retry-stripe-jp-address-resyncs-job.rb
# (USE_DB_WORKER_REPLICAS=true, env as in publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/stripe-create-merchant-accounts-worker.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
RECENT = "2026-10-01 00:00:00"
TABLES = %w[users user_compliance_info bank_accounts tos_agreements balances merchant_accounts].freeze

Rails.logger = ActiveSupport::Logger.new(nil)

def user_row(id, **overrides) = { id:, email: "user#{id}@example.com", username: "user#{id}", external_id: (1000 + id).to_s, user_risk_state: "compliant", flags: 0, confirmed_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
def info_row(id, user, **overrides) = { id:, user_id: user, country: "United States", is_business: false, flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
def bank_row(id, user, **overrides) = { id:, user_id: user, type: "AchAccount", created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
def tos_row(id, user, **overrides) = { id:, user_id: user, ip: "127.0.0.1", created_at: SEEDED_AT }.merge(overrides)
def balance_row(id, user, **overrides) = { id:, user_id: user, date: "2026-10-01", state: "unpaid", created_at: RECENT, updated_at: RECENT }.merge(overrides)
def account_row(id, user, **overrides) = { id:, user_id: user, charge_processor_id: "stripe", charge_processor_merchant_id: "acct_#{id}", json_data: "{}", created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)

# One seller (id 1) that passes every join, as the base every case varies.
def seller(user: {}, info: {}, bank: {}, tos: {}, balance: {})
  { users: [user_row(1, **user)], user_compliance_info: [info_row(1, 1, **info)], bank_accounts: [bank_row(1, 1, **bank)], tos_agreements: [tos_row(1, 1, **tos)], balances: [balance_row(1, 1, **balance)] }
end

def run(name, seed)
  result = capture(name, now: NOW, tables: TABLES, seed: seed.reverse_merge(TABLES.to_h { [_1.to_sym, []] }), sidekiq: true, job: "StripeCreateMerchantAccountsWorker", args: []) do
    StripeCreateMerchantAccountsWorker.new.perform
  end
  result.delete("seed")
  result.delete("rows")
  result
end

cases = []
cases << run("no sellers", {})
cases << run("a seller passing every join", seller)
cases << run("a seller not yet reviewed", seller(user: { user_risk_state: "not_reviewed" }))
%w[flagged_for_fraud suspended_for_fraud flagged_for_tos_violation suspended_for_tos_violation on_probation].each do |state|
  cases << run("a seller #{state.tr("_", " ")}", seller(user: { user_risk_state: state }))
end
cases << run("a compliance revision that was deleted", seller(info: { deleted_at: SEEDED_AT }))
cases << run("a bank account that was deleted", seller(bank: { deleted_at: SEEDED_AT }))
cases << run("no tos agreement", seller.merge(tos_agreements: []))
cases << run("no bank account", seller.merge(bank_accounts: []))
cases << run("no compliance info", seller.merge(user_compliance_info: []))
cases << run("no balance", seller.merge(balances: []))
cases << run("a balance a day past the active window", seller(balance: { created_at: "2026-08-03 12:30:45" }))
cases << run("a balance just past the active window", seller(balance: { created_at: "2026-08-04 12:30:45" }))
cases << run("a balance exactly at the active window", seller(balance: { created_at: "2026-08-04 12:30:46" }))
cases << run("a balance a second inside the active window", seller(balance: { created_at: "2026-08-04 12:30:47" }))
cases << run("a merchant account of the seller", seller.merge(merchant_accounts: [account_row(1, 1)]))
cases << run("a deleted merchant account of the seller", seller.merge(merchant_accounts: [account_row(1, 1, deleted_at: SEEDED_AT)]))
cases << run("a merchant account of another seller", seller.merge(merchant_accounts: [account_row(1, 2)]))
cases << run("a seller from India", seller(info: { country: "India" }))
cases << run("a seller from a country without native payouts", seller(info: { country: "Afghanistan" }))
cases << run("a seller from an unknown country", seller(info: { country: "Atlantis" }))
cases << run("a seller with no country", seller(info: { country: nil }))
cases << run("a seller from the United Arab Emirates", seller(info: { country: "United Arab Emirates" }))
cases << run("a business from the United Arab Emirates", seller(info: { country: "United Arab Emirates", is_business: true, business_country: "United Arab Emirates" }))
cases << run("a business in India run by a resident of the United States", seller(info: { is_business: true, business_country: "India" }))
cases << run("a business in the United States run by a resident of India", seller(info: { country: "India", is_business: true, business_country: "United States" }))
cases << run("a business with no business country", seller(info: { is_business: true, business_country: nil }))
cases << run("a seller from Canada", seller(info: { country: "Canada" }))
cases << run("two compliance revisions, the last one from India", seller.merge(user_compliance_info: [info_row(1, 1), info_row(2, 1, country: "India")]))
cases << run("two compliance revisions, the last one deleted", seller.merge(user_compliance_info: [info_row(1, 1), info_row(2, 1, country: "India", deleted_at: SEEDED_AT)]))
cases << run("two compliance revisions, the last one alive from the United States", seller.merge(user_compliance_info: [info_row(1, 1, country: "India"), info_row(2, 1)]))
two = seller.merge(
  users: [user_row(1), user_row(2)],
  user_compliance_info: [info_row(1, 1), info_row(2, 2, country: "Canada")],
  bank_accounts: [bank_row(1, 1), bank_row(2, 2)],
  tos_agreements: [tos_row(1, 1), tos_row(2, 2)],
  balances: [balance_row(1, 1), balance_row(2, 2)]
)
cases << run("two sellers passing every join", two)
cases << run("two sellers, the first with a merchant account", two.merge(merchant_accounts: [account_row(1, 1)]))
many = seller.merge(
  bank_accounts: [bank_row(1, 1), bank_row(2, 1)],
  tos_agreements: [tos_row(1, 1), tos_row(2, 1)],
  balances: [balance_row(1, 1), balance_row(2, 1), balance_row(3, 1)]
)
cases << run("a seller with several bank accounts, agreements and balances", many)

File.write(OUT, "{\n\"now\": #{NOW.to_f.to_json},\n\"cases\": [\n#{cases.map(&:to_json).join(",\n")}\n]\n}\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
