# frozen_string_literal: true

require "spec_helper"

# GET /v2/partner/migrations/:id and /api/v2/partner/migrations/:id, recorded for the Next.js port
# (nextjs/parity/__tests__/api-v2-products.replay.test.ts). A partner polls an import it started with a client-credentials token:
# no resource owner, and only the migrations of its own application.
describe "API v2 partner migrations", type: :request do
  include Parity::ApiV2Requests

  let(:partner_application) { create(:oauth_application, owner: create(:user), is_partner: true, confidential: true, scopes: "partner_api") }
  let(:external_ids) { ["Texture Pack", "123", "45"] }
  let(:migration) { create_migration(external_ids) }

  def partner_token(application: partner_application, **attributes)
    create("doorkeeper/access_token", application:, resource_owner_id: nil, scopes: "partner_api", **attributes)
  end

  def create_migration(ids, application: partner_application, external_user_id: "ext-1")
    products, error = PartnerMigration.normalize_products(ids.map { { external_product_id: _1, name: "Product #{_1}", price: 500 } })
    raise error if error

    PartnerMigration.create_for!(oauth_application: application, external_user_id:, products:).first
  end

  it "reports a pending migration on the API host", parity: true do
    api_call(:get, "/partner/migrations/#{migration.public_id}", token: partner_token)

    expect(response).to have_http_status(:ok)
    expect(response.parsed_body).to include("success" => true, "status" => "pending", "total" => 3, "imported" => 0, "failed" => 0, "remaining" => 3, "results" => {})
  end

  it "reports a pending migration on the Gumroad domain", parity: true do
    api_call(:get, "/partner/migrations/#{migration.public_id}", token: partner_token, api_host: false)

    expect(response).to have_http_status(:ok)
  end

  it "keys the results by the partner's product ids and counts imports and failures", parity: true do
    migration.update_columns(
      status: "claimed",
      results: { "0" => { "product_id" => "abc123" }, "1" => { "error" => "Name can't be blank" }, "2" => { "product_id" => "" } },
    )

    api_call(:get, "/partner/migrations/#{migration.public_id}", token: partner_token)

    expect(response).to have_http_status(:ok)
    expect(response.parsed_body).to include("status" => "claimed", "total" => 3, "imported" => 1, "failed" => 1, "remaining" => 1)
    expect(response.parsed_body["results"].keys).to eq(["Texture Pack", "123"].push("45"))
  end

  it "counts the results of a catalog with more than ten products", parity: true do
    ids = ["9", "8", "7", "6", "5", "4", "3", "2", "1", "0", "11", "10"]
    big = create_migration(ids)
    big.update_columns(results: ids.each_index.to_h { |index| [index.to_s, { "product_id" => "p#{index}" }] }.reverse_each.to_h)

    api_call(:get, "/partner/migrations/#{big.public_id}", token: partner_token)

    expect(response).to have_http_status(:ok)
    expect(response.parsed_body).to include("total" => 12, "imported" => 12)
  end

  it "reports markup and unicode in a failure message", parity: true do
    migration.update_columns(status: "failed", failure_reason: "Import <failed> & stopped   é", results: { "0" => { "error" => "<b>Name</b> & \"price\" é  " } })

    api_call(:get, "/partner/migrations/#{migration.public_id}", token: partner_token)

    expect(response).to have_http_status(:ok)
    expect(response.parsed_body["status"]).to eq("failed")
  end

  it "reports a completed migration", parity: true do
    migration.update_columns(
      status: "completed",
      completed_at: Time.current,
      results: { "0" => { "product_id" => "a1" }, "1" => { "product_id" => "b2" }, "2" => { "product_id" => "c3" } },
    )

    api_call(:get, "/partner/migrations/#{migration.public_id}", token: partner_token)

    expect(response.parsed_body).to include("status" => "completed", "imported" => 3, "remaining" => 0)
  end

  it "hands a migration whose result holds a fractional number back to Rails", parity: true do
    migration.update_columns(results: { "0" => { "product_id" => "abc123", "price" => 1.5 } })

    api_call(:get, "/partner/migrations/#{migration.public_id}", token: partner_token)

    expect(response).to have_http_status(:ok)
  end

  it "answers 404 for a migration of another partner application", parity: true do
    other_application = create(:oauth_application, owner: create(:user), is_partner: true, confidential: true, scopes: "partner_api")
    other = create_migration(["Other"], application: other_application)

    api_call(:get, "/partner/migrations/#{other.public_id}", token: partner_token)

    expect(response).to have_http_status(:not_found)
  end

  it "answers 404 for an unknown id", parity: true do
    api_call(:get, "/partner/migrations/#{"a" * 21}", token: partner_token)

    expect(response).to have_http_status(:not_found)
  end

  it "answers 404 for an id that is not a public id", parity: true do
    api_call(:get, "/partner/migrations/#{migration.public_id[0, 10]}", token: partner_token)

    expect(response).to have_http_status(:not_found)
  end

  it "matches the public id with its case", parity: true do
    api_call(:get, "/partner/migrations/#{migration.public_id.swapcase}", token: partner_token)

    expect(response).to have_http_status(migration.public_id == migration.public_id.swapcase ? :ok : :not_found)
  end

  it "refuses a request without a token", parity: true do
    api_call(:get, "/partner/migrations/#{migration.public_id}")

    expect(response).to have_http_status(:unauthorized)
  end

  it "refuses a token with the account scope but not the partner scope", parity: true do
    token = create("doorkeeper/access_token", application: partner_application, resource_owner_id: nil, scopes: "account")

    api_call(:get, "/partner/migrations/#{migration.public_id}", token:)

    expect(response).to have_http_status(:forbidden)
    expect(response.parsed_body["message"]).to eq("This endpoint requires the partner_api scope.")
  end

  it "refuses an application that is not flagged as a partner", parity: true do
    application = create(:oauth_application, owner: create(:user), confidential: true, scopes: "partner_api")

    api_call(:get, "/partner/migrations/#{migration.public_id}", token: partner_token(application:))

    expect(response).to have_http_status(:forbidden)
    expect(response.parsed_body["message"]).to eq("This endpoint is only available to partner applications.")
  end

  it "refuses a token that has a resource owner", parity: true do
    token = create("doorkeeper/access_token", application: partner_application, resource_owner_id: create(:user).id, scopes: "partner_api")

    api_call(:get, "/partner/migrations/#{migration.public_id}", token:)

    expect(response).to have_http_status(:forbidden)
  end

  it "refuses an unsupported sort before it looks the migration up", parity: true do
    api_call(:get, "/partner/migrations/#{migration.public_id}", token: partner_token, params: { sort: "price_asc" })

    expect(response).to have_http_status(:bad_request)
    expect(response.parsed_body["message"]).to start_with("Unsupported sort.")
  end

  it "refuses an expired token", parity: true do
    api_call(:get, "/partner/migrations/#{migration.public_id}", token: partner_token(expires_in: 60, created_at: 2.hours.ago))

    expect(response).to have_http_status(:unauthorized)
  end
end
