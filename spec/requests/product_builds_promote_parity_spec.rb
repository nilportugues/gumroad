# frozen_string_literal: true

require "spec_helper"

# POST /products/:product_id/builds/:id/promote, recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/rest-sweep-2.replay.test.ts, which sends the last request of each example. Node answers the 404s, the Pundit
# refusal and the promotion of a build for a product with one set of pages (ProductBuild#promote!, `parity_timeline` records the order of
# its writes and jobs); a build that is already live and a product with no page yet (Rails creates one) are `hands a ...`.
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

  def embed(file, uid) = { "type" => "fileEmbed", "attrs" => { "id" => file.external_id, "uid" => uid } }

  it "hands a promotion of a product with no pages to Rails", parity: true do
    log_in(seller)

    promote

    expect(response).to have_http_status(:no_content)
    expect(build.reload.status).to eq("live")
    expect(build.product_file.display_name).to eq("Build product build 1.zip")
  end

  it "supersedes the live build and swaps its file in the pages", parity: true, parity_timeline: true do
    live = create(:product_build, product:, number: 2, status: "live", promoted_at: Time.utc(2026, 1, 2, 3, 4, 5))
    live.update!(product_file: create(:product_file, link: product, url: "#{S3_BASE_URL}#{live.storage_key}"))
    create(:rich_content, entity: product, description: [{ "type" => "paragraph", "content" => [{ "type" => "text", "text" => "Intro" }] }, embed(live.product_file, "00000000-0000-4000-8000-000000000001")])
    log_in(seller)

    promote

    expect(response).to have_http_status(:no_content)
    expect(live.reload.status).to eq("superseded")
    expect(build.reload.status).to eq("live")
  end

  it "hands a promotion of the live build to Rails", parity: true do
    live = create(:product_build, product:, number: 3, status: "live", promoted_at: Time.utc(2026, 1, 2, 3, 4, 5))
    log_in(seller)

    promote(build_id: live.public_id)

    expect(response).to have_http_status(:no_content)
  end
end
