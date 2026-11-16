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

  it "quotes collabs listed in other currencies in their own", parity: true do
    euro = collab_product(owner: seller, collaborator: collaborator_user, name: "Euro collab", price_cents: 1050, created_at: Time.utc(2025, 1, 1))
    yen = collab_product(owner: seller, collaborator: create(:user), name: "Yen collab", price_cents: 1500, created_at: Time.utc(2025, 2, 1))
    [[euro, "eur", 1050], [yen, "jpy", 1500]].each do |product, currency, cents|
      product.update_columns(price_currency_type: currency, price_cents: cents)
      product.prices.update_all(currency:, price_cents: cents)
    end
    cache_values(euro, yen)
    log_in(seller)

    get products_collabs_path, headers: json_headers.merge("X-Inertia-Partial-Component" => "Products/Collabs/Index", "X-Inertia-Partial-Data" => "products_data,memberships_data")

    expect(response.parsed_body["props"]["products_data"]["products"].map { _1["price_formatted"] }).to eq(["¥1,500", "€10.50"])
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

  describe "sorted by cut" do
    let(:other_collaborator) { create(:user, name: "Other collaborator") }

    def names_of(key)
      inertia_props_of(response)["products_data"]["products"].map { _1[key] }
    end

    def shared_product(collaborator, name, cut, **attributes)
      create(:product, :is_collab, user: seller, collaborator:, collaborator_cut: cut, name:, **attributes)
    end

    before do
      @first = create(:collaborator, seller:, affiliate_user: collaborator_user, affiliate_basis_points: 30_00)
      @second = create(:collaborator, seller:, affiliate_user: other_collaborator, affiliate_basis_points: 50_00)
      shared_product(@first, "Thirty", 30_00, created_at: Time.utc(2025, 1, 1))
      shared_product(@second, "Fifty", 50_00, created_at: Time.utc(2025, 1, 2))
      shared_product(@second, "Ten", 10_00, created_at: Time.utc(2025, 1, 3))
      Link.find_each { ProductCachedValue.create!(product: _1) }
    end

    it "sorts by the seller's cut ascending", parity: true do
      log_in(seller)

      get products_collabs_path, params: { products_sort_key: "cut", products_sort_direction: "asc" }

      expect(names_of("name")).to eq(%w[Fifty Thirty Ten])
      expect(names_of("cut")).to eq([50, 70, 90])
    end

    it "sorts by the seller's cut descending", parity: true do
      log_in(seller)

      get products_collabs_path, params: { products_sort_key: "cut", products_sort_direction: "desc" }

      expect(names_of("name")).to eq(%w[Ten Thirty Fifty])
    end

    it "sorts a collaborator's collabs by their own cut descending", parity: true do
      log_in(other_collaborator)

      get products_collabs_path, params: { products_sort_key: "cut", products_sort_direction: "desc" }

      expect(names_of("name")).to eq(%w[Fifty Ten])
      expect(names_of("cut")).to eq([50, 10])
    end

    it "sorts collab memberships by cut", parity: true do
      membership = { is_recurring_billing: true, subscription_duration: :monthly, is_tiered_membership: true, native_type: Link::NATIVE_TYPE_MEMBERSHIP }
      shared_product(@first, "Club low", 20_00, **membership, created_at: Time.utc(2025, 2, 1))
      shared_product(@first, "Club high", 40_00, **membership, created_at: Time.utc(2025, 2, 2))
      Link.find_each { ProductCachedValue.create!(product: _1) unless _1.product_cached_values.exists? }
      log_in(collaborator_user)

      get products_collabs_path, params: { memberships_sort_key: "cut", memberships_sort_direction: "asc" }

      expect(inertia_props_of(response)["memberships_data"]["memberships"].map { _1["name"] }).to eq(["Club low", "Club high"])
    end

    it "lists a collab once per affiliate it has when sorted by cut", parity: true do
      create(:direct_affiliate, seller:, affiliate_user: create(:user), products: [Link.find_by!(name: "Ten")])
      log_in(seller)

      get products_collabs_path, params: { products_sort_key: "cut", products_sort_direction: "desc" }

      expect(names_of("name")).to eq(%w[Ten Ten Thirty Fifty])
    end
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
