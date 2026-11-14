# frozen_string_literal: true

require "spec_helper"

# GET /products/:product_id/builds.json (Products::BuildsController#index), recorded for the Next.js port (PARITY_RECORD=1) and replayed
# by nextjs/parity/__tests__/ws12c.replay.test.ts, which sends the last request of each example.
describe "Product builds index", type: :request do
  include Parity::AudienceSignedIn

  let(:seller) { create(:user, name: "Build Seller") }
  let(:product) { create(:product, user: seller, name: "Build product", unique_permalink: "buildprod") }

  before do
    host! DOMAIN
    Feature.activate_user(:product_build_player, seller)
  end

  def get_builds(product_id: product.unique_permalink)
    get "/products/#{product_id}/builds.json", headers: { "Accept" => "application/json, text/html" }
  end

  it "lists an empty history for a product with no builds", parity: true do
    log_in(seller)

    get_builds

    expect(response).to have_http_status(:ok)
    expect(response.parsed_body).to eq("builds" => [])
  end

  it "lists the builds of the product newest number first with their status and promotion time", parity: true do
    create(:product_build, product:, number: 1, status: "superseded", byte_size: 2048, created_at: Time.utc(2026, 3, 1, 10, 0, 0), promoted_at: Time.utc(2026, 3, 2, 10, 0, 0))
    create(:product_build, product:, number: 3, status: "uploaded", byte_size: 4096, created_at: Time.utc(2026, 3, 5, 10, 0, 0))
    create(:product_build, product:, number: 2, status: "live", byte_size: 1024, created_at: Time.utc(2026, 3, 3, 10, 0, 0), promoted_at: Time.utc(2026, 3, 4, 10, 0, 0))
    create(:product_build, product: create(:product, user: seller), number: 9)
    log_in(seller)

    get_builds

    expect(response).to have_http_status(:ok)
    expect(response.parsed_body["builds"].map { _1["number"] }).to eq([3, 2, 1])
    expect(response.parsed_body["builds"].map { _1["status"] }).to eq(%w[uploaded live superseded])
  end

  it "answers 404 for an unknown product", parity: true do
    log_in(seller)

    get_builds(product_id: "nope")

    expect(response).to have_http_status(:not_found)
  end

  it "answers 404 for a deleted product", parity: true do
    product.update_column(:deleted_at, Time.utc(2026, 3, 1))
    log_in(seller)

    get_builds

    expect(response).to have_http_status(:not_found)
  end

  it "answers 404 while the player is off for the seller", parity: true do
    Feature.deactivate_user(:product_build_player, seller)
    create(:product_build, product:, number: 1)
    log_in(seller)

    get_builds

    expect(response).to have_http_status(:not_found)
  end

  it "refuses another seller's product", parity: true do
    create(:product_build, product:, number: 1)
    log_in(create(:user, name: "Other Seller"))

    get_builds

    expect(response).to have_http_status(:unauthorized)
  end

  it "refuses a support team member", parity: true do
    member = create(:user, name: "Support Member")
    membership = create(:team_membership, user: member, seller:, role: TeamMembership::ROLE_SUPPORT)
    log_in(member)
    switch_to(membership)

    get_builds

    expect(response).to have_http_status(:unauthorized)
  end

  it "lists the builds to an admin team member", parity: true do
    create(:product_build, product:, number: 1, created_at: Time.utc(2026, 3, 1, 10, 0, 0))
    member = create(:user, name: "Admin Member")
    membership = create(:team_membership, user: member, seller:, role: TeamMembership::ROLE_ADMIN)
    log_in(member)
    switch_to(membership)

    get_builds

    expect(response).to have_http_status(:ok)
    expect(response.parsed_body["builds"].size).to eq(1)
  end
end
