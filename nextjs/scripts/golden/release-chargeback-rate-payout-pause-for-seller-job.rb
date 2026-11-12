# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/release-chargeback-rate-payout-pause-for-seller-job.golden.json:
# ReleaseChargebackRatePayoutPauseForSellerJob run by the real app against a scratch database as a Sidekiq job
# (support/sidekiq_executor.rb). A seller whose hold is releasable and whose rate is within the limit reaches `with_lock`, `update!` and the
# audit comment: those cases are recorded in full, and Node hands them back at the lock's BEGIN, before any write.
# Run it like seller-update-worker.rb (env as in publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/release-chargeback-rate-payout-pause-for-seller-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[users comments purchases versions].freeze
PAUSED_INTERNALLY = User.flag_mapping["flags"][:payouts_paused_internally]
PAUSED_BY_USER = User.flag_mapping["flags"][:payouts_paused_by_user]
BUNDLE_PURCHASE = Purchase.flag_mapping["flags"][:is_bundle_product_purchase]
CHARGEBACK_REVERSED = Purchase.flag_mapping["flags"][:chargeback_reversed]
HIGH_RATE_AUTHOR = User::SYSTEM_PAYOUT_PAUSE_COMMENT_AUTHORS[:high_chargeback_rate]
FAILED_PAYOUTS_AUTHOR = User::SYSTEM_PAYOUT_PAUSE_COMMENT_AUTHORS[:repeated_failed_payouts]
RECENT_FAILURES_AUTHOR = User::SYSTEM_PAYOUT_PAUSE_COMMENT_AUTHORS[:recent_failed_purchases]
WINDOW_START = NOW - User::PAYOUT_CHARGEBACK_RATE_WINDOW
IN_WINDOW = (NOW - 30 * 86_400).strftime("%Y-%m-%d %H:%M:%S")

Rails.logger = ActiveSupport::Logger.new(nil)
ActiveJob::Base.queue_adapter = :sidekiq
ActiveJob::Base.logger = Logger.new(nil)

def stamp(time) = time.utc.strftime("%Y-%m-%d %H:%M:%S")

