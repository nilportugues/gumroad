# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/detect-failing-paypal-rails-job.golden.json: DetectFailingPaypalRailsJob run by the
# real app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb): the failed-purchase counts of connected
# PayPal accounts, the completed-purchase exclusion and the deduplicated admin note under the user's row lock. Run it like
# publish-scheduled-post.rb:
#
#   bundle exec rails runner nextjs/scripts/golden/detect-failing-paypal-rails-job.rb   (env as in publish-scheduled-post.rb)
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/detect-failing-paypal-rails-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
RECENT = "2026-11-01 08:00:00"
OLD = "2026-10-20 08:00:00"
TABLES = %w[users merchant_accounts purchases comments versions].freeze
COMPLIANCE = "paypal_payee_compliance_violation"
RESTRICTED = "paypal_merchant_account_restricted"

Rails.logger = ActiveSupport::Logger.new(nil)

# A user whose id is in FAILING_NOTES cannot be noted: the job rescues the error per account and reports it.
FAILING_NOTES = []
NOTIFIED = []
Comment.prepend(Module.new do
  def save!(*args, **options, &block)
    FAILING_NOTES.include?(commentable_id) ? raise("boom") : super
  end
end)
ErrorNotifier.singleton_class.prepend(Module.new do
  def notify(error, **options) = NOTIFIED << { "class" => error.class.name, "message" => error.message, "options" => options.as_json }
end)

def user_row(id)
  { id:, email: "user#{id}@example.com", username: "user#{id}", external_id: (1000 + id).to_s, user_risk_state: "compliant", flags: 0, confirmed_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT }
end

