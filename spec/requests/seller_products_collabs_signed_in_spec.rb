# frozen_string_literal: true

require "spec_helper"

# Signed-in visits to the collabs page (Products/Collabs/Index), recorded for the Next.js port (PARITY_RECORD=1) and
# replayed by nextjs/parity/__tests__/seller-products.replay.test.ts.
describe "Collabs page when signed in", type: :request do
  include Parity::SignedInDashboard

  let(:seller) { create(:user, name: "Collab Seller") }
  let(:collaborator_user) { create(:user, name: "Collaborator") }
  let(:json_headers) { { "X-Inertia" => "true", "X-Requested-With" => "XMLHttpRequest" } }

  def cache_values(*products)
    products.each { |product| ProductCachedValue.create!(product:) }
  end

  def collab_product(owner:, collaborator:, name:, cut: 30_00, **attributes)
    create(:product, :is_collab, user: owner, collaborator: create(:collaborator, seller: owner, affiliate_user: collaborator, affiliate_basis_points: cut), collaborator_cut: cut, name:, **attributes)
  end

  it "lists the collabs a seller shares with a collaborator", parity: true do
    one = collab_product(owner: seller, collaborator: collaborator_user, name: "Shared guide", price_cents: 2500, created_at: Time.utc(2025, 1, 1))
    two = collab_product(owner: seller, collaborator: create(:user), name: "Second collab", price_cents: 1000, cut: 50_00, created_at: Time.utc(2025, 2, 1))
    cache_values(one, two)
    log_in(seller)

    get products_collabs_path

    expect(response).to be_successful
    expect(inertia_props_of(response)["products_data"]["products"].map { _1["name"] }).to eq(["Second collab", "Shared guide"])
    expect(inertia_props_of(response)["products_data"]["products"].map { _1["cut"] }).to eq([50, 70])
  end

  it "lists the collaborations of a collaborator with their share", parity: true do
    product = collab_product(owner: seller, collaborator: collaborator_user, name: "Shared guide", price_cents: 2500)
    cache_values(product)
    log_in(collaborator_user)

    get products_collabs_path

    expect(inertia_props_of(response)["products_data"]["products"].first).to include("name" => "Shared guide", "cut" => 30, "can_edit" => true)
  end

  it "lists collab memberships in their own table", parity: true do
    membership = collab_product(owner: seller, collaborator: collaborator_user, name: "Collab club", is_recurring_billing: true, subscription_duration: :monthly, is_tiered_membership: true, native_type: Link::NATIVE_TYPE_MEMBERSHIP)
    cache_values(membership)
    log_in(seller)

    get products_collabs_path

    expect(inertia_props_of(response)["memberships_data"]["memberships"].map { _1["name"] }).to eq(["Collab club"])
  end

  it "renders the empty state for a user without collabs", parity: true do
    log_in(seller)

    get products_collabs_path

    expect(inertia_props_of(response)["stats"]).to eq("total_revenue" => 0, "total_customers" => 0, "total_members" => 0, "total_collaborations" => 0)
  end

  it "leaves out a collaboration whose invitation is still pending", parity: true do
    pending_collaborator = create(:collaborator, :with_pending_invitation, seller:, affiliate_user: collaborator_user)
    product = create(:product, :is_collab, user: seller, collaborator: pending_collaborator, name: "Waiting")
    cache_values(product)
    log_in(seller)

    get products_collabs_path

    expect(inertia_props_of(response)["products_data"]["products"]).to eq([])
  end

  it "searches collabs by name and sorts them", parity: true do
    one = collab_product(owner: seller, collaborator: collaborator_user, name: "Alpha collab", created_at: Time.utc(2025, 1, 1))
    two = collab_product(owner: seller, collaborator: create(:user), name: "Beta collab", created_at: Time.utc(2025, 2, 1))
    cache_values(one, two)
    log_in(seller)

    get products_collabs_path, params: { products_sort_key: "name", products_sort_direction: "desc", query: "collab" }

    expect(inertia_props_of(response)["products_data"]["products"].map { _1["name"] }).to eq(["Beta collab", "Alpha collab"])
  end

  it "sorts by revenue and by successful sales count", parity: true do
    one = collab_product(owner: seller, collaborator: collaborator_user, name: "Alpha collab")
    cache_values(one)
    log_in(seller)

    get products_collabs_path, params: { products_sort_key: "revenue", products_sort_direction: "desc", memberships_sort_key: "successful_sales_count" }

    expect(response).to be_successful
  end

  it "answers a partial reload of the tables", parity: true do
    one = collab_product(owner: seller, collaborator: collaborator_user, name: "Alpha collab")
    cache_values(one)
    log_in(seller)

    get products_collabs_path, headers: json_headers.merge("X-Inertia-Partial-Component" => "Products/Collabs/Index", "X-Inertia-Partial-Data" => "products_data,memberships_data")

    expect(response.parsed_body["props"].keys).to include("products_data", "memberships_data")
  end

  it "shows a support team member the collabs", parity: true do
    one = collab_product(owner: seller, collaborator: collaborator_user, name: "Alpha collab")
    cache_values(one)
    member = create(:user, name: "Team Support")
    membership = create(:team_membership, user: member, seller:, role: TeamMembership::ROLE_SUPPORT)
    log_in(member)
    switch_to(membership)

    get products_collabs_path

    expect(inertia_props_of(response)["products_data"]["products"].size).to eq(1)
  end

  it "sends a signed-out visitor to the login page", parity: true do
    get products_collabs_path

    expect(response).to redirect_to(login_path(next: "/products/collabs"))
  end
end
