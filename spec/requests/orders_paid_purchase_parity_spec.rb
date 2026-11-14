# frozen_string_literal: true

require "spec_helper"

# POST /orders for a paid ($5, USD, one-time) product bought with a tokenized card, sent the way the checkout page sends it.
# Written for recording (PARITY_RECORD=1) and for the parity timeline: the order of the statements, the Stripe calls and the jobs.
#
# Stripe is never reached. The cassettes under vcr_cassettes/Orders_paid_purchase are copies of the existing
# OrdersController recordings, replayed with `record: :none`, so a call the cassette does not hold raises instead of going out.
#
# The examples are named "hands ...": Node does not serve a paid order yet, so its replay asserts that the request reaches Rails whole
# and writes nothing. The recorded timeline is the evidence of the order a port has to keep.
describe "Orders paid purchase", type: :request, parity: true, parity_timeline: true, defer_audience_refresh: true do
  include Parity::AudienceSignedIn

  let(:seller) { create(:user) }
  let(:product) { create(:product, user: seller, unique_permalink: "paidone", price_cents: 5_00) }
  let(:json_headers) do
    { "Accept" => "application/json", "X-Requested-With" => "XMLHttpRequest", "Content-Type" => "application/json", "Referer" => "http://#{DOMAIN}/checkout" }
  end

  before do
    host! DOMAIN
    cookies[:_gumroad_guid] = "paid-orders-guid"
    MerchantAccount.find_or_create_by!(user_id: nil, charge_processor_id: StripeChargeProcessor.charge_processor_id) do |ma|
      ma.charge_processor_alive_at = Time.current
    end
  end

  around do |paid_example|
    previous = ActiveJob::Base.queue_adapter
    ActiveJob::Base.queue_adapter = :sidekiq
    paid_example.run
  ensure
    ActiveJob::Base.queue_adapter = previous
  end

  def post_order(body)
    post "/orders", params: body.to_json, headers: json_headers.merge("X-CSRF-Token" => csrf_token)
  end

  def line(item = product, uid: "uid-0", **extra)
    {
      uid:, permalink: item.unique_permalink, is_multi_buy: false, is_preorder: false, is_rental: false,
      perceived_price_cents: item.price_cents, price_cents: item.price_cents, tip_cents: nil, quantity: 1, pay_in_installments: false,
      bundle_products: [], variants: [], call_start_time: "", discount_code: "", was_product_recommended: false,
      recommended_by: "", recommender_model_name: "", affiliate_id: "", url_parameters: "{}", referrer: "direct",
      is_purchasing_power_parity_discounted: false, accepts_purchasing_power_parity_discount: true,
      force_new_subscription: false, custom_fields: []
    }.merge(extra)
  end

  def order_body(*lines, payment: StripePaymentMethodHelper.success, **extra)
    {
      plugins: "", friend: "", url_parameters: "{}", locale: "en", email: "buyer@example.com", tax_country_election: "",
      is_gift: false, vat_id: "", "g-recaptcha-response": "", recaptcha_challenge_fallback: false, buyer_currency_quote: "",
      cc_zipcode_required: "false", cc_zipcode: "12345",
      purchase: { full_name: "Edgar Gumstein", street_address: "123 Gum Road", country: "US", state: "CA", city: "San Francisco", zip_code: "94117" },
      line_items: lines
    }.merge(payment.to_stripejs_params).merge(extra)
  end

  def line_response(uid = "uid-0") = response.parsed_body.dig("line_items", uid)

  it "hands a paid tokenized card purchase back whole", vcr: { cassette_name: "Orders_paid_purchase/charges_a_tokenized_card_for_a_paid_product", record: :none } do
    product
    post_order(order_body(line))

    expect(line_response).to include("success" => true)
    expect(Purchase.last).to have_attributes(purchase_state: "successful", price_cents: 5_00)
  end

  it "hands a signed-in buyer's paid purchase back whole", vcr: { cassette_name: "Orders_paid_purchase/charges_a_signed_in_buyer", record: :none } do
    product
    buyer = create(:user)
    log_in(buyer)
    post_order(order_body(line, email: buyer.email))

    expect(line_response).to include("success" => true)
    expect(Purchase.last).to have_attributes(purchase_state: "successful", purchaser_id: buyer.id)
  end

  it "hands a declined card purchase back whole", vcr: { cassette_name: "Orders_paid_purchase/records_a_declined_card_as_a_failed_purchase", record: :none } do
    product
    post_order(order_body(line, payment: StripePaymentMethodHelper.decline))

    expect(response.parsed_body).to include("success" => true)
    expect(line_response).to include("success" => false)
    expect(Purchase.last).to have_attributes(purchase_state: "failed")
  end
end
