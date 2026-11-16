# frozen_string_literal: true

require "spec_helper"

# Signed-in visits to the affiliated products page (Products/Affiliated/Index), recorded for the Next.js port
# (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/seller-products.replay.test.ts.
describe "Affiliated products page when signed in", type: :request do
  include Parity::SignedInDashboard

  let(:affiliate_user) { create(:user, name: "Affiliate Person") }
  let(:creator) { create(:user, name: "Creator One", username: "creatorone") }
  let(:json_headers) { { "X-Inertia" => "true", "X-Requested-With" => "XMLHttpRequest" } }

  def promote(product, creator:, basis_points: 1000, direct: nil)
    direct ||= create(:direct_affiliate, seller: creator, affiliate_user:, affiliate_basis_points: basis_points)
    create(:product_affiliate, affiliate: direct, product:, affiliate_basis_points: basis_points)
    direct
  end

  def earn(direct, product, amount_cents:)
    purchase = create(:free_purchase, link: product, seller: product.user)
    create(:affiliate_credit, affiliate_user:, affiliate: direct, purchase:, seller: product.user, link: product, amount_cents:)
  end

  it "lists the products the user promotes with the commission and earnings", parity: true do
    first = create(:product, user: creator, name: "Zeta course", price_cents: 5000)
    second = create(:product, user: creator, name: "Alpha ebook", price_cents: 1500)
    direct = promote(first, creator:, basis_points: 2500)
    promote(second, creator:, basis_points: 1000, direct:)
    earn(direct, first, amount_cents: 1250)
    earn(direct, first, amount_cents: 1250)
    log_in(affiliate_user)

    get products_affiliated_index_path

    expect(response).to be_successful
    expect(inertia_props_of(response)["affiliated_products"].size).to eq(2)
  end

  it "renders the empty state for a user who promotes nothing", parity: true do
    log_in(affiliate_user)

    get products_affiliated_index_path

    expect(inertia_props_of(response)).to include("affiliated_products" => [], "stats" => include("total_products" => 0))
  end

  it "sorts by revenue and searches by product name through the JSON endpoint", parity: true do
    product = create(:product, user: creator, name: "Searchable thing", price_cents: 2000)
    other = create(:product, user: creator, name: "Another", price_cents: 2000)
    direct = promote(product, creator:)
    promote(other, creator:, direct:)
    earn(direct, other, amount_cents: 300)
    log_in(affiliate_user)

    get products_affiliated_index_path, params: { sort: { key: "revenue", direction: "desc" }, query: "thing" }, headers: json_headers

    expect(response).to be_successful
    expect(response.parsed_body["props"]["affiliated_products"].map { _1["product_name"] }).to eq(["Searchable thing"])
  end

  it "sorts by commission, ascending", parity: true do
    one = create(:product, user: creator, name: "One", price_cents: 2000)
    two = create(:product, user: creator, name: "Two", price_cents: 2000)
    direct = promote(one, creator:, basis_points: 3000)
    promote(two, creator:, basis_points: 500, direct:)
    log_in(affiliate_user)

    get products_affiliated_index_path, params: { sort: { key: "commission", direction: "asc" } }, headers: json_headers

    expect(response.parsed_body["props"]["affiliated_products"].map { _1["product_name"] }).to eq(%w[Two One])
  end

  it "pages through more than one page", parity: true do
    products = Array.new(21) { |index| create(:product, user: creator, name: "Promoted #{format('%02d', index)}", price_cents: 500) }
    direct = create(:direct_affiliate, seller: creator, affiliate_user:, affiliate_basis_points: 1000)
    products.each_with_index { |product, index| create(:product_affiliate, affiliate: direct, product:, affiliate_basis_points: 1000).update_columns(id: 100 + index) }
    log_in(affiliate_user)

    get products_affiliated_index_path, params: { page: "2" }, headers: json_headers

    expect(response.parsed_body["props"]["affiliated_products"].size).to eq(1)
    expect(response.parsed_body["props"]["pagination"]).to eq("pages" => 2, "page" => 2)
  end

  it "leaves out deleted and banned products", parity: true do
    live = create(:product, user: creator, name: "Live")
    gone = create(:product, user: creator, name: "Gone", deleted_at: Time.utc(2025, 1, 1))
    direct = promote(live, creator:)
    promote(gone, creator:, direct:)
    log_in(affiliate_user)

    get products_affiliated_index_path, headers: json_headers

    expect(response.parsed_body["props"]["affiliated_products"].map { _1["product_name"] }).to eq(["Live"])
  end

  it "tells an admin team member they can end an affiliation", parity: true do
    product = create(:product, user: creator, name: "Team shown")
    promote(product, creator:)
    member = create(:user, name: "Team Admin")
    membership = create(:team_membership, user: member, seller: affiliate_user, role: TeamMembership::ROLE_ADMIN)
    log_in(member)
    switch_to(membership)

    get products_affiliated_index_path, headers: json_headers

    expect(response.parsed_body["props"]["affiliated_products"].first["affiliate_id"]).to be_present
  end

  it "shows a support team member the list without the remove permission", parity: true do
    product = create(:product, user: creator, name: "Team shown")
    promote(product, creator:)
    member = create(:user, name: "Team Support")
    membership = create(:team_membership, user: member, seller: affiliate_user, role: TeamMembership::ROLE_SUPPORT)
    log_in(member)
    switch_to(membership)

    get products_affiliated_index_path, headers: json_headers

    expect(response.parsed_body["props"]["affiliated_products"].first["affiliate_id"]).to be_nil
  end

  it "sends a signed-out visitor to the login page", parity: true do
    get products_affiliated_index_path

    expect(response).to redirect_to(login_path(next: "/products/affiliated"))
  end

  it "reports the archived tab when the user has archived products" , parity: true do
    create(:product, user: affiliate_user, name: "Mine", archived: true)
    log_in(affiliate_user)

    get products_affiliated_index_path, headers: json_headers

    expect(response.parsed_body["props"]["archived_tab_visible"]).to eq(true)
  end
end
