# frozen_string_literal: true

require "spec_helper"

# GET /:link_id on the third-party analytics host, recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/rest-sweep-4.replay.test.ts. The page is the bare layout that carries the product's snippets for a location, then
# the seller's universal ones; the controller opts out of CSP, skips the session and erases every cookie in the jar. A request that names a
# purchase ($VALUE, $CURRENCY and $ORDER are substituted from the sale) is `hands a ...`.
describe "Third-party analytics index", type: :request do
  let(:seller) { create(:user, username: "analyticsseller") }
  let(:product) { create(:product, user: seller) }

  before { host! THIRD_PARTY_ANALYTICS_DOMAIN }

  def snippet(code, location: "all", link: nil)
    create(:third_party_analytic, user: seller, link:, location:, analytics_code: code)
  end

  it "serves the product snippets for the location, then the seller's universal ones", parity: true do
    snippet("product receipt", location: "receipt", link: product)
    snippet("product all", link: product)
    snippet("product page", location: "product", link: product)
    snippet("user receipt", location: "receipt")
    snippet("user all")
    snippet("other product", link: create(:product, user: seller))

    get "/#{product.unique_permalink}", params: { location: "receipt" }

    expect(response).to have_http_status(:ok)
    expect(response.body).to include("product receipt", "product all", "user receipt", "user all")
    expect(response.body).not_to include("product page", "other product")
    expect(response.body.index("product all")).to be < response.body.index("user all")
  end

  it "serves the snippets scoped to all pages when no location is given", parity: true do
    snippet("product all", link: product)
    snippet("product receipt", location: "receipt", link: product)
    snippet("user all")

    get "/#{product.unique_permalink}"

    expect(response.body).to include("product all", "user all")
    expect(response.body).not_to include("product receipt")
  end

  it "leaves out a snippet that was deleted and keeps the $VALUE placeholder", parity: true do
    snippet("kept $VALUE", link: product)
    snippet("deleted snippet", link: product).mark_deleted!

    get "/#{product.unique_permalink}", params: { location: "product" }

    expect(response.body).to include("kept $VALUE")
    expect(response.body).not_to include("deleted snippet")
  end

  it "renders just the window overrides when nothing matches", parity: true do
    get "/#{product.unique_permalink}", params: { location: "receipt" }

    expect(response).to have_http_status(:ok)
    expect(response.body).to include("window.onbeforeunload")
  end

  it "erases the cookies the visitor sent", parity: true do
    snippet("global user")

    get "/#{product.unique_permalink}", headers: { "Cookie" => "foo=bar; _gumroad_guid=0b6e3a32-4f7f-4a4b-9a43-5a3c8d4d4f11" }

    expect(Array(response.headers["Set-Cookie"]).join("\n")).to include("foo=;")
  end

  it "answers 404 for a product nobody has", parity: true do
    get "/nothing"

    expect(response).to have_http_status(:not_found)
  end

  it "answers 404 for a deleted product", parity: true do
    snippet("global user", link: product)
    product.mark_deleted!

    get "/#{product.unique_permalink}"

    expect(response).to have_http_status(:not_found)
  end

  it "hands a request that names a purchase to Rails", parity: true do
    snippet("value $VALUE order $ORDER", link: product)

    get "/#{product.unique_permalink}", params: { purchase_id: "abc" }
  end
end
