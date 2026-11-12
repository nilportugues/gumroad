# frozen_string_literal: true

require "spec_helper"

# POST /products/:product_id/builds/:id/promote, recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/rest-sweep-2.replay.test.ts, which sends the last request of each example. Node answers the 404s and the
# Pundit refusal; promoting a build (ProductBuild#promote!) is `hands a ...`.
describe "Promoting a product build", type: :request do
  include Parity::AudienceSignedIn

  let(:seller) { create(:user, name: "Build Seller") }
  let(:product) { create(:product, user: seller, name: "Build product") }
  let!(:build) { create(:product_build, product:, number: 1, status: "uploaded") }
  let(:headers) { { "CONTENT_TYPE" => "application/json", "Accept" => "application/json" } }

  before do
    host! DOMAIN
    Feature.activate_user(:product_build_player, seller)
  end

  def promote(product_id: product.unique_permalink, build_id: build.public_id)
    post "/products/#{product_id}/builds/#{build_id}/promote.json", headers: headers.merge("X-CSRF-Token" => csrf_token)
  end

  it "answers 404 for an unknown product", parity: true do
    log_in(seller)

    promote(product_id: "nope")

    expect(response).to have_http_status(:not_found)
  end

  it "answers 404 for a build the product does not have", parity: true do
    log_in(seller)

    promote(build_id: "missing")

    expect(response).to have_http_status(:not_found)
  end

  it "answers 404 for the build of another product", parity: true do
    other = create(:product_build, product: create(:product, user: seller), number: 1)
    log_in(seller)

    promote(build_id: other.public_id)

    expect(response).to have_http_status(:not_found)
  end

  it "answers 404 while the player is off for the seller", parity: true do
    Feature.deactivate_user(:product_build_player, seller)
    log_in(seller)

    promote

    expect(response).to have_http_status(:not_found)
  end

  it "refuses another seller's product", parity: true do
    log_in(create(:user, name: "Other Seller"))

    promote

    expect(response).to have_http_status(:unauthorized)
    expect(build.reload.status).to eq("uploaded")
  end

  it "refuses a support team member", parity: true do
    member = create(:user, name: "Support Member")
    membership = create(:team_membership, user: member, seller:, role: TeamMembership::ROLE_SUPPORT)
    log_in(member)
    switch_to(membership)

    promote

    expect(response).to have_http_status(:unauthorized)
  end

  it "hands the promotion of a build to Rails", parity: true do
    log_in(seller)

    promote

    expect(response).to have_http_status(:no_content)
    expect(build.reload.status).to eq("live")
  end
end
