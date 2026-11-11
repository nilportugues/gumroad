# frozen_string_literal: true

require "spec_helper"

# ProductBuildPlayerFilesController#show, recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/product-build-player-files.replay.test.ts, which sends the last request of each example. An example named
# "hands a ..." records what Node passes to Rails whole: the save endpoint. A page of the build (the save shim, which needs the
# widget bundle `rake vite:build_widget` builds) is handed to Rails too and is not recorded.
describe "ProductBuildPlayerFilesController", type: :request do
  let(:seller) { create(:user, name: "Build Seller") }
  let(:product) { create(:product, user: seller, name: "Build product") }
  let(:purchase) { create(:free_purchase, link: product, email: "builder@example.com") }
  let!(:url_redirect) { create(:url_redirect, link: product, purchase:, uses: 0, expires_at: nil) }
  let!(:build) { create(:product_build, :live, product:, number: 1, site_unpacked_at: Time.current) }
  let(:token) { url_redirect.token }

  # Objects the requests point at. The replay puts the same bytes in its own storage.
  FILES = {
    "game.js" => ["console.log(1)", "text/javascript"],
    "style.css" => ["body { margin: 0 }", "text/css"],
    "engine.wasm" => ["\0asm", "application/wasm"],
    "art/logo.svg" => ["<svg xmlns='http://www.w3.org/2000/svg'/>", "image/svg+xml"],
    "data.xml" => ["<data/>", "application/xml"],
    "index.html" => ["<!doctype html><html><head><title>Game</title></head><body></body></html>", "text/html"],
  }.freeze

  before do
    host! DOMAIN
    Feature.activate_user(:product_build_player, seller)
    s3 = Aws::S3::Client.new
    FILES.each { |name, (body, type)| s3.put_object(bucket: S3_BUCKET, key: "#{build.site_prefix}/#{name}", body:, content_type: type) }
  end

  def grant(purchase_id: purchase.id)
    build.player_grant(url_redirect_token: token, purchase_id:)
  end

  def play(path, grant: self.grant, token: self.token)
    get "/d/#{token}/play/#{grant}/#{path}"
  end

  it "streams a script under the grant, open to any origin", parity: true do
    play "game.js"

    expect(response).to have_http_status(:ok)
    expect(response.body).to eq("console.log(1)")
    expect(response.headers["Access-Control-Allow-Origin"]).to eq("*")
  end

  it "streams a stylesheet", parity: true do
    play "style.css"

    expect(response).to have_http_status(:ok)
    expect(response.media_type).to eq("text/css")
  end

  it "serves an SVG from the app with the sandbox CSP", parity: true do
    play "art/logo.svg"

    expect(response).to have_http_status(:ok)
    expect(response.headers["Content-Security-Policy"]).to start_with("sandbox allow-scripts allow-pointer-lock;")
    expect(response.headers["Referrer-Policy"]).to eq("no-referrer")
  end

  it "serves an XML file with the sandbox CSP", parity: true do
    play "data.xml"

    expect(response).to have_http_status(:ok)
    expect(response.headers["Content-Security-Policy"]).to include("frame-ancestors")
  end

  it "redirects a file served from the CDN to a signed link", parity: true do
    play "engine.wasm"

    expect(response).to have_http_status(:found)
    expect(response.location).to include("engine.wasm")
    expect(response.headers["Cache-Control"]).to include("max-age=300")
  end

  it "answers 404 for a script the build does not have", parity: true do
    play "missing.js"

    expect(response).to have_http_status(:not_found)
  end

  it "answers 404 for a grant of another content page token", parity: true do
    other = create(:url_redirect, link: product, purchase: create(:free_purchase, link: product, email: "other@example.com"), uses: 0, expires_at: nil)

    play "game.js", token: other.token

    expect(response).to have_http_status(:not_found)
  end

  it "answers 404 for a grant that is not one", parity: true do
    play "game.js", grant: "not-a-grant"

    expect(response).to have_http_status(:not_found)
  end

  it "answers 404 for a save grant used for files", parity: true do
    save_grant = ProductBuild.player_save_grant(url_redirect_token: token, purchase_id: purchase.id)

    play "game.js", grant: save_grant

    expect(response).to have_http_status(:not_found)
  end

  it "hands a save to Rails", parity: true do
    save_grant = ProductBuild.player_save_grant(url_redirect_token: token, purchase_id: purchase.id)

    post "/d/#{token}/play/#{save_grant}/save", params: { set: { "level" => "4" } }.to_json, headers: { "CONTENT_TYPE" => "text/plain;charset=UTF-8" }

    expect(response).to have_http_status(:no_content)
  end
end
