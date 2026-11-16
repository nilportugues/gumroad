# frozen_string_literal: true

require "spec_helper"

# GET /v2/categories and /api/v2/categories, recorded for the Next.js port (nextjs/parity/__tests__/api-v2-products.replay.test.ts).
describe "API v2 categories", type: :request do
  include Parity::ApiV2Requests

  let(:seller) { create(:user) }

  before do
    Rails.cache.delete("taxonomies_for_nav")
    design = Taxonomy.find_or_create_by!(slug: "design")
    ui_and_web = Taxonomy.find_or_create_by!(slug: "ui-and-web", parent: design)
    Taxonomy.find_or_create_by!(slug: "figma", parent: ui_and_web)
    Taxonomy.find_or_create_by!(slug: "unlabelled-example")
    Taxonomy.find_or_create_by!(slug: "other")
    Rails.cache.delete("taxonomies_for_nav")
  end

  it "lists the flat category list with the public read scope", parity: true do
    api_call(:get, "/categories", token: api_token(seller, scopes: "view_public"))

    expect(response).to have_http_status(:ok)
    expect(response.headers["Cache-Control"]).to include("max-age=3600")
    expect(response.parsed_body["categories"].map { _1["path"] }).to include("design/ui-and-web/figma", "unlabelled-example")
  end

  it "lists the categories with the account scope on the Gumroad domain", parity: true do
    api_call(:get, "/categories", token: api_token(seller, scopes: "account"), api_host: false)

    expect(response).to have_http_status(:ok)
  end

  it "refuses a request without a token", parity: true do
    api_call(:get, "/categories")

    expect(response).to have_http_status(:unauthorized)
  end

  it "refuses a token without a public scope", parity: true do
    api_call(:get, "/categories", token: api_token(seller, scopes: "edit_emails"))

    expect(response).to have_http_status(:forbidden)
  end
end
