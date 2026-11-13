# frozen_string_literal: true

require "spec_helper"

# POST /v2/partner/migrations and /api/v2/partner/migrations, recorded for the Next.js port
# (nextjs/parity/__tests__/api-v2-products.replay.test.ts). Only the guards before the catalogue is validated are served by Node;
# a request that passes them is handed back to Rails whole.
describe "API v2 partner migrations create", type: :request do
  include Parity::ApiV2Requests

  let(:partner_application) { create(:oauth_application, owner: create(:user), is_partner: true, confidential: true, scopes: "partner_api") }
  let(:products) { [{ external_product_id: "p-1", name: "Texture Pack", price: 500 }] }

  def partner_token(application: partner_application, **attributes)
    create("doorkeeper/access_token", application:, resource_owner_id: nil, scopes: "partner_api", **attributes)
  end

  def migrate(token: partner_token, api_host: true, **params)
    api_call(:post, "/partner/migrations", token:, params: { external_user_id: "ext-1", products: }.merge(params), as: :json, api_host:)
  end

  it "hands a valid migration back to Rails", parity: true do
    migrate(email: "seller@example.com")

    expect(response).to have_http_status(:created)
    expect(PartnerMigration.count).to eq(1)
  end

  it "hands a migration with invalid products back to Rails", parity: true do
    migrate(products: [])

    expect(response).to have_http_status(:bad_request)
    expect(PartnerMigration.count).to eq(0)
  end

  it "refuses a request without a token", parity: true do
    migrate(token: nil)

    expect(response).to have_http_status(:unauthorized)
  end

  it "refuses an expired token", parity: true do
    migrate(token: partner_token(expires_in: 60, created_at: 2.hours.ago))

    expect(response).to have_http_status(:unauthorized)
  end

  it "refuses a token with the account scope but not the partner scope", parity: true do
    token = create("doorkeeper/access_token", application: partner_application, resource_owner_id: nil, scopes: "account")
    migrate(token:)

    expect(response).to have_http_status(:forbidden)
    expect(response.parsed_body["message"]).to eq("This endpoint requires the partner_api scope.")
  end

  it "refuses an application that is not flagged as a partner", parity: true do
    application = create(:oauth_application, owner: create(:user), confidential: true, scopes: "partner_api")
    migrate(token: partner_token(application:))

    expect(response).to have_http_status(:forbidden)
    expect(response.parsed_body["message"]).to eq("This endpoint is only available to partner applications.")
  end

  it "refuses an application that is not confidential", parity: true do
    application = create(:oauth_application, owner: create(:user), is_partner: true, confidential: false, scopes: "partner_api")
    migrate(token: partner_token(application:))

    expect(response).to have_http_status(:forbidden)
  end

  it "refuses a token that has a resource owner", parity: true do
    token = create("doorkeeper/access_token", application: partner_application, resource_owner_id: create(:user).id, scopes: "partner_api")
    migrate(token:)

    expect(response).to have_http_status(:forbidden)
  end

  it "refuses an unsupported sort", parity: true do
    migrate(sort: "price_asc")

    expect(response).to have_http_status(:bad_request)
    expect(response.parsed_body["message"]).to start_with("Unsupported sort.")
  end

  it "answers on the Gumroad domain", parity: true do
    migrate(external_user_id: "", api_host: false)

    expect(response).to have_http_status(:bad_request)
  end

  it "refuses a request without a partner user id", parity: true do
    api_call(:post, "/partner/migrations", token: partner_token, params: { email: "seller@example.com" })

    expect(response).to have_http_status(:bad_request)
    expect(response.parsed_body["message"]).to eq("external_user_id must be a string with 1 to 255 characters, not only spaces.")
  end

  it "refuses an empty partner user id", parity: true do
    migrate(external_user_id: "")

    expect(response).to have_http_status(:bad_request)
  end

  it "refuses a blank partner user id", parity: true do
    migrate(external_user_id: " \t ")

    expect(response).to have_http_status(:bad_request)
  end

  it "refuses a partner user id that is too long", parity: true do
    migrate(external_user_id: "x" * (PartnerMigration::MAX_EXTERNAL_USER_ID_LENGTH + 1))

    expect(response).to have_http_status(:bad_request)
  end

  it "accepts a partner user id of the maximum length and hands it back to Rails", parity: true do
    migrate(external_user_id: "x" * PartnerMigration::MAX_EXTERNAL_USER_ID_LENGTH)

    expect(response).to have_http_status(:created)
  end

  it "refuses a partner user id that is a number", parity: true do
    migrate(external_user_id: 12_345)

    expect(response).to have_http_status(:bad_request)
  end

  it "refuses a partner user id that is a list", parity: true do
    migrate(external_user_id: ["ext-1"])

    expect(response).to have_http_status(:bad_request)
  end

  it "refuses a partner user id that is an object", parity: true do
    migrate(external_user_id: { id: "ext-1" })

    expect(response).to have_http_status(:bad_request)
  end

  it "answers the partner user id guard before it looks at the products", parity: true do
    migrate(external_user_id: "", products: "nope")

    expect(response).to have_http_status(:bad_request)
    expect(response.parsed_body["message"]).to start_with("external_user_id")
  end
end
