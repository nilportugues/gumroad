# frozen_string_literal: true

require "spec_helper"

# Records every request the Elasticsearch transport performs while a log is set, with its answer.
module EsExchangeLog
  def perform_request(method, path, params = {}, body = nil, *rest)
    response = super
    Thread.current[:es_exchange_log]&.push(
      "method" => method, "path" => path, "query" => params.to_h.sort.to_h.transform_keys(&:to_s).transform_values(&:to_s),
      "body" => body.is_a?(String) ? body : body.to_json, "status" => response.status, "response" => response.body
    )
    response
  end
end
Elasticsearch::Transport::Transport::Base.prepend(EsExchangeLog)

# User#sales_cents_total and #eligible_for_store_agent? against the real Elasticsearch, recorded for
# the Next.js port: nextjs/src/server/search/purchase-sales.ts replays the requests and responses
# (nextjs/src/server/search/__fixtures__/sales-cents-total.golden.json) and must send these bodies
# and add up these answers.
#
#   SALES_CENTS_TOTAL_GOLDEN=1 bundle exec rspec spec/models/user/sales_cents_total_spec.rb
describe "User#sales_cents_total", :elasticsearch_wait_for_refresh do
  golden_path = Rails.root.join("nextjs/src/server/search/__fixtures__/sales-cents-total.golden.json")
  recorded = []

  # Returns the total; keeps the exchanges that produced it (and the store agent verdict) for the golden.
  define_method(:record) do |name, user, store_agent: false|
    log = Thread.current[:es_exchange_log] = []
    total = user.sales_cents_total
    eligibility = store_agent ? user.eligible_for_store_agent? : nil
    recorded << { "name" => name, "user_id" => user.id, "index" => Purchase.index_name, "total" => total, "eligible_for_store_agent" => eligibility, "exchanges" => log }
    total
  ensure
    Thread.current[:es_exchange_log] = nil
  end

  after(:all) do
    File.write(golden_path, JSON.pretty_generate("cases" => recorded) + "\n") if ENV["SALES_CENTS_TOTAL_GOLDEN"] && recorded.any?
  end

  let(:seller) { create(:user) }

  # The purchase factory charges through Stripe on create; these rows only need to exist and be indexed.
  def sale(price_cents:, **attributes)
    build(:purchase, link: create(:product, user: seller, price_cents:), **attributes).tap { _1.save!(validate: false) }
  end

  it "is zero for a seller with no sales" do
    index_model_records(Purchase)

    expect(record("a seller with no sales", seller)).to eq(0)
  end

  it "adds up the net revenue of charged sales and leaves out refunded, charged back and free ones" do
    sale(price_cents: 15_000)
    sale(price_cents: 2_500)
    sale(price_cents: 9_900, stripe_refunded: true)
    sale(price_cents: 8_000, chargeback_date: 1.day.ago)
    sale(price_cents: 0)
    partially_refunded = sale(price_cents: 4_000, stripe_partially_refunded: true)
    create(:refund, purchase: partially_refunded, amount_cents: 1_000, fee_cents: 130)
    index_model_records(Purchase)

    total = record("a seller with sales, a refund, a partial refund, a chargeback and a free sale", seller)

    expect(total).to be_between(1, 15_000 + 2_500 + 4_000)
  end

  it "counts what an affiliate earned from other sellers' sales" do
    affiliate = create(:user)
    purchase = sale(price_cents: 20_000)
    create(:affiliate_credit, purchase:, affiliate_user: affiliate, amount_cents: 1_500, fee_cents: 150)
    index_model_records(Purchase)

    expect(record("an affiliate", affiliate)).to be > 0
    expect(record("the seller whose sale paid an affiliate", seller)).to be > 0
  end

  it "makes a seller with completed payouts and at least $100 in sales eligible for the store agent" do
    sale(price_cents: 15_000)
    create(:payment_completed, user: seller)
    index_model_records(Purchase)

    record("eligible for the store agent", seller, store_agent: true)

    expect(seller.eligible_for_store_agent?).to eq(true)
  end

  it "keeps a seller with completed payouts and under $100 in sales out of the store agent" do
    sale(price_cents: 5_000)
    create(:payment_completed, user: seller)
    index_model_records(Purchase)

    record("under the store agent bar", seller, store_agent: true)

    expect(seller.eligible_for_store_agent?).to eq(false)
  end
end
