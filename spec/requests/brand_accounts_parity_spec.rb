# frozen_string_literal: true

require "spec_helper"

# POST /sellers/brand_accounts, recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/rest-sweep-2.replay.test.ts, which sends the last request of each example. The refusals ahead of the first write
# are answered by Node; creating the account is `hands a ...` (a User with a random password and its confirmation mail, the team
# memberships and the session switch).
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

  it "hands the creation of the account to Rails", parity: true do
    log_in(creator)

    create_brand_account

    expect(response.parsed_body).to eq("success" => true)
    expect(User.find_by(username: "brandaccount")).to be_present
  end

  it "hands a request without the brand_account hash to Rails", parity: true do
    log_in(creator)

    post sellers_brand_accounts_path,
         params: {}.to_json,
         headers: { "CONTENT_TYPE" => "application/json", "Accept" => "application/json", "X-CSRF-Token" => csrf_token }

    expect(response).to have_http_status(:bad_request)
  end
end
