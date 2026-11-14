# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/retry-stripe-rejected-payout-setup-for-seller-job.golden.json:
# RetryStripeRejectedPayoutSetupForSellerJob run by the real app against a scratch database as a Sidekiq job
# (support/sidekiq_executor.rb). Every exit that only reads (no user, a suspended one, no outstanding failure note, and the connected
# Stripe and PayPal exits with nothing to abandon) ends in Node. A seller with an outstanding note, or with notes to abandon, reaches
# writes, Stripe calls and mail: those cases are recorded up to there, where a marker exception stands in (`oldest_outstanding_note`
# returning a note, `User#add_payout_note`), and Node hands them back. Run it like retry-stripe-jp-address-resync-for-seller-job.rb
# (env as in publish-scheduled-post.rb, USE_DB_WORKER_REPLICAS=true).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/retry-stripe-rejected-payout-setup-for-seller-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
LATER_AT = "2026-02-01 00:00:00"
TABLES = %w[users merchant_accounts user_compliance_info bank_accounts comments versions].freeze
MERCHANT_LINKED = User.flag_mapping["flags"][:check_merchant_account_is_linked]
BANK = StripeMerchantAccountManager::BANK_SYNC_FAILURE_NOTE_PREFIX
POSTAL = StripeMerchantAccountManager::POSTAL_CODE_FAILURE_NOTE_PREFIX
NO_VERDICT = StripeMerchantAccountManager::NO_VERDICT_FAILURE_NOTE_PREFIX

Rails.logger = ActiveSupport::Logger.new(nil)

class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

RetryStripeRejectedPayoutSetupForSellerJob.prepend(Module.new do
  private
    def oldest_outstanding_note(*)
      note = super
      raise HandBackMarker if note
      note
    end
end)
User.prepend(Module.new do
  def add_payout_note(*, **) = raise(HandBackMarker)
end)

def user_row(id, **overrides) = { id:, email: "user#{id}@example.com", username: "user#{id}", external_id: (1000 + id).to_s, user_risk_state: "compliant", flags: 0, confirmed_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)

