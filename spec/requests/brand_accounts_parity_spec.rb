# frozen_string_literal: true

require "spec_helper"

# POST /sellers/brand_accounts, recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/rest-sweep-2.replay.test.ts, which sends the last request of each example. Node answers the refusals and creates
# the account; copying the creator's compliance info or bank account is `hands a ...` (a payout copy and the Stripe account job).
describe "Brand accounts", type: :request do
  include Parity::AudienceSignedIn

  let(:creator) { create(:user, name: "Brand Creator", email: "creator@example.com") }
  let(:attributes) { { email: "brand@example.com", username: "brandaccount", name: "Brand Account" } }

  before do
    host! DOMAIN
    Feature.activate_user(:brand_accounts, creator)
  end

  def create_brand_account(brand_account = attributes)
    post sellers_brand_accounts_path,
         params: { brand_account: }.to_json,
         headers: { "CONTENT_TYPE" => "application/json", "Accept" => "application/json", "X-CSRF-Token" => csrf_token }
  end

  it "refuses an account the feature is off for", parity: true do
    Feature.deactivate_user(:brand_accounts, creator)
    log_in(creator)

    create_brand_account

    expect(response).to have_http_status(:ok)
    expect(response.parsed_body).to eq("success" => false, "error_message" => "Creating a new Gumroad is not available for your account yet.")
    expect(User.count).to eq(1)
  end

  it "refuses an account whose email is not confirmed", parity: true do
    log_in(creator)
    creator.update_columns(confirmed_at: nil)

    create_brand_account

    expect(response.parsed_body).to eq("success" => false, "error_message" => "Please confirm your email address before creating a new Gumroad.")
    expect(User.count).to eq(1)
  end

  it "refuses a new account that reuses the creator's email", parity: true do
    log_in(creator)

    create_brand_account(attributes.merge(email: "  Creator@Example.com "))

    expect(response.parsed_body).to eq("success" => false, "error_message" => "The new account needs its own email address, different from your current account.")
    expect(User.count).to eq(1)
  end

  it "refuses a creator without an email address", parity: true do
    log_in(creator)
    creator.update_columns(email: nil)

    create_brand_account

    expect(response).to have_http_status(:forbidden)
    expect(User.count).to eq(1)
  end

  it "creates the account, makes the creator an admin of it and switches into it", parity: true do
    log_in(creator)

    create_brand_account

    expect(response.parsed_body).to eq("success" => true)
    brand = User.find_by!(username: "brandaccount")
    expect(brand.email).to eq("brand@example.com")
    expect(brand.name).to eq("Brand Account")
    expect(brand.confirmed?).to eq(false)
    expect(brand.tos_agreements.count).to eq(1)
    expect(brand.seller_memberships.pluck(:user_id, :role)).to eq([[creator.id, "admin"]])
    expect(creator.user_memberships.pluck(:seller_id, :role)).to include([creator.id, "owner"])
    expect(set_cookies).to include("current_seller_id")
  end

  it "creates a second account for a creator who already owns a membership", parity: true do
    log_in(creator)
    create_brand_account
    expect(response.parsed_body).to eq("success" => true)

    create_brand_account(attributes.merge(email: "second@example.com", username: "secondbrand", name: "Second Brand"))

    expect(response.parsed_body).to eq("success" => true)
    expect(creator.user_memberships.where(role: "owner").count).to eq(1)
    expect(creator.user_memberships.where(role: "admin").count).to eq(2)
  end

  it "copies the creator's currency and payment address when asked to", parity: true do
    creator.update_columns(currency_type: "eur", payment_address: "payouts@example.com")
    log_in(creator)

    create_brand_account(attributes.merge(use_existing_payout_setup: true))

    brand = User.find_by!(username: "brandaccount")
    expect(brand.currency_type).to eq("eur")
    expect(brand.payment_address).to eq("payouts@example.com")
  end

  it "keeps the new account's own payout setup when not asked to copy", parity: true do
    creator.update_columns(currency_type: "eur", payment_address: "payouts@example.com")
    log_in(creator)

    create_brand_account(attributes.merge(use_existing_payout_setup: false))

    brand = User.find_by!(username: "brandaccount")
    expect(brand.currency_type).to eq("usd")
    expect(brand.payment_address).to be_blank
  end

  it "reads the copy flag as a form would send it", parity: true do
    creator.update_columns(payment_address: "payouts@example.com")
    log_in(creator)

    create_brand_account(attributes.merge(use_existing_payout_setup: "1"))

    expect(User.find_by!(username: "brandaccount").payment_address).to eq("payouts@example.com")
  end

  it "reads a copy flag of 0 as off", parity: true do
    creator.update_columns(payment_address: "payouts@example.com")
    log_in(creator)

    create_brand_account(attributes.merge(use_existing_payout_setup: "0"))

    expect(User.find_by!(username: "brandaccount").payment_address).to be_blank
  end

  it "refuses an address that is not an email", parity: true do
    log_in(creator)

    create_brand_account(attributes.merge(email: "not-an-email"))

    expect(response.parsed_body["success"]).to eq(false)
    expect(response.parsed_body["error_message"]).to be_present
    expect(User.count).to eq(1)
  end

  it "refuses a missing email", parity: true do
    log_in(creator)

    create_brand_account(attributes.except(:email))

    expect(response.parsed_body["success"]).to eq(false)
    expect(User.count).to eq(1)
  end

  it "refuses an email another account has", parity: true do
    create(:user, email: "brand@example.com")
    log_in(creator)

    create_brand_account

    expect(response.parsed_body["success"]).to eq(false)
    expect(response.parsed_body["error_message"]).to eq("An account already exists with this email.")
    expect(User.count).to eq(2)
  end

  it "refuses a username another account has", parity: true do
    create(:user, username: "brandaccount")
    log_in(creator)

    create_brand_account

    expect(response.parsed_body["success"]).to eq(false)
    expect(User.count).to eq(2)
  end

  it "refuses a username that is not allowed", parity: true do
    log_in(creator)

    create_brand_account(attributes.merge(username: "a"))

    expect(response.parsed_body["success"]).to eq(false)
    expect(User.count).to eq(1)
  end

  it "creates an account that has no username or name", parity: true do
    log_in(creator)

    create_brand_account(email: "bare@example.com")

    expect(response.parsed_body["success"]).to eq(true)
  end

  it "hands the copy of the creator's compliance info to Rails", parity: true do
    create(:user_compliance_info, user: creator)
    log_in(creator)

    create_brand_account(attributes.merge(use_existing_payout_setup: true))

    expect(response.parsed_body).to eq("success" => true)
    expect(User.find_by!(username: "brandaccount").alive_user_compliance_info).to be_present
  end

  it "hands the copy of the creator's bank account to Rails", parity: true do
    create(:ach_account, user: creator)
    log_in(creator)

    create_brand_account(attributes.merge(use_existing_payout_setup: true))

    expect(response.parsed_body).to eq("success" => true)
  end

  it "creates the account without copying the compliance info it is not asked to copy", parity: true do
    create(:user_compliance_info, user: creator)
    log_in(creator)

    create_brand_account

    expect(response.parsed_body).to eq("success" => true)
    expect(User.find_by!(username: "brandaccount").alive_user_compliance_info).to be_nil
  end

  it "creates the account with a generated username when the username is a list", parity: true do
    log_in(creator)

    create_brand_account(attributes.merge(username: ["brandaccount"]))

    expect(response).to have_http_status(:ok)
  end

  it "hands a request without the brand_account hash to Rails", parity: true do
    log_in(creator)

    post sellers_brand_accounts_path,
         params: {}.to_json,
         headers: { "CONTENT_TYPE" => "application/json", "Accept" => "application/json", "X-CSRF-Token" => csrf_token }

    expect(response).to have_http_status(:bad_request)
  end
end