def account_row(id, user_id: id, **overrides)
  { id:, user_id:, charge_processor_id: "paypal", charge_processor_merchant_id: "PAYPALMERCH#{id}", charge_processor_alive_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def purchase_rows(first_id, count, account: 1, seller: account, state: "failed", error_code: COMPLIANCE, stripe_error_code: nil, created_at: RECENT, processor: "paypal")
  (first_id...(first_id + count)).map do |id|
    { id:, seller_id: seller, merchant_account_id: account, link_id: 1, email: "buyer#{id}@example.com", price_cents: 500, purchase_state: state, error_code:, stripe_error_code:, charge_processor_id: processor, flags: 0, created_at:, updated_at: created_at }
  end
end

def comment_row(id, user_id, content, author_name: "failing-paypal-rail", created_at: RECENT, **overrides)
  { id:, commentable_id: user_id, commentable_type: "User", author_name:, comment_type: "note", content:, created_at:, updated_at: created_at }.merge(overrides)
end

def note(account_id, count = 20) = "PayPal account (PAYPALMERCH#{account_id}) had #{count} failed PayPal payee-side purchase attempts and no completed purchases in the last 7 days. Review the connected PayPal rail."

def seed(users: [1], accounts: [account_row(1)], purchases: [], comments: [])
  { users: users.map { user_row(_1) }, merchant_accounts: accounts, purchases:, comments: }
end

def run(name, seed, failing: [])
  FAILING_NOTES.replace(failing)
  NOTIFIED.clear
  result = capture(name, now: NOW, tables: TABLES, seed:, sidekiq: true, job: "DetectFailingPaypalRailsJob", args: []) do
    DetectFailingPaypalRailsJob.new.perform
  end
  result.delete("rows")
  result.delete("seed")
  result.merge("notified" => NOTIFIED.dup)
end

cases = []
cases << run("no accounts", seed(users: [], accounts: []))
cases << run("an account with no purchases", seed)
cases << run("19 failed attempts", seed(purchases: purchase_rows(1, 19)))
cases << run("20 failed attempts", seed(purchases: purchase_rows(1, 20)))
cases << run("20 attempts that failed with the restricted code", seed(purchases: purchase_rows(1, 20, error_code: nil, stripe_error_code: RESTRICTED)))
cases << run("10 attempts of each code", seed(purchases: purchase_rows(1, 10) + purchase_rows(11, 10, error_code: nil, stripe_error_code: RESTRICTED)))
cases << run("20 failed attempts with another error code", seed(purchases: purchase_rows(1, 20, error_code: "card_declined")))
cases << run("20 attempts that did not fail", seed(purchases: purchase_rows(1, 20, state: "successful")))
cases << run("20 failed attempts and a completed purchase", seed(purchases: purchase_rows(1, 20) + purchase_rows(21, 1, state: "successful", error_code: nil)))
cases << run("20 failed attempts and a completed purchase outside the window", seed(purchases: purchase_rows(1, 20) + purchase_rows(21, 1, state: "successful", error_code: nil, created_at: OLD)))
cases << run("20 failed attempts and a completed purchase on another account", seed(accounts: [account_row(1), account_row(2)], users: [1, 2], purchases: purchase_rows(1, 20) + purchase_rows(21, 1, account: 2, state: "successful", error_code: nil)))
cases << run("20 failed attempts outside the window", seed(purchases: purchase_rows(1, 20, created_at: OLD)))
cases << run("failed attempts that straddle the window", seed(purchases: purchase_rows(1, 10) + purchase_rows(11, 10, created_at: OLD)))
cases << run("20 failed attempts of another seller", seed(users: [1, 2], purchases: purchase_rows(1, 20, seller: 2)))
cases << run("20 failed attempts that were not PayPal charges", seed(purchases: purchase_rows(1, 20, processor: "stripe")))
cases << run("a note that is recent", seed(purchases: purchase_rows(1, 20), comments: [comment_row(1, 1, note(1, 25))]))
cases << run("a note from before the window", seed(purchases: purchase_rows(1, 20), comments: [comment_row(1, 1, note(1), created_at: OLD)]))
cases << run("a recent note by someone else", seed(purchases: purchase_rows(1, 20), comments: [comment_row(1, 1, note(1), author_name: "someone")]))
cases << run("a recent note that is not a note", seed(purchases: purchase_rows(1, 20), comments: [comment_row(1, 1, note(1), comment_type: "on_probation")]))
cases << run("a recent note about another account", seed(purchases: purchase_rows(1, 20), comments: [comment_row(1, 1, note(2))]))
cases << run("a recent note on another user", seed(users: [1, 2], purchases: purchase_rows(1, 20), comments: [comment_row(1, 2, note(1))]))
cases << run("a deleted note", seed(purchases: purchase_rows(1, 20), comments: [comment_row(1, 1, note(1), deleted_at: RECENT)]))
cases << run("a marker with LIKE wildcards", seed(accounts: [account_row(1, charge_processor_merchant_id: "PAY_%MERCH")], purchases: purchase_rows(1, 20), comments: [comment_row(1, 1, "PayPal account (PAYXXMERCH) was noted")]))
cases << run("a deleted account", seed(accounts: [account_row(1, deleted_at: RECENT)], purchases: purchase_rows(1, 20)))
cases << run("an account that is not alive at the processor", seed(accounts: [account_row(1, charge_processor_alive_at: nil)], purchases: purchase_rows(1, 20)))
cases << run("an account deleted at the processor", seed(accounts: [account_row(1, charge_processor_deleted_at: RECENT)], purchases: purchase_rows(1, 20)))
cases << run("an account with no user", seed(accounts: [account_row(1, user_id: nil)], purchases: purchase_rows(1, 20)))
cases << run("an account whose user does not exist", seed(users: [], accounts: [account_row(1, user_id: 9)], purchases: purchase_rows(1, 20, seller: 9)))
cases << run("a Stripe account", seed(accounts: [account_row(1, charge_processor_id: "stripe")], purchases: purchase_rows(1, 20)))
cases << run("two failing accounts", seed(users: [1, 2], accounts: [account_row(1), account_row(2)], purchases: purchase_rows(1, 20) + purchase_rows(21, 25, account: 2)))
cases << run("two failing accounts of one of which a note exists", seed(users: [1, 2], accounts: [account_row(1), account_row(2)], purchases: purchase_rows(1, 20) + purchase_rows(21, 25, account: 2), comments: [comment_row(1, 2, note(2, 25))]))
cases << run("two failing accounts of one user", seed(users: [1], accounts: [account_row(1), account_row(2, user_id: 1)], purchases: purchase_rows(1, 20) + purchase_rows(21, 20, account: 2, seller: 1)))
cases << run("one failing account among healthy ones", seed(users: [1, 2, 3], accounts: [account_row(1), account_row(2), account_row(3)], purchases: purchase_rows(1, 5) + purchase_rows(6, 20, account: 2) + purchase_rows(26, 3, account: 3)))
cases << run("a note that cannot be saved", seed(purchases: purchase_rows(1, 20)), failing: [1])
cases << run("a note that cannot be saved, then another account", seed(users: [1, 2], accounts: [account_row(1), account_row(2)], purchases: purchase_rows(1, 20) + purchase_rows(21, 25, account: 2)), failing: [1])
cases << run("accounts past one batch", seed(users: (1..501).to_a, accounts: (1..501).map { account_row(_1) }, purchases: purchase_rows(1, 20, account: 501)))
cases << run("accounts past one batch, the failing one first", seed(users: (1..501).to_a, accounts: (1..501).map { account_row(_1) }, purchases: purchase_rows(1, 20, account: 1)))

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
