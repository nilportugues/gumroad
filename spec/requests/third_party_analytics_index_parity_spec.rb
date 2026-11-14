# frozen_string_literal: true

require "spec_helper"

# GET /:link_id on the third-party analytics host, recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/rest-sweep-4.replay.test.ts. The page is the bare layout that carries the product's snippets for a location, then
# the seller's universal ones; the controller opts out of CSP, skips the session and erases every cookie in the jar. A request that names a
# purchase has $VALUE, $CURRENCY and $ORDER substituted from the sale; a purchase_id Node does not read is `hands a ...`.
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

  def sale(of: product, displayed_price_cents: 1550)
    build(:purchase, link: of, seller: of.user, price_cents: displayed_price_cents, displayed_price_cents:, purchase_state: "successful",
                     email: "buyer#{SecureRandom.hex(3)}@example.com").tap { |purchase| purchase.save!(validate: false) }
  end

  it "fills in the value, currency and order of the sale in every snippet", parity: true do
    snippet("product $VALUE $CURRENCY $ORDER $VALUE", link: product)
    snippet("user $VALUE|$CURRENCY|$ORDER")
    purchase = sale

    get "/#{product.unique_permalink}", params: { purchase_id: purchase.external_id }

    expect(response).to have_http_status(:ok)
    expect(response.body).to include("product 15.50 USD #{purchase.external_id} 15.50", "user 15.50|USD|#{purchase.external_id}")
  end

  it "drops the cents of a whole price and groups the thousands", parity: true do
    snippet("value $VALUE", link: product)

    get "/#{product.unique_permalink}", params: { purchase_id: sale(displayed_price_cents: 500_000).external_id }

    expect(response.body).to include("value 5,000")
  end

  it "groups the thousands of a price with cents", parity: true do
    snippet("value $VALUE", link: product)

    get "/#{product.unique_permalink}", params: { purchase_id: sale(displayed_price_cents: 123_456).external_id }

    expect(response.body).to include("value 1,234.56")
  end

  it "formats the price in the currency of the product", parity: true do
    jpy_product = create(:product, user: seller, price_currency_type: "jpy", price_cents: 500)
    snippet("value $VALUE $CURRENCY", link: jpy_product)

    get "/#{jpy_product.unique_permalink}", params: { purchase_id: sale(of: jpy_product, displayed_price_cents: 1250).external_id }

    expect(response.body).to include("value 1,250 JPY")
  end

  it "keeps the placeholders when the purchase_id is blank", parity: true do
    snippet("value $VALUE", link: product)

    get "/#{product.unique_permalink}", params: { purchase_id: "" }

    expect(response).to have_http_status(:ok)
    expect(response.body).to include("value $VALUE")
  end

  it "answers 404 for a purchase_id that is not a sale", parity: true do
    snippet("value $VALUE order $ORDER", link: product)

    get "/#{product.unique_permalink}", params: { purchase_id: "abc" }

    expect(response).to have_http_status(:not_found)
  end

  it "answers 404 for the sale of another product", parity: true do
    snippet("value $VALUE", link: product)
    other = sale(of: create(:product, user: seller))

    get "/#{product.unique_permalink}", params: { purchase_id: other.external_id }

    expect(response).to have_http_status(:not_found)
  end

  it "hands a purchase_id with characters outside an external id to Rails", parity: true do
    snippet("value $VALUE", link: product)

    get "/#{product.unique_permalink}", params: { purchase_id: "ab c" }
  end
end
