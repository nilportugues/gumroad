# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/enforce-refund-policy-for-seller-job.golden.json: EnforceRefundPolicyForSellerJob run
# by the real app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). A seller whose dispute rate calls for
# the enforcement runs the whole seller.transaction (user update, refund policy bump, admin comment) and enqueues the notification
# mail; those cases record every statement, the Sidekiq push and the Elasticsearch calls of the user save. Only the statements,
# Redis and cache are kept: the purchases seeded to reach the volume gates stay out of the fixture. Run it like
# publish-scheduled-post.rb:
#
#   bundle exec rails runner nextjs/scripts/golden/enforce-refund-policy-for-seller-job.rb   (env as in publish-scheduled-post.rb)
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/enforce-refund-policy-for-seller-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[users purchases refund_policies comments versions seller_profiles links].freeze
REFUND_POLICY_ENFORCED = 1 << 52
CHARGEBACK_REVERSED = Purchase.flag_mapping["flags"][:chargeback_reversed]

Rails.logger = ActiveSupport::Logger.new(nil)

ActiveJob::Base.queue_adapter = :sidekiq
ActiveJob::Base.logger = Logger.new(nil)
capture_elasticsearch!

def user_row(id, **overrides)
  { id:, email: "user#{id}@example.com", username: "user#{id}", external_id: (1000 + id).to_s, user_risk_state: "compliant", recommendation_type: "own_products", flags: 0, confirmed_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def sale(id, email: "buyer#{id}@example.com", seller: 1, **overrides)
  { id:, seller_id: seller, link_id: 1, email:, price_cents: 500, purchase_state: "successful", charge_processor_id: "stripe", flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def disputed = { chargeback_date: "2026-02-01 00:00:00" }

# `settled` successful sales to distinct buyers, the first `disputes` of them charged back.
def book(settled, disputes, first_id: 1)
  (0...settled).map { |i| sale(first_id + i, **(i < disputes ? disputed : {})) }
end

def policy(seller, days, **overrides)
  { id: 70 + seller, seller_id: seller, product_id: nil, max_refund_period_in_days: days, fine_print: nil, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def run(name, args, sales: [], users: [user_row(1)], policies: [])
  result = capture(name, now: NOW, tables: TABLES, seed: { users:, purchases: sales, refund_policies: policies }, sidekiq: true, job: "EnforceRefundPolicyForSellerJob", args:) do
    EnforceRefundPolicyForSellerJob.new.perform(*args)
  end
  result.delete("rows")
  result.delete("seed")
  result
end

cases = []
cases << run("a purchase that does not exist", [99])
cases << run("the digits of the id", ["1"], sales: book(30, 0))
cases << run("a purchase with no seller", [1], sales: [sale(1, seller: nil)])
cases << run("a purchase whose seller does not exist", [1], sales: [sale(1, seller: 9)])
cases << run("a seller already enforced", [1], sales: book(30, 5), users: [user_row(1, flags: REFUND_POLICY_ENFORCED)])
cases << run("a seller with other flags set", [1], sales: book(30, 5), users: [user_row(1, flags: 3)])
cases << run("a seller with too few sales", [1], sales: book(24, 5))
cases << run("a seller with exactly the sales", [1], sales: book(25, 3))
cases << run("a seller with too few disputing buyers", [1], sales: book(300, 2))
cases << run("a seller with a high rate from too few disputing buyers", [1], sales: book(30, 2))
cases << run("a seller at the dispute rate allowed", [1], sales: book(300, 3))
cases << run("a seller just past the dispute rate allowed", [1], sales: book(299, 3))
cases << run("a seller far past the dispute rate allowed", [1], sales: book(40, 10))
cases << run("sales to one buyer count once", [1], sales: book(30, 0) + (31..40).map { sale(_1, email: "repeat@example.com", **disputed) })
cases << run("several disputes by one buyer count once", [1], sales: book(300, 0) + (301..310).map { sale(_1, email: "repeat@example.com", **disputed) })
cases << run("sales that were not successful", [1], sales: book(24, 5) + (25..40).map { sale(_1, purchase_state: "failed") })
cases << run("sales through PayPal", [1], sales: book(24, 5) + (25..40).map { sale(_1, charge_processor_id: "paypal", **disputed) })
cases << run("sales with no processor", [1], sales: book(30, 5).map { _1.merge(charge_processor_id: nil) })
cases << run("a chargeback that was reversed", [1], sales: book(300, 3) + (301..310).map { sale(_1, **disputed, flags: CHARGEBACK_REVERSED) })
cases << run("sales of another seller", [1], sales: book(30, 5, first_id: 100).map { _1.merge(seller_id: 2) } + book(10, 0), users: [user_row(1), user_row(2)])
cases << run("sales with no email", [1], sales: book(30, 0) + (31..45).map { sale(_1, email: nil, **disputed) })
cases << run("sales with an email in another case", [1], sales: book(300, 0) + (301..310).map { |id| sale(id, email: id.even? ? "Same@Example.com" : "same@example.com", **disputed) })
cases << run("no id", [])

# The enforcement itself. `book(30, 5)` is 5 of 30 buyers, 16.7%.
cases << run("a seller without a refund policy", [1], sales: book(30, 5))
cases << run("a seller whose policy offers no refunds", [1], sales: book(30, 5), policies: [policy(1, 0)])
cases << run("a policy with no refunds and a fine print", [1], sales: book(30, 5), policies: [policy(1, 0, fine_print: "All sales are final")])
cases << run("a policy that already guarantees refunds", [1], sales: book(30, 5), policies: [policy(1, 14, fine_print: "Ask nicely")])
cases << run("a product level policy is not the seller policy", [1], sales: book(30, 5), policies: [policy(1, 0, id: 80, product_id: 3, seller_id: 1), policy(2, 0)])
cases << run("a rate that rounds down at a tie", [1], sales: book(400, 5), policies: [policy(1, 7)])
cases << run("a rate that rounds up at a tie", [1], sales: book(400, 15), policies: [policy(1, 7)])
cases << run("a rate rounded to the tenth", [1], sales: book(299, 3), policies: [policy(1, 7)])
cases << run("a rate of a hundred percent", [1], sales: book(30, 30))
cases << run("a policy with no period rolls the enforcement back", [1], sales: book(30, 5), policies: [policy(1, nil)])
cases << run("a seller who has other flags set", [1], sales: book(30, 5), users: [user_row(1, flags: 3)], policies: [policy(1, 0)])
cases << run("a seller whose account is deleted", [1], sales: book(30, 5), users: [user_row(1, deleted_at: SEEDED_AT)], policies: [policy(1, 0)])
cases << run("a seller with a name and a bio", [1], sales: book(30, 5), users: [user_row(1, name: "Seller One", bio: "Hi")], policies: [policy(1, 0)])
cases << run("the digits of the id enforce too", ["1"], sales: book(30, 5), policies: [policy(1, 0)])

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
