# frozen_string_literal: true

require "spec_helper"

# GET /v2/partner/categories and /api/v2/partner/categories, recorded for the Next.js port
# (nextjs/parity/__tests__/api-v2-products.replay.test.ts). A partner calls it with a client-credentials token: no resource owner.
describe "API v2 partner categories", type: :request do
  include Parity::ApiV2Requests

  let(:partner_application) { create(:oauth_application, owner: create(:user), is_partner: true, confidential: true, scopes: "partner_api") }

  def partner_token(application: partner_application, **attributes)
    create("doorkeeper/access_token", application:, resource_owner_id: nil, scopes: "partner_api", **attributes)
  end

  before do
    Rails.cache.delete("taxonomies_for_nav")
    design = Taxonomy.find_or_create_by!(slug: "design")
    ui_and_web = Taxonomy.find_or_create_by!(slug: "ui-and-web", parent: design)
    Taxonomy.find_or_create_by!(slug: "figma", parent: ui_and_web)
    Taxonomy.find_or_create_by!(slug: "other")
    Rails.cache.delete("taxonomies_for_nav")
  end

  it "lists the category paths for a partner application on the API host", parity: true do
    api_call(:get, "/partner/categories", token: partner_token)

    expect(response).to have_http_status(:ok)
    expect(response.headers["Cache-Control"]).to include("max-age=3600")
    expect(response.parsed_body["categories"].map { _1["path"] }).to include("design/ui-and-web/figma")
  end

  it "lists the category paths on the Gumroad domain", parity: true do
    api_call(:get, "/partner/categories", token: partner_token, api_host: false)

    expect(response).to have_http_status(:ok)
  end

  it "accepts a supported sort", parity: true do
    api_call(:get, "/partner/categories", token: partner_token, params: { sort: "newest" })

    expect(response).to have_http_status(:ok)
  end

  it "accepts a blank sort", parity: true do
    api_call(:get, "/partner/categories", token: partner_token, params: { sort: "" })

    expect(response).to have_http_status(:ok)
  end

  it "refuses an unsupported sort", parity: true do
    api_call(:get, "/partner/categories", token: partner_token, params: { sort: "price_asc" })

    expect(response).to have_http_status(:bad_request)
    expect(response.parsed_body["message"]).to start_with("Unsupported sort.")
  end

  it "refuses a request without a token", parity: true do
    api_call(:get, "/partner/categories")

    expect(response).to have_http_status(:unauthorized)
  end

  it "refuses an expired token", parity: true do
    api_call(:get, "/partner/categories", token: partner_token(expires_in: 60, created_at: 2.hours.ago))

    expect(response).to have_http_status(:unauthorized)
  end

  it "refuses a revoked token", parity: true do
    api_call(:get, "/partner/categories", token: partner_token(revoked_at: 1.hour.ago))

    expect(response).to have_http_status(:unauthorized)
  end

  it "refuses a token with the account scope but not the partner scope", parity: true do
    token = create("doorkeeper/access_token", application: partner_application, resource_owner_id: nil, scopes: "account")

    api_call(:get, "/partner/categories", token:)

    expect(response).to have_http_status(:forbidden)
    expect(response.parsed_body["message"]).to eq("This endpoint requires the partner_api scope.")
  end

  it "refuses a token without a public scope", parity: true do
    token = create("doorkeeper/access_token", application: partner_application, resource_owner_id: nil, scopes: "edit_products")

    api_call(:get, "/partner/categories", token:)

    expect(response).to have_http_status(:forbidden)
  end

  it "refuses an application that is not flagged as a partner", parity: true do
    application = create(:oauth_application, owner: create(:user), confidential: true, scopes: "partner_api")

    api_call(:get, "/partner/categories", token: partner_token(application:))

    expect(response).to have_http_status(:forbidden)
    expect(response.parsed_body["message"]).to eq("This endpoint is only available to partner applications.")
  end

  it "refuses an application that is not confidential", parity: true do
    application = create(:oauth_application, owner: create(:user), is_partner: true, scopes: "partner_api")

    api_call(:get, "/partner/categories", token: partner_token(application:))

    expect(response).to have_http_status(:forbidden)
  end

  it "refuses a token of a deleted application", parity: true do
    token = partner_token
    partner_application.update_columns(deleted_at: Time.current)

    api_call(:get, "/partner/categories", token:)

    expect(response).to have_http_status(:forbidden)
  end

  it "refuses a token that has a resource owner", parity: true do
    token = create("doorkeeper/access_token", application: partner_application, resource_owner_id: create(:user).id, scopes: "partner_api")

    api_call(:get, "/partner/categories", token:)

    expect(response).to have_http_status(:forbidden)
    expect(response.parsed_body["message"]).to eq("This endpoint is only available to partner applications.")
  end

  it "answers 401 for a token whose resource owner was deleted", parity: true do
    owner = create(:user)
    token = create("doorkeeper/access_token", application: partner_application, resource_owner_id: owner.id, scopes: "partner_api")
    owner.update_columns(deleted_at: Time.current)

    api_call(:get, "/partner/categories", token:)

    expect(response).to have_http_status(:unauthorized)
  end
end
