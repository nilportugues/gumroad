# frozen_string_literal: true

require "spec_helper"

# ApplicationController#check_payment_details in front of the seller dashboards, recorded for the Next.js port
# (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/dashboard-pages.replay.test.ts. The Rails app asks
# Stripe whether a flagged seller's capabilities are active; the port makes no Stripe call, so the examples
# that reach it (and the redirect they may end in) are the ones it hands back to Rails.
describe "Seller payment details check when signed in", type: :request do
  include Parity::AudienceSignedIn

  let(:seller) { create(:user, name: "Flagged Seller") }
  let(:stripe_account_id) { "acct_ws70_flagged" }

  before do
    host! DOMAIN
    $redis.sadd(RedisKey.user_ids_with_payment_requirements_key, seller.id)
  end

  def stub_stripe_account(capabilities)
    stub_request(:get, "https://api.stripe.com/v1/accounts/#{stripe_account_id}")
      .to_return(status: 200, body: { id: stripe_account_id, object: "account", capabilities: }.to_json, headers: { "Content-Type" => "application/json" })
  end

  it "renders for a flagged seller who has no Stripe merchant account", parity: true do
    log_in(seller)

    get audience_dashboard_path

    expect(response).to be_successful
    expect($redis.sismember(RedisKey.user_ids_with_payment_requirements_key, seller.id)).to eq(true)
  end

  it "renders for a seller who is not flagged without looking at the merchant accounts", parity: true do
    $redis.srem(RedisKey.user_ids_with_payment_requirements_key, seller.id)
    create(:merchant_account, user: seller, charge_processor_merchant_id: stripe_account_id)
    log_in(seller)

    get audience_dashboard_path

    expect(response).to be_successful
  end

  it "renders for a seller whose merchant account is a PayPal one", parity: true do
    create(:merchant_account_paypal, user: seller)
    log_in(seller)

    get audience_dashboard_path

    expect(response).to be_successful
  end

  it "sends a seller Stripe has asked for more information to the payments settings", parity: true do
    create(:merchant_account, user: seller, charge_processor_merchant_id: stripe_account_id)
    create(:user_compliance_info_request, user: seller, state: "requested")
    log_in(seller)

    get audience_dashboard_path

    expect(response).to redirect_to(settings_payments_path)
    expect(flash[:notice]).to eq("Urgent: We are required to collect more information from you to continue processing payments.")
  end

  it "asks Stripe and renders, clearing the flag, when both capabilities are active", parity: true do
    create(:merchant_account, user: seller, charge_processor_merchant_id: stripe_account_id)
    stub_stripe_account(card_payments: "active", transfers: "active")
    log_in(seller)

    get audience_dashboard_path

    expect(response).to be_successful
    expect($redis.sismember(RedisKey.user_ids_with_payment_requirements_key, seller.id)).to eq(false)
  end

  it "asks Stripe and redirects to the payments settings while a capability is inactive", parity: true do
    create(:merchant_account, user: seller, charge_processor_merchant_id: stripe_account_id)
    stub_stripe_account(card_payments: "active", transfers: "inactive")
    log_in(seller)

    get audience_dashboard_path

    expect(response).to redirect_to(settings_payments_path)
  end
end
