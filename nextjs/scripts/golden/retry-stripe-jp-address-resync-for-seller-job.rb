# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/retry-stripe-jp-address-resync-for-seller-job.golden.json:
# RetryStripeJpAddressResyncForSellerJob run by the real app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb).
# A seller with a due kanji or kana request reaches StripeMerchantAccountManager.handle_new_user_compliance_info, which calls Stripe:
# that manager is replaced by a recorder that raises (the job rescues and logs it), so nothing leaves the machine, and each call is
# recorded under `manager_calls`. Node hands those cases back right before the call. Run it like seller-update-worker.rb (env as in
# publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/retry-stripe-jp-address-resync-for-seller-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[users merchant_accounts user_compliance_info user_compliance_info_requests bank_accounts versions].freeze
MERCHANT_LINKED = User.flag_mapping["flags"][:check_merchant_account_is_linked]
KANJI = "individual.address_kanji.line1"
KANA = "individual.address_kana.city"
WEEK = 7 * 86_400

Rails.logger = ActiveSupport::Logger.new(nil)

$manager_calls = []
StripeMerchantAccountManager.singleton_class.prepend(Module.new do
  def handle_new_user_compliance_info(info, **options)
    $manager_calls << [info.id, options]
    raise "Stripe is not reachable from the golden"
  end
end)

def iso(time) = time.utc.iso8601

def user_row(id, **overrides) = { id:, email: "user#{id}@example.com", username: "user#{id}", external_id: (1000 + id).to_s, user_risk_state: "compliant", flags: 0, confirmed_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)

