# frozen_string_literal: true

require "spec_helper"

# POST /v2/partner/sellers and /api/v2/partner/sellers, recorded for the Next.js port
# (nextjs/parity/__tests__/api-v2-products.replay.test.ts). A seller who authorized a partner application links their account
# to the partner's own user id; the token has a resource owner, unlike the rest of the partner API.
describe "API v2 partner sellers", type: :request do
  include Parity::ApiV2Requests

  let(:partner_application) { create(:oauth_application, owner: create(:user), name: "Example App", is_partner: true, confidential: true, scopes: "partner_api") }
  let(:seller) { create(:user) }
  let(:token) { seller_token }

  def seller_token(application: partner_application, user: seller, scopes: "partner_api", **attributes)
    create("doorkeeper/access_token", application:, resource_owner_id: user.id, scopes:, **attributes)
  end

  def link(external_user_id = "ext-1", token: self.token, **options)
    api_call(:post, "/partner/sellers", token:, params: { external_user_id: }, **options)
  end

  it "links the seller on the API host", parity: true do
    link

    expect(response).to have_http_status(:created)
    expect(response.parsed_body).to eq("success" => true, "external_user_id" => "ext-1")
    expect(partner_application.partner_sellers.sole).to have_attributes(user: seller, external_user_id: "ext-1", migrated_at: nil, deleted_at: nil)
  end

  it "links the seller on the Gumroad domain", parity: true do
    link(api_host: false)

    expect(response).to have_http_status(:created)
  end

  it "reads a JSON body", parity: true do
    link("ext-json", as: :json)

    expect(response).to have_http_status(:created)
    expect(partner_application.partner_sellers.sole.external_user_id).to eq("ext-json")
  end

  it "answers 200 for a seller that is already linked to the same partner user", parity: true do
    create(:partner_seller, oauth_application: partner_application, user: seller, external_user_id: "ext-1", migrated_at: 2.days.ago)

    link

    expect(response).to have_http_status(:ok)
    expect(partner_application.partner_sellers.sole.migrated_at).to be_present
  end

  it "restores a link that was removed", parity: true do
    create(:partner_seller, oauth_application: partner_application, user: seller, external_user_id: "ext-1", deleted_at: 1.day.ago)

    link

    expect(response).to have_http_status(:ok)
    expect(partner_application.partner_sellers.sole.deleted_at).to be_nil
  end

  it "answers 409 for a removed link that another account holds the partner user id of", parity: true do
    create(:partner_seller, oauth_application: partner_application, user: create(:user), external_user_id: "ext-1", deleted_at: 1.day.ago)

    link

    expect(response).to have_http_status(:conflict)
  end

  it "answers 409 when the partner user id is linked to another Gumroad account", parity: true do
    create(:partner_seller, oauth_application: partner_application, user: create(:user), external_user_id: "ext-1")

    link

    expect(response).to have_http_status(:conflict)
    expect(response.parsed_body["message"]).to eq("This Example App account is already linked to a different Gumroad account.")
  end

  it "answers 409 when the Gumroad account is linked to another partner user id", parity: true do
    create(:partner_seller, oauth_application: partner_application, user: seller, external_user_id: "ext-2")

    link

    expect(response).to have_http_status(:conflict)
    expect(response.parsed_body["message"]).to eq("Your Gumroad account is already linked to a different Example App account.")
  end

  it "links a partner user id that differs only by case from a linked one", parity: true do
    create(:partner_seller, oauth_application: partner_application, user: create(:user), external_user_id: "EXT-1")

    link

    expect(response).to have_http_status(:created)
    expect(partner_application.partner_sellers.count).to eq(2)
  end

  it "keeps links of other applications apart", parity: true do
    other_application = create(:oauth_application, owner: create(:user), is_partner: true, confidential: true, scopes: "partner_api")
    create(:partner_seller, oauth_application: other_application, user: seller, external_user_id: "ext-9")

    link

    expect(response).to have_http_status(:created)
  end

  it "stores markup, unicode and surrounding spaces in the partner user id as they are", parity: true do
    link("  <b>é & \"x\"</b> 🙂 ")

    expect(response).to have_http_status(:created)
    expect(response.parsed_body["external_user_id"]).to eq("  <b>é & \"x\"</b> 🙂 ")
  end

  it "links a partner user id of 255 characters, counted as characters", parity: true do
    link("🙂" * PartnerMigration::MAX_EXTERNAL_USER_ID_LENGTH)

    expect(response).to have_http_status(:created)
  end

  it "refuses a partner user id of 256 characters", parity: true do
    link("x" * (PartnerMigration::MAX_EXTERNAL_USER_ID_LENGTH + 1))

    expect(response).to have_http_status(:bad_request)
    expect(response.parsed_body["message"]).to eq("external_user_id must be a string with 1 to 255 characters, not only spaces.")
    expect(PartnerSeller.count).to eq(0)
  end

  it "refuses a blank partner user id", parity: true do
    link(" \t ")

    expect(response).to have_http_status(:bad_request)
  end

  it "refuses an empty partner user id", parity: true do
    link("")

    expect(response).to have_http_status(:bad_request)
  end

  it "refuses a request without a partner user id", parity: true do
    api_call(:post, "/partner/sellers", token:)

    expect(response).to have_http_status(:bad_request)
  end

  it "refuses a partner user id that is a number", parity: true do
    link(12_345, as: :json)

    expect(response).to have_http_status(:bad_request)
  end

  it "refuses a partner user id that is a list", parity: true do
    link(["ext-1"], as: :json)

    expect(response).to have_http_status(:bad_request)
  end

  it "refuses a partner user id that is an object", parity: true do
    link({ id: "ext-1" }, as: :json)

    expect(response).to have_http_status(:bad_request)
  end

  it "refuses a suspended account", parity: true do
    seller.update!(user_risk_state: "suspended_for_fraud")

    link

    expect(response).to have_http_status(:forbidden)
    expect(response.parsed_body["message"]).to eq("This account cannot be linked.")
    expect(PartnerSeller.count).to eq(0)
  end

  it "checks the partner user id before the account state", parity: true do
    seller.update!(user_risk_state: "suspended_for_fraud")

    link(" ")

    expect(response).to have_http_status(:bad_request)
  end

  it "refuses a request without a token", parity: true do
    link(token: nil)

    expect(response).to have_http_status(:unauthorized)
  end

  it "refuses an expired token", parity: true do
    link(token: seller_token(expires_in: 60, created_at: 2.hours.ago))

    expect(response).to have_http_status(:unauthorized)
  end

  it "refuses a revoked token", parity: true do
    link(token: seller_token(revoked_at: 1.minute.ago))

    expect(response).to have_http_status(:unauthorized)
    expect(PartnerSeller.count).to eq(0)
  end

  it "refuses a token without the partner scope", parity: true do
    link(token: seller_token(scopes: "view_profile"))

    expect(response).to have_http_status(:forbidden)
  end

  it "refuses a token with the account scope but not the partner scope", parity: true do
    link(token: seller_token(scopes: "account"))

    expect(response).to have_http_status(:forbidden)
    expect(response.parsed_body["message"]).to eq("This endpoint requires the partner_api scope.")
  end

  it "refuses a client credentials token", parity: true do
    client_token = create("doorkeeper/access_token", application: partner_application, resource_owner_id: nil, scopes: "partner_api")

    link(token: client_token)

    expect(response).to have_http_status(:forbidden)
    expect(response.parsed_body["message"]).to eq("This endpoint needs a seller's token from a partner application.")
  end

  it "refuses an application that is not flagged as a partner", parity: true do
    application = create(:oauth_application, owner: create(:user), confidential: true, scopes: "partner_api")

    link(token: seller_token(application:))

    expect(response).to have_http_status(:forbidden)
    expect(PartnerSeller.count).to eq(0)
  end

  it "refuses an application that is not confidential", parity: true do
    application = create(:oauth_application, owner: create(:user), is_partner: true, confidential: false, scopes: "partner_api")

    link(token: seller_token(application:))

    expect(response).to have_http_status(:forbidden)
  end

  it "refuses a token of a deleted application", parity: true do
    partner_application.update!(deleted_at: Time.current)

    link

    expect(response).to have_http_status(:forbidden)
  end

  it "refuses a token whose owner was deleted", parity: true do
    seller.update_columns(deleted_at: Time.current)

    link

    expect(response).to have_http_status(:unauthorized)
  end
end
