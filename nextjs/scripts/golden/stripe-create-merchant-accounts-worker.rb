# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/stripe-create-merchant-accounts-worker.golden.json: StripeCreateMerchantAccountsWorker
# run by the real app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). CreateStripeMerchantAccountWorker is
# only pushed; its Redis entry is in each case's snapshot. Run it like retry-stripe-jp-address-resyncs-job.rb (env as in
# publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/stripe-create-merchant-accounts-worker.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
RECENT = "2026-10-01 00:00:00"
TABLES = %w[users user_compliance_info bank_accounts tos_agreements balances merchant_accounts].freeze

Rails.logger = ActiveSupport::Logger.new(nil)

def user_row(id, **overrides)
  {
    id:, email: "seller#{id}@example.com", username: "seller#{id}", external_id: (1000 + id).to_s, recommendation_type: "own_products",
    user_risk_state: "compliant", flags: 0, confirmed_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT
  }.merge(overrides)
end

def info_row(id, user_id, country = "United States", **overrides)
  { id:, user_id:, country:, flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def seller(id, country = "United States", user: {}, info: {}, bank: {}, balance: {}, tos: {}, merchant: nil)
  rows = {
    users: [user_row(id, **user)],
    user_compliance_info: [info_row(id, id, country, **info)],
    bank_accounts: [{ id:, user_id: id, type: "AchAccount", created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(bank)],
    tos_agreements: [{ id:, user_id: id, created_at: SEEDED_AT }.merge(tos)],
    balances: [{ id:, user_id: id, date: "2026-10-01", created_at: RECENT, updated_at: RECENT }.merge(balance)],
    merchant_accounts: merchant ? [{ id:, user_id: id, charge_processor_id: "stripe", charge_processor_merchant_id: "acct_#{id}", created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(merchant)] : [],
  }
  rows
end

def merge_rows(*sellers) = TABLES.to_h { |t| [t.to_sym, sellers.flat_map { |s| s[t.to_sym] }] }

def run(name, *sellers, now: NOW, extra: {})
  rows = merge_rows(*sellers)
  extra.each { |table, more| rows[table] += more }
  result = capture(name, now:, tables: TABLES, seed: rows, sidekiq: true, job: "StripeCreateMerchantAccountsWorker", args: []) do
    StripeCreateMerchantAccountsWorker.new.perform
  end
  result.delete("seed")
  result.delete("rows")
  result["now"] = now.to_f
  result
end

cases = []
cases << run("no sellers")
cases << run("a seller who qualifies", seller(1))
cases << run("a not reviewed seller", seller(1, user: { user_risk_state: "not_reviewed" }))
cases << run("a seller flagged for review", seller(1, user: { user_risk_state: "flagged_for_fraud" }))
cases << run("a suspended seller", seller(1, user: { user_risk_state: "suspended_for_fraud" }))
cases << run("a seller whose compliance info was deleted", seller(1, info: { deleted_at: SEEDED_AT }))
cases << run("a seller whose bank account was deleted", seller(1, bank: { deleted_at: SEEDED_AT }))
cases << run("a seller with no tos agreement", seller(1).merge(tos_agreements: []))
cases << run("a seller with no bank account", seller(1).merge(bank_accounts: []))
cases << run("a seller with no compliance info", seller(1).merge(user_compliance_info: []))
cases << run("a seller with no balance", seller(1).merge(balances: []))
cases << run("a seller with a balance exactly three months old", seller(1, balance: { created_at: "2026-08-04 12:30:45" }))
cases << run("a seller with a balance a second newer than three months", seller(1, balance: { created_at: "2026-08-04 12:30:46" }))
cases << run("a seller with an old balance", seller(1, balance: { created_at: "2026-01-01 00:00:00" }))
cases << run("a seller with an old and a recent balance", seller(1, balance: { created_at: "2026-01-01 00:00:00" }), extra: { balances: [{ id: 50, user_id: 1, date: "2026-10-01", created_at: RECENT, updated_at: RECENT }] })
cases << run("a seller with a merchant account", seller(1, merchant: {}))
cases << run("a seller with a deleted merchant account", seller(1, merchant: { deleted_at: SEEDED_AT }))
cases << run("a seller with a Stripe Connect account", seller(1, merchant: { json_data: JSON.generate(meta: { stripe_connect: "true" }) }))
cases << run("a seller with a PayPal merchant account", seller(1, merchant: { charge_processor_id: "paypal" }))
cases << run("a seller in India", seller(1, "India"))
cases << run("a seller in Japan", seller(1, "Japan"))
cases << run("a seller in a country without native payouts", seller(1, "Brazil"))
cases << run("a seller in Mexico", seller(1, "Mexico"))
cases << run("a seller with no country", seller(1, nil))
cases << run("a seller with an unknown country", seller(1, "Atlantis"))
cases << run("a UAE individual", seller(1, "United Arab Emirates"))
cases << run("a UAE business", seller(1, "United Arab Emirates", info: { is_business: true }))
cases << run("a business whose country is supported and business country is India", seller(1, "United States", info: { is_business: true, business_country: "India" }))
cases << run("a business in India with a US country", seller(1, "India", info: { is_business: true, business_country: "United States" }))
cases << run("a business with an unknown business country", seller(1, "United States", info: { is_business: true, business_country: "Atlantis" }))
cases << run("a business with no business country", seller(1, "Canada", info: { is_business: true }))
cases << run("a seller whose latest compliance info is deleted", seller(1, "United States"), extra: { user_compliance_info: [info_row(60, 1, "India", deleted_at: SEEDED_AT)] })
cases << run("a seller with two compliance revisions", seller(1, "India"), extra: { user_compliance_info: [info_row(60, 1, "United States")] })
cases << run("a seller with two balances and two bank accounts", seller(1), extra: { balances: [{ id: 50, user_id: 1, date: "2026-10-02", created_at: RECENT, updated_at: RECENT }], bank_accounts: [{ id: 50, user_id: 1, type: "AchAccount", created_at: SEEDED_AT, updated_at: SEEDED_AT }] })
cases << run("three sellers where two qualify", seller(1), seller(2, "India"), seller(3, "Canada"))
cases << run("a month end clamped to February", seller(1, balance: { created_at: "2026-02-28 12:00:00" }), now: Time.utc(2026, 5, 31, 12, 0, 0))
cases << run("a month end clamped to a leap February", seller(1, balance: { created_at: "2024-02-29 12:00:01" }), seller(2, balance: { created_at: "2024-02-29 11:59:59" }), now: Time.utc(2024, 5, 31, 12, 0, 0))
cases << run("a first of the month in January", seller(1, balance: { created_at: "2025-10-01 00:00:01" }), now: Time.utc(2026, 1, 1, 0, 0, 0))
cases << run("a thirty first in a month three before with thirty days", seller(1, balance: { created_at: "2026-09-30 00:00:01" }), seller(2, balance: { created_at: "2026-09-29 23:59:59" }), now: Time.utc(2026, 12, 31, 0, 0, 0))

File.write(OUT, "{\n\"now\": #{NOW.to_f.to_json},\n\"cases\": [\n#{cases.map(&:to_json).join(",\n")}\n]\n}\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