def account_row(id, user: 1, **overrides)
  { id:, user_id: user, charge_processor_id: "stripe", charge_processor_merchant_id: "acct_#{id}", charge_processor_alive_at: SEEDED_AT, json_data: "{}", created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def connect_row(id, **overrides) = account_row(id, json_data: JSON.generate(meta: { stripe_connect: "true" }), **overrides)

def info_row(id, user: 1, **overrides)
  { id:, user_id: user, country: "United States", is_business: false, flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def bank_row(id, user: 1, **overrides)
  { id:, user_id: user, type: "AchAccount", account_number: "x", account_number_last_four: "6789", bank_number: "x", account_holder_full_name: "A B", created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def note(id, user_id = 1, json: nil, content: "#{BANK}: details", **overrides)
  { id:, commentable_id: user_id, commentable_type: "User", author_id: GUMROAD_ADMIN_ID, author_name: "Admin", content:, comment_type: "payout_note",
    json_data: json && (json.is_a?(String) ? json : JSON.generate(json)), ancestry_depth: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

# A seller paid out through Stripe: a Gumroad-managed account, a US compliance revision.
READY = { users: [user_row(1)], merchant_accounts: [account_row(1)], user_compliance_info: [info_row(1)] }.freeze

def ready(**rest) = READY.merge(rest)

def run(name, seed, id = 1, merchant_migration: false)
  hands_back = false
  setup = -> { merchant_migration ? Feature.activate(:merchant_migration) : Feature.deactivate(:merchant_migration) }
  result = capture(name, now: NOW, tables: TABLES, seed:, setup:, sidekiq: true, job: "RetryStripeRejectedPayoutSetupForSellerJob", args: [id], at: NOW.to_f, merchant_migration:) do
    RetryStripeRejectedPayoutSetupForSellerJob.new.perform(id)
  rescue HandBackMarker
    hands_back = true
  end
  result.delete("seed")
  result.delete("rows")
  # Flipper writes its feature set to Redis when its memoized flags expire mid-run: not the job's doing.
  result["redis"] = result["redis"].select { |key, _| key.start_with?("queue", "uniquejobs") }
  result.merge("hands_back" => hands_back)
end

cases = []
cases << run("a user that does not exist", {}, 9)
cases << run("a user id of nil", READY, nil)
cases << run("a user suspended for fraud", ready(users: [user_row(1, user_risk_state: "suspended_for_fraud")], comments: [note(1)]))
cases << run("a user suspended for a tos violation", ready(users: [user_row(1, user_risk_state: "suspended_for_tos_violation")], comments: [note(1)]))
cases << run("a user flagged for fraud with a note", ready(users: [user_row(1, user_risk_state: "flagged_for_fraud")], comments: [note(1)]))
cases << run("a seller with no notes", ready)
cases << run("a seller with a bank sync note", ready(comments: [note(1)]))
cases << run("a seller with a postal code note", ready(comments: [note(1, content: "#{POSTAL}: 12345")]))
cases << run("a seller with a no verdict note", ready(comments: [note(1, content: "#{NO_VERDICT}: timeout")]))
cases << run("a seller with a note that only starts like a failure", ready(comments: [note(1, content: "Stripe bank sync failed")]))
cases << run("a seller with a note whose prefix is in the middle", ready(comments: [note(1, content: "Note: #{BANK}")]))
cases << run("a seller with a note of another kind", ready(comments: [note(1, content: "Payout paused")]))
cases << run("a seller with a note of a lowercase prefix", ready(comments: [note(1, content: BANK.downcase)]))
cases << run("a seller with a deleted note", ready(comments: [note(1, deleted_at: SEEDED_AT)]))
cases << run("a seller with a note of another comment type", ready(comments: [note(1, comment_type: "note")]))
cases << run("a seller with a note by another author", ready(comments: [note(1, author_id: GUMROAD_ADMIN_ID + 1)]))
cases << run("a seller with a note on another commentable type", ready(comments: [note(1, commentable_type: "Link")]))
cases << run("a seller with a note on another user", ready(users: [user_row(1), user_row(2)], comments: [note(1, 2)]))
cases << run("a seller with an abandoned note", ready(comments: [note(1, json: { abandoned_at: SEEDED_AT, abandoned_reason: "x" })]))
cases << run("a seller with a note abandoned with a blank time", ready(comments: [note(1, json: { abandoned_at: "" })]))
cases << run("a seller with a note abandoned with a null time", ready(comments: [note(1, json: { abandoned_at: nil })]))
cases << run("a seller with a note abandoned with a whitespace time", ready(comments: [note(1, json: { abandoned_at: "  " })]))
cases << run("a seller with a note abandoned with an empty hash", ready(comments: [note(1, json: { abandoned_at: {} })]))
cases << run("a seller with a note abandoned with false", ready(comments: [note(1, json: { abandoned_at: false })]))
cases << run("a seller with a note abandoned with zero", ready(comments: [note(1, json: { abandoned_at: 0 })]))
cases << run("a seller with a retried note", ready(comments: [note(1, json: { retry_count: 3, last_retried_at: SEEDED_AT })]))
cases << run("a seller with a note holding an empty json", ready(comments: [note(1, json: {})]))
cases << run("a seller with a note holding a blank json", ready(comments: [note(1, json: "")]))
cases << run("a seller with a note holding json that is not json", ready(comments: [note(1, json: "{oops")]))
cases << run("a seller with a note holding a json array", ready(comments: [note(1, json: "[1]")]))
cases << run("a seller with a note holding a json null", ready(comments: [note(1, json: "null")]))
cases << run("a seller with a note holding a json string", ready(comments: [note(1, json: "\"x\"")]))
cases << run("a seller with a note holding a json number", ready(comments: [note(1, json: "5")]))
cases << run("a seller with an abandoned note and an outstanding one", ready(comments: [note(1, json: { abandoned_at: SEEDED_AT }), note(2, created_at: LATER_AT)]))
cases << run("a seller with an outstanding note and an abandoned one", ready(comments: [note(1), note(2, json: { abandoned_at: SEEDED_AT }, created_at: LATER_AT)]))
cases << run("a seller with two abandoned notes", ready(comments: [note(1, json: { abandoned_at: SEEDED_AT }), note(2, json: { abandoned_at: SEEDED_AT }, created_at: LATER_AT)]))
cases << run("a seller with two outstanding notes, the newer first by id", ready(comments: [note(1, created_at: LATER_AT), note(2)]))
cases << run("a seller with a deleted note and an abandoned one", ready(comments: [note(1, deleted_at: SEEDED_AT), note(2, json: { abandoned_at: SEEDED_AT })]))
cases << run("a seller with a connected Stripe account and no notes", ready(users: [user_row(1, flags: MERCHANT_LINKED)], merchant_accounts: [account_row(1), connect_row(2)]))
cases << run("a seller with a connected Stripe account and an outstanding note", ready(users: [user_row(1, flags: MERCHANT_LINKED)], merchant_accounts: [account_row(1), connect_row(2)], comments: [note(1)]))
cases << run("a seller with a connected Stripe account and an abandoned note", ready(users: [user_row(1, flags: MERCHANT_LINKED)], merchant_accounts: [account_row(1), connect_row(2)], comments: [note(1, json: { abandoned_at: SEEDED_AT })]))
cases << run("a seller with a Connect account and the link flag off and a note", ready(merchant_accounts: [account_row(1), connect_row(2)], comments: [note(1)]))
cases << run("a seller with the link flag on and no Connect account and a note", ready(users: [user_row(1, flags: MERCHANT_LINKED)], comments: [note(1)]))
cases << run("a seller with the merchant migration feature on and no notes", ready, merchant_migration: true)
cases << run("a seller with the merchant migration feature on and a note", ready(comments: [note(1)]), merchant_migration: true)
cases << run("a seller paid out through PayPal with no notes", ready(users: [user_row(1, payment_address: "payee@example.com")]))
cases << run("a seller paid out through PayPal with an outstanding note", ready(users: [user_row(1, payment_address: "payee@example.com")], comments: [note(1)]))
cases << run("a seller paid out through PayPal with an abandoned note", ready(users: [user_row(1, payment_address: "payee@example.com")], comments: [note(1, json: { abandoned_at: SEEDED_AT })]))
cases << run("a seller with a payment address and a bank account and a note", ready(users: [user_row(1, payment_address: "payee@example.com")], bank_accounts: [bank_row(1)], comments: [note(1)]))
cases << run("a seller with a payment address and a bank account and no notes", ready(users: [user_row(1, payment_address: "payee@example.com")], bank_accounts: [bank_row(1)]))
cases << run("a seller with a payment address and a deleted bank account and a note", ready(users: [user_row(1, payment_address: "payee@example.com")], bank_accounts: [bank_row(1, deleted_at: SEEDED_AT)], comments: [note(1)]))
cases << run("a seller with a PayPal merchant account and a note", ready(merchant_accounts: [account_row(1), account_row(2, charge_processor_id: "paypal")], comments: [note(1)]))
cases << run("a seller with a PayPal merchant account and no notes", ready(merchant_accounts: [account_row(1), account_row(2, charge_processor_id: "paypal")]))
cases << run("a seller in a country without native payouts and a note", ready(user_compliance_info: [info_row(1, country: "Russia")], comments: [note(1)]))
cases << run("a seller in a country without native payouts and no notes", ready(user_compliance_info: [info_row(1, country: "Russia")]))
cases << run("a seller with no compliance info and a note", ready(user_compliance_info: [], comments: [note(1)]))
cases << run("a seller with no compliance info and no notes", ready(user_compliance_info: []))
cases << run("a seller with a deleted compliance info and a note", ready(user_compliance_info: [info_row(1, deleted_at: SEEDED_AT)], comments: [note(1)]))
cases << run("a seller with no Stripe account and a note", ready(merchant_accounts: [], comments: [note(1)]))
cases << run("a seller with a payment address, a bank account and no Stripe account", ready(users: [user_row(1, payment_address: "payee@example.com")], bank_accounts: [bank_row(1)], merchant_accounts: [], comments: [note(1)]))
cases << run("a user id given as a digit string and no notes", ready, "1")
cases << run("a user id given as a digit string and a note", ready(comments: [note(1)]), "1")
cases << run("a user id given as a float", ready(comments: [note(1)]), 1.0)
cases << run("a user id given as a word", ready(comments: [note(1)]), "abc")

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