def user_row(id, **overrides)
  { id:, email: "user#{id}@example.com", username: "user#{id}", external_id: (1000 + id).to_s, flags: PAUSED_INTERNALLY, json_data: JSON.generate(payouts_paused_by: "system"),
    user_risk_state: "compliant", confirmed_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def comment_row(id, user: 1, **overrides)
  { id:, commentable_id: user, commentable_type: "User", author_name: HIGH_RATE_AUTHOR, comment_type: "on", content: "Payouts paused", created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def sale_row(id, seller: 1, price: 1000, **overrides)
  { id:, link_id: 1, seller_id: seller, purchase_state: "successful", price_cents: price, fee_cents: 0, flags: 0, created_at: IN_WINDOW, updated_at: IN_WINDOW }.merge(overrides)
end

def lost(id, **overrides) = sale_row(id, chargeback_date: IN_WINDOW, **overrides)

# `total` cents of sales in the window, `lost_cents` of them charged back.
def rate_sales(total, lost_cents) = [lost(1, price: lost_cents), sale_row(2, price: total - lost_cents)].reject { _1[:price_cents].zero? }

HOLD = { users: [user_row(1)], comments: [comment_row(1)] }.freeze

def run(name, seed, id = 1)
  result = capture(name, now: NOW, tables: TABLES, seed:, sidekiq: true, job: "ReleaseChargebackRatePayoutPauseForSellerJob", args: [id], at: NOW.to_f) do
    ReleaseChargebackRatePayoutPauseForSellerJob.new.perform(id)
  end
  result.delete("seed")
  result
end

def held(sales = [], **rest) = HOLD.merge(purchases: sales).merge(rest)

cases = []
cases << run("a user that does not exist", {}, 9)
cases << run("a user id of nil", HOLD, nil)
cases << run("a user suspended for fraud", held(users: [user_row(1, user_risk_state: "suspended_for_fraud")]))
cases << run("a user suspended for a tos violation", held(users: [user_row(1, user_risk_state: "suspended_for_tos_violation")]))
cases << run("a user flagged for fraud", held(users: [user_row(1, user_risk_state: "flagged_for_fraud")]))
cases << run("a user flagged for a tos violation", held(users: [user_row(1, user_risk_state: "flagged_for_tos_violation")]))
cases << run("a user on probation", held([sale_row(1)], users: [user_row(1, user_risk_state: "on_probation")]))
cases << run("a user not reviewed", held([sale_row(1)], users: [user_row(1, user_risk_state: "not_reviewed")]))
cases << run("a deleted user", held(users: [user_row(1, deleted_at: SEEDED_AT)]))
cases << run("a user whose payouts are not paused", held(users: [user_row(1, flags: 0)]))
cases << run("a user who paused payouts themselves", held(users: [user_row(1, flags: PAUSED_BY_USER)]))
cases << run("a user paused internally by an admin", held(users: [user_row(1, json_data: JSON.generate(payouts_paused_by: "admin"))]))
cases << run("a user paused internally with no source", held(users: [user_row(1, json_data: nil)]))
cases << run("a user paused internally by stripe", held(users: [user_row(1, json_data: JSON.generate(payouts_paused_by: "stripe"))]))
cases << run("a user paused by the system with no pause comment", { users: [user_row(1)] })
cases << run("a user whose pause comment is for repeated failed payouts", { users: [user_row(1)], comments: [comment_row(1, author_name: FAILED_PAYOUTS_AUTHOR)] })
cases << run("a user whose pause comment is for recent failed purchases", { users: [user_row(1)], comments: [comment_row(1, author_name: RECENT_FAILURES_AUTHOR)] })
cases << run("a user whose high rate comment is not a probation comment", { users: [user_row(1)], comments: [comment_row(1, comment_type: "note")] })
cases << run("a user whose latest pause comment is for repeated failed payouts", { users: [user_row(1)], comments: [comment_row(1), comment_row(2, author_name: FAILED_PAYOUTS_AUTHOR, created_at: "2026-02-01 00:00:00")] })
cases << run("a user whose latest pause comment is the high rate one", { users: [user_row(1)], comments: [comment_row(1, author_name: FAILED_PAYOUTS_AUTHOR), comment_row(2, created_at: "2026-02-01 00:00:00")], purchases: [sale_row(1)] })
cases << run("two pause comments created at the same time are ordered by id", { users: [user_row(1)], comments: [comment_row(2), comment_row(1, author_name: FAILED_PAYOUTS_AUTHOR)] })
cases << run("a pause comment on another user", { users: [user_row(1), user_row(2)], comments: [comment_row(1, user: 2)] })
cases << run("a pause comment on another commentable type", { users: [user_row(1)], comments: [comment_row(1, commentable_type: "Link")] })
cases << run("a deleted high rate comment", { users: [user_row(1)], comments: [comment_row(1, deleted_at: SEEDED_AT)], purchases: [sale_row(1)] })
cases << run("a releasable user with no sales", held)
cases << run("a releasable user with only sales before the window", held([sale_row(1, created_at: stamp(WINDOW_START - 1))]))
cases << run("a sale created exactly at the start of the window", held([sale_row(1, created_at: stamp(WINDOW_START)), lost(2, created_at: stamp(WINDOW_START))]))
cases << run("a releasable user with sales and no chargebacks", held([sale_row(1)]))
cases << run("a chargeback rate of exactly 1.5 percent", held(rate_sales(10_000, 150)))
cases << run("a chargeback rate that rounds to 1.5 percent", held(rate_sales(10_000, 151)))
cases << run("a chargeback rate that rounds to 1.6 percent", held(rate_sales(10_000, 155)))
cases << run("a chargeback rate of 1.6 percent", held(rate_sales(10_000, 160)))
cases << run("a chargeback rate of 100 percent", held([lost(1)]))
cases << run("a chargeback rate of 12.5 percent", held(rate_sales(8_000, 1_000)))
cases << run("a chargeback rate of 1.25 percent", held(rate_sales(8_000, 100)))
cases << run("a chargeback rate of 1.75 percent", held(rate_sales(8_000, 140)))
cases << run("a reversed chargeback is not lost", held([sale_row(1, price: 9_000), lost(2, price: 1_000, flags: CHARGEBACK_REVERSED)]))
cases << run("a fully refunded sale is out of both numbers", held([sale_row(1, price: 9_000), lost(2, price: 1_000, stripe_refunded: true)]))
cases << run("a fully refunded sale with a null refund flag is counted", held([sale_row(1, price: 9_000), lost(2, price: 1_000, stripe_refunded: nil)]))
cases << run("a bundle product purchase is out of both numbers", held([sale_row(1, price: 9_000), lost(2, price: 1_000, flags: BUNDLE_PURCHASE)]))
cases << run("a paypal sale is out of both numbers", held([sale_row(1, price: 9_000), lost(2, price: 1_000, charge_processor_id: "paypal")]))
cases << run("a stripe sale is counted", held([sale_row(1, price: 9_000), lost(2, price: 1_000, charge_processor_id: "stripe")]))
cases << run("a sale that is not successful is out of both numbers", held([sale_row(1, price: 9_000), lost(2, price: 1_000, purchase_state: "failed")]))
cases << run("a sale of another seller is out of both numbers", held([sale_row(1, price: 9_000), lost(2, price: 1_000, seller: 2)]))
cases << run("sales that are all free", held([sale_row(1, price: 0), sale_row(2, price: 0)]))
cases << run("a user id given as a digit string", held([sale_row(1)]), "1")
cases << run("a user id given as a float", held([sale_row(1)]), 1.0)
cases << run("a user id given as a word", held([sale_row(1)]), "abc")

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
