# frozen_string_literal: true

# Produces nextjs/src/server/models/__fixtures__/user-balance-stats.golden.json: UserBalanceStatsService's overview figures
# (the unpaid balance and the sales totals of the last 7 days, 28 days and ever) as the real service computes them, with every
# statement and Elasticsearch request. The recorder's socket answers each search with the case's `es_body`. Run it like
# publish-scheduled-post.rb:
#
#   bundle exec rails runner nextjs/scripts/golden/user-balance-stats.rb   (env as in publish-scheduled-post.rb)
require_relative "support/rails_cases"
include RailsCases
capture_elasticsearch!

OUT = Rails.root.join("nextjs/src/server/models/__fixtures__/user-balance-stats.golden.json")
NOW = Time.utc(2025, 11, 1, 12, 30, 45, 123_000)
SEEDED_AT = "2025-01-01 00:00:00"
TABLES = %w[users balances].freeze

# Every aggregation either search reads, with the seller's price sum and a refund, an affiliate credit and a partial refund of it.
def es_answer(price:, refunded: 0, own_credit: 0, own_refunded: 0)
  seller = %w[price_cents fee_cents amount_refunded_cents fee_refunded_cents affiliate_credit_amount_cents affiliate_credit_amount_partially_refunded_cents
              direct_affiliate_credit_amount_cents direct_affiliate_credit_amount_partially_refunded_cents].to_h { ["#{_1}_total", { "value" => 0 }] }
  seller["price_cents_total"] = { "value" => price }
  seller["amount_refunded_cents_total"] = { "value" => refunded }
  own = %w[affiliate_credit direct_affiliate_credit].product(%w[amount_cents fee_cents amount_partially_refunded_cents fee_partially_refunded_cents])
    .to_h { |prefix, measure| ["#{prefix}_#{measure}_own", { "total" => { "value" => 0 } }] }
  own["affiliate_credit_amount_cents_own"] = { "total" => { "value" => own_credit } }
  own["affiliate_credit_amount_partially_refunded_cents_own"] = { "total" => { "value" => own_refunded } }
  { "aggregations" => seller.merge(own) }
end

def user_row(id) = { id:, email: "user#{id}@example.com", username: "user#{id}", external_id: (1000 + id).to_s, recommendation_type: "own_products", user_risk_state: "compliant", flags: 0, json_data: nil, confirmed_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT }
def balance_row(id, amount, state: "unpaid") = { id:, user_id: 1, date: "2025-10-01", amount_cents: amount, state:, created_at: SEEDED_AT, updated_at: SEEDED_AT }

cases = []
call = lambda do |name, es_body:, **seed|
  result = capture(name, now: NOW, tables: TABLES, seed: { users: [user_row(1)] }.merge(seed), sidekiq: true, case_now: NOW.to_f, es_body:) do
    $return = UserBalanceStatsService.new(user: User.find(1)).send(:overview_stats)
  end
  result.delete("rows")
  result.delete("seed")
  result["return"] = result["error"] ? nil : $return.as_json
  cases << result
end

call.call("no balance and no sales", es_body: es_answer(price: 0))
call.call("an unpaid balance", es_body: es_answer(price: 0), balances: [balance_row(1, 4000), balance_row(2, 1500), balance_row(3, 9999, state: "paid")])
call.call("sales as a seller", es_body: es_answer(price: 120_000, refunded: 20_000), balances: [balance_row(1, 4000)])
call.call("sales as an affiliate", es_body: es_answer(price: 0, own_credit: 7000, own_refunded: 1500))
call.call("sales as a seller and an affiliate", es_body: es_answer(price: 50_000, own_credit: 7000, own_refunded: 1500))
call.call("a search answered without aggregations", es_body: {})

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
