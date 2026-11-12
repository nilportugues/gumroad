# frozen_string_literal: true

require "spec_helper"

# POST /orders for a free ($0, USD, one-time) product, sent the way the checkout page sends it
# (nextjs/src/server/controllers/orders-free-purchase.ts). Written for recording (PARITY_RECORD=1).
#
# `parity_timeline` records the order of the statements and jobs; `defer_audience_refresh` keeps the
# audience projection a queued job as in production; mail deliveries are ActiveJobs, which the test
# adapter swallows, so the adapter is the Sidekiq one for the examples.
describe "Orders free purchase", type: :request, parity: true, parity_timeline: true, defer_audience_refresh: true do
  include Parity::AudienceSignedIn

  let(:seller) { create(:user) }
  let(:product) { create(:product, user: seller, unique_permalink: "freeone", price_cents: 0) }
  let(:json_headers) do
    { "Accept" => "application/json", "X-Requested-With" => "XMLHttpRequest", "Content-Type" => "application/json", "Referer" => "http://#{DOMAIN}/checkout" }
  end

  before { host! DOMAIN }

  around do |example|
    previous = ActiveJob::Base.queue_adapter
    ActiveJob::Base.queue_adapter = :sidekiq
    example.run
  ensure
    ActiveJob::Base.queue_adapter = previous
  end

  def post_order(body, user_agent: nil)
    token = csrf_token
    headers = json_headers.merge("X-CSRF-Token" => token)
    headers["User-Agent"] = user_agent if user_agent
    post "/orders", params: body.to_json, headers:
  end

  # The line the checkout page builds for a plain product (data/purchase.ts createPurchasesRequestData).
  def line(item = product, uid: "uid-0", **extra)
    {
      uid:, permalink: item.unique_permalink, is_multi_buy: false, is_preorder: false, is_rental: false,
      perceived_price_cents: 0, price_cents: 0, tip_cents: nil, quantity: 1, price_range: "", pay_in_installments: false,
      bundle_products: [], variants: [], call_start_time: "", discount_code: "", was_product_recommended: false,
      recommended_by: "", recommender_model_name: "", affiliate_id: "", url_parameters: "{}", referrer: "direct",
      is_purchasing_power_parity_discounted: false, accepts_purchasing_power_parity_discount: true,
      force_new_subscription: false, custom_fields: []
    }.merge(extra)
  end

  def order_body(*lines, **extra)
    {
      plugins: "", friend: "", url_parameters: "{}", locale: "en", email: "buyer@example.com", tax_country_election: "",
      is_gift: false, vat_id: "", "g-recaptcha-response": "", recaptcha_challenge_fallback: false, buyer_currency_quote: "",
      cc_zipcode_required: "false", purchase: {}, line_items: lines
    }.merge(extra)
  end

  def line_response(uid = "uid-0") = response.parsed_body.dig("line_items", uid)

  it "creates a free purchase for a signed-out buyer" do
    product
    post_order(order_body(line))

    expect(line_response).to include("success" => true, "email" => "buyer@example.com", "account_by_this_email_exists" => false)
    expect(response.parsed_body).to include("can_buyer_sign_up" => true)
  end

  it "creates a free purchase from a request that carries only the essentials" do
    product
    post_order({ email: "buyer@example.com", cc_zipcode_required: "false", line_items: [{ uid: "uid-0", permalink: "freeone", perceived_price_cents: "0" }] })

    expect(line_response).to include("success" => true, "quantity" => 1)
  end

  it "stores the email the way the purchase normalises it" do
    product
    post_order(order_body(line, email: "  Buyer.Mixed@Example.COM "))

    expect(line_response).to include("success" => true, "email" => "buyer.mixed@example.com")
  end

  it "ties the purchase to the confirmed account that owns the email" do
    product
    create(:user, email: "owner@example.com")
    post_order(order_body(line, email: "owner@example.com"))

    expect(line_response).to include("success" => true, "account_by_this_email_exists" => true)
    expect(response.parsed_body).to include("can_buyer_sign_up" => false)
  end

  it "creates a free purchase for a signed-in buyer" do
    product
    buyer = create(:user)
    log_in(buyer)
    post_order(order_body(line, email: buyer.email))

    expect(line_response).to include("success" => true, "account_by_this_email_exists" => true)
    expect(response.parsed_body).to include("can_buyer_sign_up" => false)
  end

  it "creates a free purchase for a signed-in buyer who buys with another email" do
    product
    buyer = create(:user)
    log_in(buyer)
    post_order(order_body(line, email: "other@example.com"))

    expect(line_response).to include("success" => true, "email" => "other@example.com")
  end

  it "creates a free purchase of a product with a file" do
    product.product_files << create(:product_file, link: product)
    post_order(order_body(line))

    expect(line_response).to include("success" => true, "has_files" => true)
  end

  it "copies the product refund policy when the account-level one is off" do
    seller.update!(refund_policy_enabled: false)
    create(:product_refund_policy, product:, seller:, max_refund_period_in_days: 14, fine_print: "Fourteen days")
    product.update!(product_refund_policy_enabled: true)
    post_order(order_body(line))

    expect(line_response).to include("success" => true)
  end

  it "creates a free purchase when the seller offers no refund policy" do
    seller.update!(refund_policy_enabled: false)
    post_order(order_body(line))

    expect(line_response).to include("success" => true)
  end

  it "lets the same email take the product a second time" do
    build(:purchase, link: product, email: "buyer@example.com", price_cents: 0, total_transaction_cents: 0, purchase_state: "successful").save!(validate: false)
    post_order(order_body(line))

    expect(line_response).to include("success" => true)
  end

  it "answers a free product with a custom receipt and a sale ping endpoint" do
    seller.update!(notification_endpoint: "https://example.com/ping")
    product.update!(custom_receipt: "Thank you for downloading")
    post_order(order_body(line))

    expect(line_response).to include("success" => true)
  end

  it "records the buyer's browser details on the purchase and the event" do
    product
    post_order(order_body(line, plugins: "plugin-a", friend: "friend-b", url_parameters: "{\"a\":\"b\"}", locale: "fr"), user_agent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1")

    expect(line_response).to include("success" => true)
  end

  it "records the referrer and the url parameters of the line" do
    product
    post_order(order_body(line(referrer: "https://news.example.com/post?x=1", url_parameters: "{\"utm_source\":\"news\",\"code\":\"drop\"}")))

    expect(line_response).to include("success" => true)
  end

  it "hands an order of a seller with a workflow" do
    product
    create(:seller_workflow, seller:)
    post_order(order_body(line))

    expect(line_response).to include("success" => true)
  end

  it "hands an order of a product with a purchase limit" do
    product.update!(max_purchase_count: 10)
    post_order(order_body(line))

    expect(line_response).to include("success" => true)
  end

  it "hands an order from a buyer with a cart" do
    product
    buyer = create(:user)
    log_in(buyer)
    create(:cart, user: buyer)
    post_order(order_body(line, email: buyer.email))

    expect(line_response).to include("success" => true)
  end

  it "hands an order of a seller who sells with an affiliate" do
    product
    affiliate = create(:direct_affiliate, seller:, products: [product])
    post_order(order_body(line(affiliate_id: affiliate.external_id)))

    expect(line_response).to include("success" => true)
  end

  it "hands an order of two free products" do
    other = create(:product, user: seller, unique_permalink: "freetwo", price_cents: 0)
    product
    post_order(order_body(line, line(other, uid: "uid-1")))

    expect(response.parsed_body["line_items"].keys).to eq(%w[uid-0 uid-1])
  end

  it "hands a repeated free download from one address" do
    product
    3.times do |i|
      build(:purchase, link: product, email: "early#{i}@example.com", price_cents: 0, total_transaction_cents: 0, purchase_state: "successful", ip_address: "127.0.0.1").save!(validate: false)
    end
    post_order(order_body(line))

    expect(line_response).to include("success" => true)
  end

  it "hands an order of a free product with a discount code" do
    product
    post_order(order_body(line(discount_code: "FREE")))

    expect(line_response).to include("success" => false)
  end

  it "hands an order of a free membership" do
    membership = create(:membership_product, user: seller, unique_permalink: "freemembr", price_cents: 0)
    post_order(order_body(line(membership)))

    expect(response.parsed_body).to include("success" => true)
  end
end
