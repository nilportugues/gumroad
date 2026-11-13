# frozen_string_literal: true

require "spec_helper"

# The guards of GET /checkout/returns/:id that Node answers: an order token that does not open an order, an order with no
# charge that holds a PaymentIntent, and a `payment_intent` that is not the charge's. A request that passes them reads the
# PaymentIntent from Stripe and finalizes the purchases, so it goes to Rails whole. Recorded for the Next.js port
# (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/checkout-returns-guards.replay.test.ts.
describe "Checkout returns guards", type: :request do
  let(:seller) { create(:user, username: "returnsseller") }
  let(:order) { Order.create! }
  let(:payment_intent_id) { "pi_returns_guard_0001" }

  before { host! DOMAIN }

  def add_charge(payment_intent: payment_intent_id)
    order.charges.create!(seller:, processor: "stripe", amount_cents: 1000, gumroad_amount_cents: 100, stripe_payment_intent_id: payment_intent)
  end

  it "answers 404 to a token that is not an order token", parity: true do
    get "/checkout/returns/not-a-token", params: { payment_intent: payment_intent_id }

    expect(response).to have_http_status(:not_found)
  end

  it "answers 404 to a token minted for another scope", parity: true do
    add_charge

    get "/checkout/returns/#{order.secure_external_id(scope: "unsubscribe")}", params: { payment_intent: payment_intent_id }

    expect(response).to have_http_status(:not_found)
  end

  it "answers 404 to a token of an order that was deleted", parity: true do
    add_charge
    token = order.secure_external_id(scope: "confirm")
    # No foreign keys: the charge outlives its order, so only the order lookup can answer 404 here.
    Order.where(id: order.id).delete_all

    get "/checkout/returns/#{token}", params: { payment_intent: payment_intent_id }

    expect(response).to have_http_status(:not_found)
  end

  it "answers 404 when the order has no charge", parity: true do
    get "/checkout/returns/#{order.secure_external_id(scope: "confirm")}", params: { payment_intent: payment_intent_id }

    expect(response).to have_http_status(:not_found)
  end

  it "answers 404 when no charge holds a PaymentIntent", parity: true do
    add_charge(payment_intent: nil)

    get "/checkout/returns/#{order.secure_external_id(scope: "confirm")}", params: { payment_intent: payment_intent_id }

    expect(response).to have_http_status(:not_found)
  end

  it "answers 404 when the payment_intent param is missing", parity: true do
    add_charge

    get "/checkout/returns/#{order.secure_external_id(scope: "confirm")}"

    expect(response).to have_http_status(:not_found)
  end

  it "answers 404 when the payment_intent param is another PaymentIntent", parity: true do
    add_charge

    get "/checkout/returns/#{order.secure_external_id(scope: "confirm")}", params: { payment_intent: "pi_returns_guard_0002" }

    expect(response).to have_http_status(:not_found)
  end

  it "hands a payment_intent param that is a list to Rails", parity: true do
    add_charge

    get "/checkout/returns/#{order.secure_external_id(scope: "confirm")}", params: { payment_intent: [payment_intent_id] }

    expect(response).to have_http_status(:not_found)
  end

  it "hands the return of the matching PaymentIntent to Rails", parity: true do
    add_charge
    # Rails reads the PaymentIntent from Stripe here; the recording only needs the request to reach the finalizer.
    allow_any_instance_of(Order::FinalizeConfirmedChargeService).to receive(:perform).and_return({})

    get "/checkout/returns/#{order.secure_external_id(scope: "confirm")}", params: { payment_intent: payment_intent_id }

    expect(response).to have_http_status(:found)
  end
end
