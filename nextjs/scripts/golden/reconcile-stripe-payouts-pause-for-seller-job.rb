# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/reconcile-stripe-payouts-pause-for-seller-job.golden.json:
# ReconcileStripePayoutsPauseForSellerJob run by the real app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb).
# A seller who is still Stripe-paused with a Gumroad-managed account reaches Stripe::Account.retrieve: those cases are recorded up to there,
# which a marker exception stands in for, and Node hands them back to Rails (`hands_back`). Run it like
# release-chargeback-rate-payout-pause-for-seller-job.rb (env as in publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/reconcile-stripe-payouts-pause-for-seller-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[users comments merchant_accounts].freeze
PAUSED_INTERNALLY = User.flag_mapping["flags"][:payouts_paused_internally]
PAUSED_BY_USER = User.flag_mapping["flags"][:payouts_paused_by_user]
HOLD_AUTHOR = User::SYSTEM_PAYOUT_PAUSE_COMMENT_AUTHORS[:repeated_failed_payouts]
MARKER = StripePayoutProcessor::UNACCOUNTED_MONEY_HOLD_MARKER

Rails.logger = ActiveSupport::Logger.new(nil)
ActiveJob::Base.queue_adapter = :sidekiq
ActiveJob::Base.logger = Logger.new(nil)

class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

Stripe::Account.singleton_class.prepend(Module.new do
  def retrieve(*, **) = raise(HandBackMarker)
end)

