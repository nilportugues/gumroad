# frozen_string_literal: true

require "spec_helper"

# GET /demo/:id (ProductBuildDemosController#show), recorded for the Next.js port (PARITY_RECORD=1). The page's props are the
# product name, the demo grant in the frame's path and the click-through to the product; the grant is encrypted afresh on every
# request, so nextjs/src/server/page-props/product-builds/demo.test.ts opens it rather than comparing it as text. The page is
# not served from Node: whether a build is a public demo (`ProductBuild#demo?`) is not ported.
describe "Product build demo page", type: :request do
  let(:seller) { create(:user) }
  let(:product) { create(:product, user: seller, name: "Clicker & <Friends>", price_cents: 0) }
  let!(:build) { create(:product_build, :live, product:, number: 1, site_unpacked_at: Time.current) }

  before do
    host! DOMAIN
    Feature.activate_user(:product_build_player, seller)
    Feature.activate_user(:product_build_demo, seller)
  end

  it "renders the live build of a free product", parity: true do
    get "/demo/#{product.external_id}"

    expect(response).to have_http_status(:ok)
  end

  it "renders the build the seller chose for a paid product", parity: true do
    product.update!(price_cents: 500)
    chosen = create(:product_build, product:, number: 2, site_unpacked_at: Time.current)
    chosen.select_as_demo!

    get "/demo/#{product.external_id}"

    expect(response).to have_http_status(:ok)
  end

  it "answers 404 for a product without a demo", parity: true do
    build.update!(status: "superseded")

    get "/demo/#{product.external_id}"

    expect(response).to have_http_status(:not_found)
  end
end
