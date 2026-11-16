# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/seller-update-worker.golden.json: SellerUpdateWorker run by the real app against a
# scratch database as a Sidekiq job (support/sidekiq_executor.rb). The mail is a deliver_later push, visible in the scratch Redis.
# Run it like send-payment-reminder-worker.rb (env as in publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/seller-update-worker.golden.json")
# A Wednesday: last week is Sunday 2026-10-25 00:00 (exclusive) to Sunday 2026-11-01 00:00 (inclusive), UTC.
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
IN_WEEK = "2026-10-28 10:00:00"
START_OF_WEEK = "2026-10-25 00:00:00"
END_OF_WEEK = "2026-11-01 00:00:00"
TABLES = %w[users purchases followers affiliate_credits refunds affiliate_partial_refunds].freeze
ANNOUNCEMENT_FLAG = User.flag_mapping["flags"][:announcement_notification_enabled]
CHARGEBACK_REVERSED_FLAG = Purchase.flag_mapping["flags"][:chargeback_reversed]

Rails.logger = ActiveSupport::Logger.new(nil)
ActiveJob::Base.queue_adapter = :sidekiq
ActiveJob::Base.logger = Logger.new(nil)
$uuid_seq = 0
SecureRandom.singleton_class.prepend(Module.new do
  def uuid = format("00000000-0000-4000-8000-%012x", ($uuid_seq += 1))
end)

def user_row(id, **overrides) = { id:, email: "user#{id}@example.com", username: "user#{id}", external_id: (1000 + id).to_s, flags: ANNOUNCEMENT_FLAG, confirmed_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)

def purchase_row(id, seller: 1, **overrides)
  { id:, link_id: 1, seller_id: seller, purchase_state: "successful", price_cents: 1000, fee_cents: 100, affiliate_credit_cents: 0, flags: 0, created_at: IN_WEEK, updated_at: IN_WEEK }.merge(overrides)
end

def follower_row(id, followed: 1, **overrides)
  { id:, followed_id: followed, email: "follower#{id}@example.com", confirmed_at: SEEDED_AT, created_at: IN_WEEK, updated_at: IN_WEEK }.merge(overrides)
end

def refund_row(id, purchase:, **overrides)
  { id:, purchase_id: purchase, link_id: 1, seller_id: 1, amount_cents: 1000, fee_cents: 100, status: "succeeded", processor_refund_id: "re_#{id}", flags: 0, fee_retention_recoverable: false, created_at: IN_WEEK, updated_at: IN_WEEK }.merge(overrides)
end

def credit_row(id, affiliate: 1, **overrides)
  { id:, affiliate_user_id: affiliate, seller_id: 2, purchase_id: id, link_id: 1, amount_cents: 500, basis_points: 1000, affiliate_credit_success_balance_id: 1, created_at: IN_WEEK, updated_at: IN_WEEK }.merge(overrides)
end

def partial_refund_row(id, credit:, purchase:, **overrides)
  { id:, amount_cents: 200, purchase_id: purchase, affiliate_user_id: 1, seller_id: 2, affiliate_credit_id: credit, fee_cents: 0, created_at: IN_WEEK, updated_at: IN_WEEK }.merge(overrides)
end

def run(name, seed, id = 1, now: NOW)
  $uuid_seq = 0
  result = capture(name, now:, tables: TABLES, seed:, sidekiq: true, job: "SellerUpdateWorker", args: [id], at: now.to_f) do
    SellerUpdateWorker.new.perform(id)
  end
  result.delete("seed")
  result
end

SELLER = { users: [user_row(1)] }.freeze