def user_row(id, **overrides)
  { id:, email: "user#{id}@example.com", username: "user#{id}", external_id: (1000 + id).to_s, flags: PAUSED_INTERNALLY, json_data: JSON.generate(payouts_paused_by: "stripe"),
    user_risk_state: "compliant", confirmed_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def account_row(id, user: 1, **overrides)
  { id:, user_id: user, charge_processor_id: "stripe", charge_processor_merchant_id: "acct_#{id}", charge_processor_alive_at: SEEDED_AT, json_data: nil, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def comment_row(id, user: 1, **overrides)
  { id:, commentable_id: user, commentable_type: "User", author_name: HOLD_AUTHOR, comment_type: "on", content: "Payouts held: the payout #{MARKER}", created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def resumed(id, **overrides) = comment_row(id, author_name: "Someone", comment_type: "payouts_resumed", content: "Payouts resumed", **overrides)

PAUSED = { users: [user_row(1)], merchant_accounts: [account_row(1)] }.freeze

def run(name, seed, id = 1)
  hands_back = false
  result = capture(name, now: NOW, tables: TABLES, seed:, sidekiq: true, job: "ReconcileStripePayoutsPauseForSellerJob", args: [id], at: NOW.to_f) do
    ReconcileStripePayoutsPauseForSellerJob.new.perform(id)
  rescue HandBackMarker
    hands_back = true
  end
  result.delete("seed")
  result.delete("rows")
  result.merge("hands_back" => hands_back)
end

def paused(**rest) = PAUSED.merge(rest)

cases = []
cases << run("a user that does not exist", {}, 9)
cases << run("a user id of nil", PAUSED, nil)
cases << run("a user id as a digit string", PAUSED, "1")
cases << run("a user id as a float", PAUSED, 1.0)
cases << run("a user id as a word", PAUSED, "abc")
cases << run("a user suspended for fraud", paused(users: [user_row(1, user_risk_state: "suspended_for_fraud")]))
cases << run("a user suspended for a tos violation", paused(users: [user_row(1, user_risk_state: "suspended_for_tos_violation")]))
cases << run("a user flagged for fraud", paused(users: [user_row(1, user_risk_state: "flagged_for_fraud")]))
cases << run("a user flagged for a tos violation", paused(users: [user_row(1, user_risk_state: "flagged_for_tos_violation")]))
cases << run("a user on probation", paused(users: [user_row(1, user_risk_state: "on_probation")]))
cases << run("a deleted user", paused(users: [user_row(1, deleted_at: SEEDED_AT)]))
cases << run("a user whose payouts are not paused", paused(users: [user_row(1, flags: 0)]))
cases << run("a user who paused payouts themselves", paused(users: [user_row(1, flags: PAUSED_BY_USER)]))
cases << run("a user who paused payouts themselves and is paused by stripe", paused(users: [user_row(1, flags: PAUSED_INTERNALLY | PAUSED_BY_USER)]))
cases << run("a user paused internally by an admin", paused(users: [user_row(1, json_data: JSON.generate(payouts_paused_by: "admin"))]))
cases << run("a user paused internally by the system", paused(users: [user_row(1, json_data: JSON.generate(payouts_paused_by: "system"))]))
cases << run("a user paused internally with no source", paused(users: [user_row(1, json_data: nil)]))
cases << run("a user paused internally with an unknown source", paused(users: [user_row(1, json_data: JSON.generate(payouts_paused_by: "other"))]))
cases << run("a stripe pause with no merchant account", { users: [user_row(1)] })
cases << run("a stripe pause with a merchant account of another user", paused(merchant_accounts: [account_row(1, user: 2)]))
cases << run("a deleted merchant account", paused(merchant_accounts: [account_row(1, deleted_at: SEEDED_AT)]))
cases << run("a merchant account whose charge processor is not alive", paused(merchant_accounts: [account_row(1, charge_processor_alive_at: nil)]))
cases << run("a merchant account whose charge processor was deleted", paused(merchant_accounts: [account_row(1, charge_processor_deleted_at: SEEDED_AT)]))
cases << run("a paypal merchant account", paused(merchant_accounts: [account_row(1, charge_processor_id: "paypal")]))
cases << run("a stripe connect merchant account", paused(merchant_accounts: [account_row(1, json_data: JSON.generate(meta: { stripe_connect: "true" }))]))
cases << run("a merchant account with a blank stripe id", paused(merchant_accounts: [account_row(1, charge_processor_merchant_id: "")]))
cases << run("a merchant account with no stripe id", paused(merchant_accounts: [account_row(1, charge_processor_merchant_id: nil)]))
cases << run("a merchant account with a whitespace stripe id", paused(merchant_accounts: [account_row(1, charge_processor_merchant_id: "  ")]))
cases << run("a connect account next to a managed one", paused(merchant_accounts: [account_row(1, json_data: JSON.generate(meta: { stripe_connect: "true" })), account_row(2)]))
cases << run("a managed account that is still live", paused)
cases << run("an unaccounted money hold", paused(comments: [comment_row(1)]))
cases << run("an unaccounted money hold resumed since", paused(comments: [comment_row(1), resumed(2, created_at: "2026-02-01 00:00:00")]))
cases << run("an unaccounted money hold made after the last resume", paused(comments: [resumed(1), comment_row(2, created_at: "2026-02-01 00:00:00")]))
cases << run("an unaccounted money hold made at the moment of the last resume", paused(comments: [resumed(1), comment_row(2)]))
cases << run("a hold comment by another author", paused(comments: [comment_row(1, author_name: "Someone")]))
cases << run("a hold comment without the marker", paused(comments: [comment_row(1, content: "Payouts held")]))
cases << run("a hold comment that is not a probation comment", paused(comments: [comment_row(1, comment_type: "note")]))
cases << run("a deleted hold comment", paused(comments: [comment_row(1, deleted_at: SEEDED_AT)]))
cases << run("a hold comment of another user", paused(users: [user_row(1), user_row(2)], comments: [comment_row(1, user: 2)]))
cases << run("a hold comment on another commentable type", paused(comments: [comment_row(1, commentable_type: "Link")]))
cases << run("a resume comment of another user", paused(users: [user_row(1), user_row(2)], comments: [comment_row(1), resumed(2, user: 2, created_at: "2026-02-01 00:00:00")]))
cases << run("a deleted resume comment", paused(comments: [comment_row(1), resumed(2, created_at: "2026-02-01 00:00:00", deleted_at: SEEDED_AT)]))
cases << run("two resume comments", paused(comments: [comment_row(1, created_at: "2026-03-01 00:00:00"), resumed(2, created_at: "2026-02-01 00:00:00"), resumed(3, created_at: "2026-01-15 00:00:00")]))

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
