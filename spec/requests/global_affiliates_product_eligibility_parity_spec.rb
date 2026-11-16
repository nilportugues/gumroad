# frozen_string_literal: true

require "spec_helper"

# GET /global_affiliates/product_eligibility/:url, recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/rest-sweep-2.replay.test.ts, which sends the last request of each example. Node answers the URLs Rails
# refuses before it connects (no http(s) scheme, a host outside Gumroad's domains); a URL that could be ours is `hands a ...`.
describe "Global affiliate product eligibility", type: :request do
  include Parity::AudienceSignedIn

  let(:seller) { create(:user, name: "Eligibility Seller") }

  before { host! DOMAIN }

  def check(url, headers: { "Accept" => "application/json" })
    get "/global_affiliates/product_eligibility/#{ERB::Util.url_encode(url)}", headers:
  end

  def expect_invalid_url
    expect(response).to have_http_status(:ok)
    expect(response.parsed_body).to eq("success" => false, "error" => "Please provide a valid Gumroad product URL")
  end

  it "refuses a host outside Gumroad's domains", parity: true do
    log_in(seller)

    check("https://example.com/l/abc")

    expect_invalid_url
  end

  it "refuses a host that only ends like Gumroad's", parity: true do
    log_in(seller)

    check("https://notgumroad.com/l/abc")

    expect_invalid_url
  end

  it "refuses a URL without a scheme", parity: true do
    log_in(seller)

    check("gumroad.com/l/abc")

    expect_invalid_url
  end

  it "refuses a scheme other than http and https", parity: true do
    log_in(seller)

    check("ftp://gumroad.com/l/abc")

    expect_invalid_url
  end

  it "refuses text that is not a URL", parity: true do
    log_in(seller)

    check("not a url")

    expect_invalid_url
  end

  it "lets a marketing team member in", parity: true do
    member = create(:user, name: "Marketing Member")
    membership = create(:team_membership, user: member, seller:, role: TeamMembership::ROLE_MARKETING)
    log_in(member)
    switch_to(membership)

    check("https://example.com/l/abc")

    expect_invalid_url
  end

  it "hands a URL on Gumroad's own domain to Rails", parity: true, skip_ssrf_stub: true do
    product = create(:product, user: seller, name: "Eligible product")
    url = "#{PROTOCOL}://#{DOMAIN}/l/#{product.unique_permalink}"
    allow(Resolv).to receive(:getaddresses).and_return(["93.184.216.34"])
    stub_request(:get, "#{url}.json")
      .to_return(status: 200, body: { api_version: ProductPresenter::PublicApiProps::API_VERSION, id: product.external_id, permalink: product.general_permalink }.to_json, headers: { "Content-Type" => "application/json" })
    log_in(seller)

    check(url)

    expect(response).to have_http_status(:ok)
    expect(response.parsed_body).to include("success" => true)
  end
end