cases = []
cases << run("a user that does not exist", {}, 9)
cases << run("a seller with a sale last week", SELLER.merge(purchases: [purchase_row(1)]))
cases << run("a seller with no sales or followers", SELLER)
cases << run("an id given as a digit string", SELLER.merge(purchases: [purchase_row(1)]), "1")
cases << run("a seller who turned announcements off", { users: [user_row(1, flags: 0)], purchases: [purchase_row(1)] })
cases << run("a seller with no email address", { users: [user_row(1, email: "")], purchases: [purchase_row(1)] })
cases << run("a seller with a null email address", { users: [user_row(1, email: nil)], purchases: [purchase_row(1)] })
cases << run("an unconfirmed email is the form email", { users: [user_row(1, email: "", unconfirmed_email: "new@example.com")], purchases: [purchase_row(1)] })
cases << run("a blank unconfirmed email falls back to the email", { users: [user_row(1, unconfirmed_email: "")], purchases: [purchase_row(1)] })
cases << run("a sale just after the start of last week", SELLER.merge(purchases: [purchase_row(1, created_at: "2026-10-25 00:00:01")]))
cases << run("a sale exactly at the start of last week is not counted", SELLER.merge(purchases: [purchase_row(1, created_at: START_OF_WEEK)]))
cases << run("a sale exactly at the end of last week is counted", SELLER.merge(purchases: [purchase_row(1, created_at: END_OF_WEEK)]))
cases << run("a sale after last week is not counted", SELLER.merge(purchases: [purchase_row(1, created_at: "2026-11-01 00:00:01")]))
cases << run("a sale before last week is not counted", SELLER.merge(purchases: [purchase_row(1, created_at: "2026-10-24 23:59:59")]))
cases << run("a sale that did not succeed", SELLER.merge(purchases: [purchase_row(1, purchase_state: "failed")]))
cases << run("a free sale", SELLER.merge(purchases: [purchase_row(1, price_cents: 0, fee_cents: 0)]))
cases << run("a fully refunded sale", SELLER.merge(purchases: [purchase_row(1, stripe_refunded: true)], refunds: [refund_row(1, purchase: 1)]))
cases << run("a sale of another seller", SELLER.merge(purchases: [purchase_row(1, seller: 2)]))
cases << run("a charged back sale", SELLER.merge(purchases: [purchase_row(1, chargeback_date: IN_WEEK)]))
cases << run("a charged back sale whose chargeback was reversed", SELLER.merge(purchases: [purchase_row(1, chargeback_date: IN_WEEK, flags: CHARGEBACK_REVERSED_FLAG)]))
cases << run("a partially refunded sale still earns", SELLER.merge(purchases: [purchase_row(1, stripe_partially_refunded: true)], refunds: [refund_row(1, purchase: 1, amount_cents: 400, fee_cents: 40)]))
cases << run("a refund that takes back the whole net", SELLER.merge(purchases: [purchase_row(1)], refunds: [refund_row(1, purchase: 1)]))
cases << run("a refund that failed does not count", SELLER.merge(purchases: [purchase_row(1)], refunds: [refund_row(1, purchase: 1, status: "failure")]))
cases << run("a refund with a null status counts", SELLER.merge(purchases: [purchase_row(1)], refunds: [refund_row(1, purchase: 1, status: nil)]))
cases << run("a sale whose fee exceeds the price", SELLER.merge(purchases: [purchase_row(1, price_cents: 100, fee_cents: 300)]))
cases << run("a sale with affiliate credit cents", SELLER.merge(purchases: [purchase_row(1, price_cents: 1000, fee_cents: 100, affiliate_credit_cents: 900)]))
cases << run("a sale with affiliate credit cents that cancel the net", SELLER.merge(purchases: [purchase_row(1, price_cents: 1000, fee_cents: 100, affiliate_credit_cents: 900)], affiliate_credits: [credit_row(1, affiliate: 9)]))
cases << run("an affiliate credit earned last week", SELLER.merge(affiliate_credits: [credit_row(1)]))
cases << run("an affiliate credit not yet paid", SELLER.merge(affiliate_credits: [credit_row(1, affiliate_credit_success_balance_id: nil)]))
cases << run("an affiliate credit that was refunded", SELLER.merge(affiliate_credits: [credit_row(1, affiliate_credit_refund_balance_id: 2)]))
cases << run("an affiliate credit that was charged back", SELLER.merge(affiliate_credits: [credit_row(1, affiliate_credit_chargeback_balance_id: 2)]))
cases << run("an affiliate credit of another affiliate", SELLER.merge(affiliate_credits: [credit_row(1, affiliate: 2)]))
cases << run("an affiliate credit from before last week", SELLER.merge(affiliate_credits: [credit_row(1, created_at: START_OF_WEEK)]))
cases << run("an affiliate credit at the end of last week", SELLER.merge(affiliate_credits: [credit_row(1, created_at: END_OF_WEEK)]))
cases << run("an affiliate credit of a partially refunded purchase", SELLER.merge(purchases: [purchase_row(1, seller: 2, stripe_partially_refunded: true)], affiliate_credits: [credit_row(1)], affiliate_partial_refunds: [partial_refund_row(1, credit: 1, purchase: 1)]))
cases << run("an affiliate credit whose partial refunds take back all of it", SELLER.merge(purchases: [purchase_row(1, seller: 2, stripe_partially_refunded: true)], affiliate_credits: [credit_row(1)], affiliate_partial_refunds: [partial_refund_row(1, credit: 1, purchase: 1, amount_cents: 500)]))
cases << run("an affiliate credit with two partial refund rows", SELLER.merge(purchases: [purchase_row(1, seller: 2, stripe_partially_refunded: true)], affiliate_credits: [credit_row(1)], affiliate_partial_refunds: [partial_refund_row(1, credit: 1, purchase: 1, amount_cents: 100), partial_refund_row(2, credit: 1, purchase: 1, amount_cents: 100)]))
cases << run("a partially refunded sale with an affiliate partial refund", SELLER.merge(purchases: [purchase_row(1, affiliate_credit_cents: 50, stripe_partially_refunded: true)], affiliate_partial_refunds: [partial_refund_row(1, credit: 1, purchase: 1, amount_cents: 50)]))
cases << run("a refund that gives back part of the fee keeps the net positive", SELLER.merge(purchases: [purchase_row(1, price_cents: 1000, fee_cents: 800)], refunds: [refund_row(1, purchase: 1, amount_cents: 500, fee_cents: 400)]))
cases << run("an unpaid affiliate credit eaten by its partial refunds", SELLER.merge(purchases: [purchase_row(1, price_cents: 1000, fee_cents: 100, affiliate_credit_cents: 900), purchase_row(2, seller: 2, stripe_partially_refunded: true)], affiliate_credits: [credit_row(1, affiliate_credit_success_balance_id: nil, purchase_id: 2)], affiliate_partial_refunds: [partial_refund_row(1, credit: 1, purchase: 2, amount_cents: 600)]))
cases << run("an affiliate partial refund on a sale gives back part of the fee", SELLER.merge(purchases: [purchase_row(1, price_cents: 1000, fee_cents: 100, affiliate_credit_cents: 900)], affiliate_partial_refunds: [partial_refund_row(1, credit: 1, purchase: 1, amount_cents: 50)]))
cases << run("a follower last week", SELLER.merge(followers: [follower_row(1)]))
cases << run("a follower who never confirmed", SELLER.merge(followers: [follower_row(1, confirmed_at: nil)]))
cases << run("a follower who unfollowed", SELLER.merge(followers: [follower_row(1, deleted_at: IN_WEEK)]))
cases << run("a follower of another seller", SELLER.merge(followers: [follower_row(1, followed: 2)]))
cases << run("a follower from before last week", SELLER.merge(followers: [follower_row(1, created_at: START_OF_WEEK)]))
cases << run("a follower at the end of last week", SELLER.merge(followers: [follower_row(1, created_at: END_OF_WEEK)]))
cases << run("a follower after last week", SELLER.merge(followers: [follower_row(1, created_at: "2026-11-01 00:00:01")]))
cases << run("a follower and a sale", SELLER.merge(purchases: [purchase_row(1)], followers: [follower_row(1)]))
cases << run("on a Sunday the week that just ended is last week", SELLER.merge(purchases: [purchase_row(1, created_at: "2026-11-01 12:00:00")]), now: Time.utc(2026, 11, 8, 23, 59, 59))
cases << run("on a Sunday the sale of that Sunday is not counted", SELLER.merge(purchases: [purchase_row(1, created_at: "2026-11-08 12:00:00")]), now: Time.utc(2026, 11, 8, 23, 59, 59))
cases << run("on a Monday at midnight", SELLER.merge(purchases: [purchase_row(1, created_at: "2026-11-05 12:00:00")]), now: Time.utc(2026, 11, 9, 0, 0, 0))
cases << run("a sale during a year end", SELLER.merge(purchases: [purchase_row(1, created_at: "2026-12-30 12:00:00")]), now: Time.utc(2027, 1, 2, 12, 0, 0))

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