def account_row(id, user: 1, **overrides)
  { id:, user_id: user, charge_processor_id: "stripe", charge_processor_merchant_id: "acct_#{id}", charge_processor_alive_at: SEEDED_AT, json_data: "{}", created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def connect_row(id, **overrides) = account_row(id, json_data: JSON.generate(meta: { stripe_connect: "true" }), **overrides)

def info_row(id, user: 1, json: { street_address_kanji: "kanji street" }, **overrides)
  { id:, user_id: user, country: "Japan", is_business: false, json_data: json && JSON.generate(json), flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def request_row(id, user: 1, field: KANJI, json: nil, state: "requested", **overrides)
  { id:, user_id: user, field_needed: field, state:, json_data: json && JSON.generate(json), flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def bank_row(id, user: 1, **overrides)
  { id:, user_id: user, type: "AchAccount", account_number: "x", account_number_last_four: "6789", bank_number: "x", account_holder_full_name: "A B", created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

# A seller that reaches the requests: a Japanese compliance revision with a kanji address, a Gumroad-managed Stripe account.
READY = { users: [user_row(1)], merchant_accounts: [account_row(1)], user_compliance_info: [info_row(1)] }.freeze

def run(name, seed, id = 1, merchant_migration: false)
  $manager_calls = []
  setup = -> { Feature.activate(:merchant_migration) if merchant_migration }
  result = capture(name, now: NOW, tables: TABLES, seed:, setup:, sidekiq: true, job: "RetryStripeJpAddressResyncForSellerJob", args: [id], at: NOW.to_f, merchant_migration:) do
    RetryStripeJpAddressResyncForSellerJob.new.perform(id)
  end
  result.delete("seed")
  result.merge("manager_calls" => $manager_calls.dup)
end

def ready(**rest) = READY.merge(rest)

cases = []
cases << run("a user that does not exist", {}, 9)
cases << run("a user id of nil", READY, nil)
cases << run("a user suspended for fraud", ready(users: [user_row(1, user_risk_state: "suspended_for_fraud")], user_compliance_info_requests: [request_row(1)]))
cases << run("a user suspended for a tos violation", ready(users: [user_row(1, user_risk_state: "suspended_for_tos_violation")], user_compliance_info_requests: [request_row(1)]))
cases << run("a user flagged for fraud", ready(users: [user_row(1, user_risk_state: "flagged_for_fraud")], user_compliance_info_requests: [request_row(1)]))
cases << run("a user with a connected Stripe account", ready(users: [user_row(1, flags: MERCHANT_LINKED)], merchant_accounts: [account_row(1), connect_row(2)], user_compliance_info_requests: [request_row(1)]))
cases << run("a user with the merchant migration feature on", ready(user_compliance_info_requests: [request_row(1)]), merchant_migration: true)
cases << run("a user with a Connect account and the link flag off", ready(merchant_accounts: [account_row(1), connect_row(2)], user_compliance_info_requests: [request_row(1)]))
cases << run("a user with the link flag on and no Connect account", ready(users: [user_row(1, flags: MERCHANT_LINKED)], user_compliance_info_requests: [request_row(1)]))
cases << run("a user paid out through PayPal", ready(users: [user_row(1, payment_address: "payee@example.com")], user_compliance_info_requests: [request_row(1)]))
cases << run("a user with a payment address and a bank account", ready(users: [user_row(1, payment_address: "payee@example.com")], bank_accounts: [bank_row(1)], user_compliance_info_requests: [request_row(1)]))
cases << run("a user with a payment address and a deleted bank account", ready(users: [user_row(1, payment_address: "payee@example.com")], bank_accounts: [bank_row(1, deleted_at: SEEDED_AT)], user_compliance_info_requests: [request_row(1)]))
cases << run("a user in a country without native payouts", ready(user_compliance_info: [info_row(1, country: "Russia")], user_compliance_info_requests: [request_row(1)]))
cases << run("a user with no Stripe account", ready(merchant_accounts: [], user_compliance_info_requests: [request_row(1)]))
cases << run("a user whose only Stripe account is a Connect account", ready(merchant_accounts: [connect_row(1)], user_compliance_info_requests: [request_row(1)]))
cases << run("a user whose Stripe account is deleted", ready(merchant_accounts: [account_row(1, deleted_at: SEEDED_AT)], user_compliance_info_requests: [request_row(1)]))
cases << run("a user whose Stripe account is not alive at the processor", ready(merchant_accounts: [account_row(1, charge_processor_alive_at: nil)], user_compliance_info_requests: [request_row(1)]))
cases << run("a user whose Stripe account was deleted at the processor", ready(merchant_accounts: [account_row(1, charge_processor_deleted_at: SEEDED_AT)], user_compliance_info_requests: [request_row(1)]))
cases << run("a user whose account is a PayPal account", ready(merchant_accounts: [account_row(1, charge_processor_id: "paypal")], user_compliance_info_requests: [request_row(1)]))
cases << run("a user with no compliance info", ready(user_compliance_info: [], merchant_accounts: [account_row(1)], user_compliance_info_requests: [request_row(1)]))
cases << run("a user whose only compliance revision is deleted", ready(user_compliance_info: [info_row(1, deleted_at: SEEDED_AT)], user_compliance_info_requests: [request_row(1)]))
cases << run("a user whose newest compliance revision has no kanji address", ready(user_compliance_info: [info_row(1), info_row(2, json: {})], user_compliance_info_requests: [request_row(1)]))
cases << run("a user whose newest compliance revision has a kanji address", ready(user_compliance_info: [info_row(1, json: {}), info_row(2)], user_compliance_info_requests: [request_row(1)]))
cases << run("a user whose compliance json is null", ready(user_compliance_info: [info_row(1, json: nil)], user_compliance_info_requests: [request_row(1)]))
cases << run("a user whose addresses are blank text", ready(user_compliance_info: [info_row(1, json: { street_address_kanji: "  ", street_address_kana: "" })], user_compliance_info_requests: [request_row(1)]))
cases << run("a user with only a kana address", ready(user_compliance_info: [info_row(1, json: { street_address_kana: "kana street" })], user_compliance_info_requests: [request_row(1, field: KANA)]))
cases << run("a user with a kanji address and a null kana address", ready(user_compliance_info: [info_row(1, json: { street_address_kanji: "a", street_address_kana: nil })], user_compliance_info_requests: [request_row(1)]))
cases << run("a user with no requests", ready)
cases << run("a user with a due kanji request", ready(user_compliance_info_requests: [request_row(1)]))
cases << run("a user with a due kana request", ready(user_compliance_info_requests: [request_row(1, field: KANA)]))
cases << run("a user with a request for another field", ready(user_compliance_info_requests: [request_row(1, field: "individual.first_name")]))
cases << run("a user with a request that was provided", ready(user_compliance_info_requests: [request_row(1, state: "provided")]))
cases << run("a user with a request that was resynced a day ago", ready(user_compliance_info_requests: [request_row(1, json: { address_resync_at: iso(NOW - 86_400), address_resync_count: 1 })]))
cases << run("a user with a request resynced exactly a week ago", ready(user_compliance_info_requests: [request_row(1, json: { address_resync_at: iso(NOW - WEEK), address_resync_count: 1 })]))
cases << run("a user with a request resynced a second short of a week ago", ready(user_compliance_info_requests: [request_row(1, json: { address_resync_at: iso(NOW - WEEK + 1), address_resync_count: 1 })]))
cases << run("a user with a request that used its seventh attempt", ready(user_compliance_info_requests: [request_row(1, json: { address_resync_count: 7 })]))
cases << run("a user with a request that used all eight attempts", ready(user_compliance_info_requests: [request_row(1, json: { address_resync_count: 8 })]))
cases << run("a user with a request whose resync time is unreadable", ready(user_compliance_info_requests: [request_row(1, json: { address_resync_at: "yesterday", address_resync_count: 1 })]))
cases << run("a user with a request whose resync time is a number", ready(user_compliance_info_requests: [request_row(1, json: { address_resync_at: 5 })]))
cases << run("a user with a request whose resync count is text", ready(user_compliance_info_requests: [request_row(1, json: { address_resync_count: "abc" })]))
cases << run("a user with a request whose json is not json", ready(user_compliance_info_requests: [request_row(1, json_data: "{oops")]))
cases << run("a user with a request whose json is an array", ready(user_compliance_info_requests: [request_row(1, json_data: "[1]")]))
cases << run("a user with one request not due and one due", ready(user_compliance_info_requests: [request_row(1, json: { address_resync_count: 8 }), request_row(2, field: KANA)]))
cases << run("a user with two requests not due", ready(user_compliance_info_requests: [request_row(1, json: { address_resync_count: 8 }), request_row(2, field: KANA, json: { address_resync_count: 9 })]))
cases << run("a request of another user", ready(users: [user_row(1), user_row(2)], user_compliance_info_requests: [request_row(1, user: 2)]))
cases << run("a user id given as a digit string and no requests", ready, "1")
cases << run("a user id given as a digit string and a due request", ready(user_compliance_info_requests: [request_row(1)]), "1")
cases << run("a user id given as a float", ready(user_compliance_info_requests: [request_row(1)]), 1.0)
cases << run("a user id given as a word", ready(user_compliance_info_requests: [request_row(1)]), "abc")

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
