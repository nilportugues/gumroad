# frozen_string_literal: true

require "spec_helper"

# GET /products/affiliated as JSON (Products::AffiliatedController#index, `format.json`), the request the Affiliated page makes to
# search, sort and page. Recorded for the Next.js port (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/ws12p.replay.test.ts,
# which sends the last request of each example. An example named "hands a ..." is one Node leaves to Rails whole.
describe "Products::AffiliatedController#index as JSON", type: :request do
  include Parity::AudienceSignedIn

  let(:affiliate_user) { create(:user, name: "Affiliate Person") }
  let(:creator) { create(:user, name: "Creator One", username: "creatorone") }
  let(:json_headers) { { "Accept" => "application/json" } }

  before { host! DOMAIN }

  def promote(product, basis_points: 1000, direct: nil)
    direct ||= create(:direct_affiliate, seller: creator, affiliate_user:, affiliate_basis_points: basis_points)
    create(:product_affiliate, affiliate: direct, product:, affiliate_basis_points: basis_points)
    direct
  end

  def earn(direct, product, amount_cents:)
    purchase = create(:free_purchase, link: product, seller: product.user)
    create(:affiliate_credit, affiliate_user:, affiliate: direct, purchase:, seller: product.user, link: product, amount_cents:)
  end

  def fetch(params = {})
    get products_affiliated_index_path, params:, headers: json_headers
  end

  def team_member(role)
    member = create(:user, name: "#{role.capitalize} Member")
    membership = create(:team_membership, user: member, seller: affiliate_user, role:)
    log_in(member)
    switch_to(membership)
  end

  it "lists the promoted products with the commission, earnings and the account's totals", parity: true do
    first = create(:product, user: creator, name: "Zeta course", price_cents: 5000)
    second = create(:product, user: creator, name: "Alpha ebook", price_cents: 1500)
    direct = promote(first, basis_points: 2500)
    promote(second, basis_points: 1000, direct:)
    earn(direct, first, amount_cents: 1250)
    earn(direct, first, amount_cents: 1250)
    log_in(affiliate_user)

    fetch

    expect(response).to be_successful
    expect(response.parsed_body["affiliated_products"].map { _1["product_name"] }).to eq(["Zeta course", "Alpha ebook"])
    expect(response.parsed_body["stats"]).to include("total_products" => 2, "total_sales" => 2)
  end

  it "answers an empty page for a user who promotes nothing", parity: true do
    log_in(affiliate_user)

    fetch

    expect(response.parsed_body).to include("affiliated_products" => [], "pagination" => { "pages" => 1, "page" => 1 })
  end

  it "sorts by revenue and searches by product name", parity: true do
    product = create(:product, user: creator, name: "Searchable thing", price_cents: 2000)
    other = create(:product, user: creator, name: "Another", price_cents: 2000)
    direct = promote(product)
    promote(other, direct:)
    earn(direct, other, amount_cents: 300)
    log_in(affiliate_user)

    fetch(sort: { key: "revenue", direction: "desc" }, query: "thing")

    expect(response.parsed_body["affiliated_products"].map { _1["product_name"] }).to eq(["Searchable thing"])
  end

  it "sorts by commission, ascending", parity: true do
    one = create(:product, user: creator, name: "One", price_cents: 2000)
    two = create(:product, user: creator, name: "Two", price_cents: 2000)
    direct = promote(one, basis_points: 3000)
    promote(two, basis_points: 500, direct:)
    log_in(affiliate_user)

    fetch(sort: { key: "commission", direction: "asc" })

    expect(response.parsed_body["affiliated_products"].map { _1["fee_percentage"] }).to eq([5, 30])
  end

  it "clamps a page beyond the last one", parity: true do
    product = create(:product, user: creator, name: "Only one", price_cents: 2000)
    promote(product)
    log_in(affiliate_user)

    fetch(page: "9")

    expect(response.parsed_body["pagination"]).to eq("pages" => 1, "page" => 1)
  end

  it "offers an admin member the affiliate id that removes a row", parity: true do
    product = create(:product, user: creator, name: "Removable", price_cents: 2000)
    promote(product)
    team_member(TeamMembership::ROLE_ADMIN)

    fetch

    expect(response.parsed_body["affiliated_products"].first["affiliate_id"]).to be_present
  end

  it "withholds the affiliate id from a support member", parity: true do
    product = create(:product, user: creator, name: "Removable", price_cents: 2000)
    promote(product)
    team_member(TeamMembership::ROLE_SUPPORT)

    fetch

    expect(response.parsed_body["affiliated_products"].first["affiliate_id"]).to be_nil
  end

  it "asks a user without an email to add one", parity: true do
    log_in(affiliate_user)
    affiliate_user.update_columns(email: nil, unconfirmed_email: nil)

    fetch

    expect(response).to have_http_status(:forbidden)
    expect(response.parsed_body).to eq("success" => false, "error_message" => "Please add an email address to your account before continuing.")
  end

  it "hands a query with a bracketed parameter it does not read to Rails", parity: true do
    log_in(affiliate_user)

    fetch("other" => { "key" => "1" })

    expect(response).to be_successful
    expect(response.parsed_body["affiliated_products"]).to eq([])
  end
end
