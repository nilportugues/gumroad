# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/enforce-refund-policy-for-seller-job.golden.json: EnforceRefundPolicyForSellerJob run
# by the real app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). A seller whose dispute rate calls for
# the enforcement (the seller update, the refund policy bump and the admin comment) is what Node hands back to Rails; those cases
# are recorded up to the seller's transaction, which a marker exception stands in for. Run it like publish-scheduled-post.rb:
#
#   bundle exec rails runner nextjs/scripts/golden/enforce-refund-policy-for-seller-job.rb   (env as in publish-scheduled-post.rb)
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/enforce-refund-policy-for-seller-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[users purchases].freeze
REFUND_POLICY_ENFORCED = 1 << 52
CHARGEBACK_REVERSED = Purchase.flag_mapping["flags"][:chargeback_reversed]

Rails.logger = ActiveSupport::Logger.new(nil)

class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

User.prepend(Module.new do
  def transaction(*) = raise(HandBackMarker)
end)

def user_row(id, **overrides)
  { id:, email: "user#{id}@example.com", username: "user#{id}", external_id: (1000 + id).to_s, user_risk_state: "compliant", flags: 0, confirmed_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def sale(id, email: "buyer#{id}@example.com", seller: 1, **overrides)
  { id:, seller_id: seller, link_id: 1, email:, price_cents: 500, purchase_state: "successful", charge_processor_id: "stripe", flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def disputed = { chargeback_date: "2026-02-01 00:00:00" }

# `settled` successful sales to distinct buyers, the first `disputes` of them charged back.
def book(settled, disputes, first_id: 1)
  (0...settled).map { |i| sale(first_id + i, **(i < disputes ? disputed : {})) }
end

def run(name, args, sales: [], users: [user_row(1)])
  hands_back = false
  result = capture(name, now: NOW, tables: TABLES, seed: { users:, purchases: sales }, sidekiq: true, job: "EnforceRefundPolicyForSellerJob", args:) do
    EnforceRefundPolicyForSellerJob.new.perform(*args)
  rescue HandBackMarker
    hands_back = true
  end
  result.delete("rows")
  result.delete("seed")
  result.merge("hands_back" => hands_back)
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

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
