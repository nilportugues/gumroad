# frozen_string_literal: true

require "spec_helper"

# GET /profile/:username on the third-party analytics host, recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/rest-sweep-4.replay.test.ts. The page is a bare layout that carries the seller's universal snippets for
# every page; the controller opts out of CSP, skips the session and erases every cookie in the jar.
describe "Third-party analytics profile", type: :request do
  let(:seller) { create(:user, username: "analyticsseller") }
  let(:product) { create(:product, user: seller) }

  before { host! THIRD_PARTY_ANALYTICS_DOMAIN }

  def snippet(code, location: "all", link: nil)
    create(:third_party_analytic, user: seller, link:, location:, analytics_code: code)
  end

  it "serves only the universal snippets scoped to all pages, in the bare layout", parity: true do
    snippet("global user one")
    snippet("global user two")
    snippet("global product", link: product)
    snippet("product user", location: "product")
    snippet("receipt user", location: "receipt")

    get "/profile/#{seller.username}"

    expect(response).to have_http_status(:ok)
    expect(response.body).to include("global user one")
    expect(response.body).to include("global user two")
    expect(response.body).not_to include("global product", "product user", "receipt user")
  end

  it "leaves out a snippet that was deleted", parity: true do
    snippet("kept snippet")
    snippet("deleted snippet").mark_deleted!

    get "/profile/#{seller.username}"

    expect(response.body).to include("kept snippet")
    expect(response.body).not_to include("deleted snippet")
  end

  it "renders just the window overrides when the seller has no snippets", parity: true do
    get "/profile/#{seller.username}"

    expect(response).to have_http_status(:ok)
    expect(response.body).not_to include("global")
  end

  it "erases the cookies the visitor sent", parity: true do
    snippet("global user")

    get "/profile/#{seller.username}", headers: { "Cookie" => "foo=bar; _gumroad_guid=0b6e3a32-4f7f-4a4b-9a43-5a3c8d4d4f11" }

    expect(response).to have_http_status(:ok)
    expect(Array(response.headers["Set-Cookie"]).join("\n")).to include("foo=;")
  end

  it "erases the guid cookie it minted for a visitor who sent other cookies", parity: true do
    snippet("global user")

    get "/profile/#{seller.username}", headers: { "Cookie" => "foo=bar" }

    expect(Array(response.headers["Set-Cookie"]).join("\n")).to include("_gumroad_guid=;")
  end

  it "answers 404 for a username nobody has", parity: true do
    get "/profile/nobodyhere"

    expect(response).to have_http_status(:not_found)
  end

  it "answers 404 for a deleted user", parity: true do
    snippet("global user")
    seller.update_columns(deleted_at: Time.current)

    get "/profile/#{seller.username}"

    expect(response).to have_http_status(:not_found)
  end
end
