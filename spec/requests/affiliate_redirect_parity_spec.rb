# frozen_string_literal: true

require "spec_helper"

# AffiliateRedirectController#set_cookie_and_redirect (/a/:affiliate_id[/:unique_permalink]), recorded for the Next.js port
# (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/ws12b.replay.test.ts.
describe "Affiliate redirect", type: :request do
  let(:seller) { create(:named_seller) }
  let(:product) { create(:product, user: seller, unique_permalink: "affprod") }
  let(:other_product) { create(:product, user: seller, unique_permalink: "affother") }
  let(:affiliate_user) { create(:affiliate_user) }
  let(:direct_affiliate) { create(:direct_affiliate, affiliate_user:, seller:, products: [product]) }

  before { host! DOMAIN }

  it "sends the visitor to the only product of the affiliate and sets the cookie", parity: true do
    get "/a/#{direct_affiliate.external_id_numeric}"

    expect(response).to have_http_status(:found)
    expect(response.location).to eq(product.long_url)
    expect(set_cookie_names).to include(direct_affiliate.cookie_key)
  end

  it "sends the visitor to the profile when the affiliate has several products", parity: true do
    direct_affiliate.products << other_product

    get "/a/#{direct_affiliate.external_id_numeric}"

    expect(response).to have_http_status(:found)
    expect(response.location).to eq(seller.subdomain_with_protocol)
  end

  it "keeps the query string of the request", parity: true do
    get "/a/#{direct_affiliate.external_id_numeric}", params: { amir: "cool", you: "also cool" }

    expect(response).to have_http_status(:found)
    expect(response.location).to eq("#{product.long_url}?amir=cool&you=also%20cool")
  end

  it "sends the visitor to the destination url and adds the affiliate id", parity: true do
    direct_affiliate.update!(destination_url: "https://example.com/l/abc?from=affiliate", apply_to_all_products: true)

    get "/a/#{direct_affiliate.external_id_numeric}", params: { b: "2" }

    expect(response).to have_http_status(:found)
    expect(response.location).to eq("https://example.com/l/abc?affiliate_id=#{direct_affiliate.external_id_numeric}&b=2&from=affiliate")
  end

  it "reads the product of the url", parity: true do
    direct_affiliate.products << other_product

    get "/a/#{direct_affiliate.external_id_numeric}/#{other_product.unique_permalink}"

    expect(response).to have_http_status(:found)
    expect(response.location).to eq(other_product.long_url)
  end

  it "uses the per-product destination url", parity: true do
    direct_affiliate.product_affiliates.first.update_column(:destination_url, "products/foo")

    get "/a/#{direct_affiliate.external_id_numeric}/#{product.unique_permalink}"

    expect(response).to have_http_status(:found)
    expect(URI.parse(response.location).path).to eq("/products/foo")
  end

  it "ignores a product that is not the affiliate's", parity: true do
    direct_affiliate.products << other_product

    get "/a/#{direct_affiliate.external_id_numeric}/nope"

    expect(response).to have_http_status(:found)
    expect(response.location).to eq(seller.subdomain_with_protocol)
  end

  it "sends the visitor of a global affiliate to the product", parity: true do
    global_affiliate = create(:user).global_affiliate

    get "/a/#{global_affiliate.external_id_numeric}/#{product.unique_permalink}"

    expect(response).to have_http_status(:found)
    expect(response.location).to eq(product.long_url)
    expect(set_cookie_names).to include(global_affiliate.cookie_key)
  end

  it "sends the visitor of a global affiliate to discover", parity: true do
    global_affiliate = create(:user).global_affiliate

    get "/a/#{global_affiliate.external_id_numeric}"

    expect(response).to have_http_status(:found)
    expect(response.location).to include("a=#{global_affiliate.external_id_numeric}")
  end

  it "redirects without a cookie when the affiliate was removed", parity: true do
    direct_affiliate.update!(deleted_at: Time.current)

    get "/a/#{direct_affiliate.external_id_numeric}"

    expect(response).to have_http_status(:found)
    expect(set_cookie_names).not_to include(direct_affiliate.cookie_key)
  end

  it "answers 404 for an unknown affiliate", parity: true do
    get "/a/123456789"

    expect(response).to have_http_status(:not_found)
  end

  def set_cookie_names = Array(response.headers["Set-Cookie"]).join("\n").scan(/^([^=\n]+)=/).flatten
end
