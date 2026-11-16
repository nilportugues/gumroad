# frozen_string_literal: true

require "spec_helper"

# ProductBuildDemoFilesController#show (GET /demo/:id/:grant/*path), recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/product-build-player-files.replay.test.ts. The grant is the only credential and no demo check runs for
# a file that is not a page, so these examples need no feature flag. A page of the build is handed to Rails whole ("hands a ...").
describe "ProductBuildDemoFilesController", type: :request do
  let(:seller) { create(:user) }
  let(:product) { create(:product, user: seller, name: "Free demo", price_cents: 0) }
  let!(:build) { create(:product_build, :live, product:, number: 1, site_unpacked_at: Time.current) }

  # Objects the requests point at. The replay puts the same bytes in its own storage.
  DEMO_FILES = {
    "game.js" => ["console.log(1)", "text/javascript"],
    "art/logo.svg" => ["<svg xmlns='http://www.w3.org/2000/svg'/>", "image/svg+xml"],
    "engine.wasm" => ["\0asm", "application/wasm"],
    "index.html" => ["<!doctype html><html><head><title>Game</title></head><body></body></html>", "text/html"],
  }.freeze

  before do
    host! DOMAIN
    s3 = Aws::S3::Client.new
    DEMO_FILES.each { |name, (body, type)| s3.put_object(bucket: S3_BUCKET, key: "#{build.site_prefix}/#{name}", body:, content_type: type) }
  end

  def demo_file(path, grant: build.demo_grant, id: product.external_id)
    get "/demo/#{id}/#{grant}/#{path}"
  end

  it "streams a script under the demo grant, open to any origin", parity: true do
    demo_file "game.js"

    expect(response).to have_http_status(:ok)
    expect(response.body).to eq("console.log(1)")
    expect(response.headers["Access-Control-Allow-Origin"]).to eq("*")
  end

  it "hands an SVG of the demo build to Rails", parity: true do
    demo_file "art/logo.svg"

    expect(response).to have_http_status(:ok)
    expect(response.headers["Content-Security-Policy"]).to include("https://x.com")
    expect(response.headers["Referrer-Policy"]).to eq("no-referrer")
  end

  it "redirects a file served from the CDN to a signed link", parity: true do
    demo_file "engine.wasm"

    expect(response).to have_http_status(:found)
    expect(response.location).to include("engine.wasm")
  end

  it "answers 404 for a script the build does not have", parity: true do
    demo_file "missing.js"

    expect(response).to have_http_status(:not_found)
  end

  it "answers 404 for a grant that is not one", parity: true do
    demo_file "game.js", grant: "not-a-grant"

    expect(response).to have_http_status(:not_found)
  end

  it "answers 404 for a buyer's player grant used on the demo", parity: true do
    player_grant = build.player_grant(url_redirect_token: product.external_id, purchase_id: 1)

    demo_file "game.js", grant: player_grant

    expect(response).to have_http_status(:not_found)
  end

  it "answers 404 for a grant of another product", parity: true do
    other = create(:product, user: seller, price_cents: 0)

    demo_file "game.js", id: other.external_id

    expect(response).to have_http_status(:not_found)
  end

  it "hands a page of the demo build to Rails", parity: true do
    demo_file "index.html"

    expect(response).to have_http_status(:not_found)
  end
end
