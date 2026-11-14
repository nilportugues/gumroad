# frozen_string_literal: true

require "spec_helper"

# SellerPlanController#checkout (GET /seller_plan/checkout) as a seller the publish gate stopped reaches it, recorded for the Next.js port
# (PARITY_RECORD=1) with Stripe stubbed by WebMock: the fixture keeps each call Rails made to Stripe, and
# nextjs/parity/__tests__/seller-plan-checkout.replay.test.ts replays the last request of each example against a stand-in that answers them
# in order and compares the calls Node makes, the offer row and the redirect. The recording sets SELLER_PLAN_PRICE_5 and leaves
# SELLER_PLAN_PRICE_10 unset (the "ten" arm has no price).
describe "Seller plan checkout", type: :request do
  include Parity::AudienceSignedIn

  let(:seller) { create(:named_seller, name: "Plan Seller", created_at: Time.utc(2025, 1, 1)) }
  let(:product) { create(:product, user: seller, name: "Draft product", draft: true) }
  let(:arm) { "five" }
  # A fixed past timestamp, so the recorded "before" value does not depend on how long the login took.
  let!(:offer) do
    SellerPlanOffer.record_offer!(user: seller, product:, arm:, price_cents: 500).tap { |o| o.update_columns(offered_at: Time.utc(2025, 6, 1), created_at: Time.utc(2025, 6, 1), updated_at: Time.utc(2025, 6, 1)) }
  end
  let(:json_headers) { { "Content-Type" => "application/json" } }
  let(:sessions_url) { "https://api.stripe.com/v1/checkout/sessions" }
  let(:edit_url) { "http://#{DOMAIN}/products/#{product.unique_permalink}/edit" }

  before do
    host! DOMAIN
    log_in(seller) unless RSpec.current_example.metadata[:team]
  end

  def stub_create(**response)
    WebMock.stub_request(:post, sessions_url).to_return({ status: 200, headers: json_headers, body: { id: "cs_test_new", object: "checkout.session", status: "open", url: "https://checkout.stripe.com/c/pay/cs_test_new" }.to_json }.merge(response))
  end

  def stub_retrieve(id, **response)
    WebMock.stub_request(:get, "#{sessions_url}/#{id}").to_return({ status: 200, headers: json_headers, body: { id:, object: "checkout.session", status: "open", url: "https://checkout.stripe.com/c/pay/#{id}" }.to_json }.merge(response))
  end

  def checkout = get("/seller_plan/checkout")

  it "creates a hosted checkout session and sends the seller to Stripe", parity: true do
    stub_create

    checkout

    expect(response).to redirect_to("https://checkout.stripe.com/c/pay/cs_test_new")
    expect(offer.reload.status).to eq("checkout_started")
  end

  it "starts a canceled offer over with a new session", parity: true do
    offer.update!(status: "canceled", canceled_at: Time.current, stripe_checkout_session_id: "cs_test_old")
    stub_retrieve("cs_test_old", body: { id: "cs_test_old", status: "expired", url: nil }.to_json)
    stub_create

    checkout

    expect(response).to redirect_to("https://checkout.stripe.com/c/pay/cs_test_new")
    expect(offer.reload.status).to eq("checkout_started")
  end

  it "sends the seller back to the session that is still open", parity: true do
    offer.update!(status: "checkout_started", stripe_checkout_session_id: "cs_test_open")
    stub_retrieve("cs_test_open")

    checkout

    expect(response).to redirect_to("https://checkout.stripe.com/c/pay/cs_test_open")
  end

  it "replaces a session that has expired and keeps the funnel status", parity: true do
    offer.update!(status: "past_due", stripe_checkout_session_id: "cs_test_expired")
    stub_retrieve("cs_test_expired", body: { id: "cs_test_expired", status: "complete", url: nil }.to_json)
    stub_create

    checkout

    expect(response).to redirect_to("https://checkout.stripe.com/c/pay/cs_test_new")
    expect(offer.reload.status).to eq("past_due")
  end

  it "creates a session when Stripe does not know the stored one", parity: true do
    offer.update!(status: "checkout_started", stripe_checkout_session_id: "cs_test_gone")
    stub_retrieve("cs_test_gone", status: 404, body: { error: { type: "invalid_request_error", message: "No such checkout.session: 'cs_test_gone'", code: "resource_missing" } }.to_json)
    stub_create

    checkout

    expect(response).to redirect_to("https://checkout.stripe.com/c/pay/cs_test_new")
  end

  it "sends a seller who already pays to the product editor", parity: true do
    offer.update!(status: "active", activated_at: Time.current)

    checkout

    expect(response).to redirect_to(edit_url)
  end

  it "tells the seller to try again when Stripe refuses the session", parity: true do
    stub_create(status: 400, body: { error: { type: "invalid_request_error", message: "Invalid price" } }.to_json)

    checkout

    expect(response).to redirect_to("http://#{DOMAIN}/")
    expect(flash[:alert]).to eq("We couldn't start your plan checkout. Email support@gumroad.com and we'll sort it out.")
  end

  it "keeps publishing free when the arm has no Stripe price", parity: true do
    offer.update!(arm: "ten", price_cents: 1000)

    checkout

    expect(response).to redirect_to("http://#{DOMAIN}/")
    expect(flash[:alert]).to start_with("The seller plan isn't available right now")
  end

  it "answers that the offer is gone when the seller has none", parity: true do
    offer.destroy!

    checkout

    expect(response).to redirect_to("http://#{DOMAIN}/")
    expect(flash[:alert]).to eq("That plan offer is no longer available.")
  end

  it "starts over from the dashboard message when the offer has no product", parity: true do
    offer.update_columns(product_id: nil)

    checkout

    expect(response).to redirect_to("http://#{DOMAIN}/")
    expect(flash[:alert]).to eq("We couldn't start your plan checkout. Email support@gumroad.com and we'll sort it out.")
  end

  describe "as a member of the seller's team", team: true do
    def as_team_member(role)
      member = create(:user, name: "#{role.capitalize} Member")
      membership = create(:team_membership, user: member, seller:, role:)
      log_in(member)
      switch_to(membership)
    end

    it "lets an admin start the checkout", parity: true do
      stub_create
      as_team_member(:admin)

      checkout

      expect(response).to redirect_to("https://checkout.stripe.com/c/pay/cs_test_new")
    end

    it "turns a refused authorization into a failed checkout, because the action rescues StandardError", parity: true do
      as_team_member(:marketing)

      checkout

      expect(response).to redirect_to("http://#{DOMAIN}/")
      expect(flash[:alert]).to eq("We couldn't start your plan checkout. Email support@gumroad.com and we'll sort it out.")
    end
  end
end
