# frozen_string_literal: true

require "spec_helper"

# The products sections of a seller's public profile (UsersController#show -> ProfileSectionsPresenter), recorded for
# the Next.js port (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/storefront-profile-products.replay.test.ts.
# Examples whose name says "hands back" are the ones the port leaves to Rails; the replay checks that they reach it.
describe "Storefront profile products", type: :request, elasticsearch_wait_for_refresh: true do
  let(:seller) { create(:named_seller, name: "Parity Seller", bio: "Makes things.") }

  before do
    host! seller.subdomain
    Link.__elasticsearch__.create_index!(force: true)
  end

  def inertia_props
    page = response.body[/<script[^>]*data-page="[^"]*"[^>]*>(.*?)<\/script>/m, 1] || CGI.unescapeHTML(response.body[/\sdata-page="([^"]*)"/, 1])
    JSON.parse(page)["props"]
  end

  def product(name, **attributes)
    create(:product, user: seller, name:, description: "About #{name}", **attributes)
  end

  def sell(item, count = 1)
    count.times { create(:purchase, link: item, seller:) }
  end

  def show_products_section(shown, **attributes)
    section = create(:seller_profile_products_section, seller:, header: "Shop", shown_products: shown.map(&:id), **attributes)
    seller.seller_profile.json_data[:tabs] = [{ name: "Home", sections: [section.id] }]
    seller.seller_profile.save!
    section
  end

  def get_profile(params = {})
    index_model_records(Link)
    get "/", params:
  end

  it "lists a products section's products in the order the seller arranged them", parity: true do
    first = product("Alpha ebook", price_cents: 500)
    second = product("Beta course", price_cents: 1_500)
    third = product("Gamma pack", price_cents: 2_500)
    show_products_section([third, first, second], show_filters: true)

    get_profile

    expect(response).to be_successful
    expect(inertia_props["sections"].first["search_results"]["products"].map { _1["name"] }).to eq(["Gamma pack", "Alpha ebook", "Beta course"])
  end

  it "leaves out the products a section does not show, and archived or deleted ones", parity: true do
    shown = product("Shown")
    product("Not in the section")
    archived = product("Archived")
    archived.update!(archived: true)
    show_products_section([shown, archived])

    get_profile

    expect(response).to be_successful
    expect(inertia_props["sections"].first["search_results"]["products"].map { _1["name"] }).to eq(["Shown"])
  end

  it "sorts a section by its default sort", parity: true do
    cheap = product("Cheap", price_cents: 100)
    dear = product("Dear", price_cents: 9_900)
    middle = product("Middle", price_cents: 900)
    show_products_section([cheap, dear, middle], default_product_sort: "price_desc")

    get_profile

    expect(response).to be_successful
    expect(inertia_props["sections"].first["search_results"]["products"].map { _1["name"] }).to eq(%w[Dear Middle Cheap])
  end

  it "shows products from two sections and the section headers", parity: true do
    one = product("One")
    two = product("Two")
    a = show_products_section([one])
    b = create(:seller_profile_products_section, seller:, header: "More", shown_products: [two.id], default_product_sort: "newest")
    seller.seller_profile.json_data[:tabs] = [{ name: "Home", sections: [a.id, b.id] }]
    seller.seller_profile.save!

    get_profile

    expect(response).to be_successful
    expect(inertia_props["sections"].map { _1["header"] }).to eq(%w[Shop More])
  end

  it "renders the card of each kind of product", parity: true do
    pwyw = product("Pay what you want", price_cents: 300, customizable_price: true)
    limited = product("Limited", price_cents: 700, max_purchase_count: 10)
    sell(limited, 3)
    reviewed = product("Reviewed", display_product_reviews: true)
    euro = product("Euro", price_currency_type: "eur", price_cents: 1_000)
    versions = product("With versions", price_cents: 1_200)
    category = create(:variant_category, link: versions, title: "Edition")
    create(:variant, variant_category: category, name: "Basic", price_difference_cents: 0)
    create(:variant, variant_category: category, name: "Deluxe", price_difference_cents: 500)
    show_products_section([pwyw, limited, reviewed, euro, versions])

    get_profile

    expect(response).to be_successful
    expect(inertia_props["sections"].first["search_results"]["products"].size).to eq(5)
  end

  it "leaves out a sold-out product that hides its sold-out state, and shrinks the total", parity: true do
    open = product("Open", max_purchase_count: 5)
    sold_out = product("Sold out", max_purchase_count: 1, hide_sold_out_variants: true)
    sell(sold_out)
    show_products_section([open, sold_out])

    get_profile

    expect(response).to be_successful
    results = inertia_props["sections"].first["search_results"]
    expect(results["products"].map { _1["name"] }).to eq(["Open"])
    expect(results["total"]).to eq(1)
  end

  it "shows a default products section to a seller who has products and no sections", parity: true do
    product("Alpha ebook", price_cents: 500)
    product("Beta course", price_cents: 1_500)
    product("Archived").update!(archived: true)

    get_profile

    expect(response).to be_successful
    props = inertia_props
    expect(props["sections"].map { _1["id"] }).to eq(["default-products"])
    expect(props["tabs"]).to eq([{ "name" => "Products", "sections" => ["default-products"] }])
  end

  it "shows no default section when every product is archived", parity: true do
    product("Archived").update!(archived: true)

    get_profile

    expect(response).to be_successful
    expect(inertia_props["sections"]).to eq([])
  end

  it "answers an Inertia visit with the products as JSON", parity: true do
    show_products_section([product("Alpha ebook")])
    index_model_records(Link)

    get "/", headers: { "X-Inertia" => "true", "X-Requested-With" => "XMLHttpRequest" }

    expect(response).to be_successful
    expect(response.parsed_body["props"]["sections"].first["search_results"]["products"].size).to eq(1)
  end

  it "shows a featured product section to a visitor", parity: true do
    featured = product("Featured")
    create(:seller_profile_featured_product_section, seller:, featured_product_id: featured.id)

    get_profile

    expect(response).to be_successful
  end

  it "shows a wishlists section to a visitor", parity: true do
    wishlist = create(:wishlist, user: seller)
    create(:seller_profile_wishlists_section, seller:, shown_wishlists: [wishlist.id])

    get_profile

    expect(response).to be_successful
  end

  it "shows no product for a featured product section whose product was deleted", parity: true do
    featured = product("Featured")
    create(:seller_profile_featured_product_section, seller:, featured_product_id: featured.id)
    featured.mark_deleted!

    get_profile

    expect(response).to be_successful
    expect(inertia_props["sections"].first["props"]).to be_nil
  end

  it "shows the wishlists of a section in the seller's order with the last thumbnails", parity: true do
    first = create(:wishlist, user: seller, name: "First")
    second = create(:wishlist, user: seller, name: "Second")
    5.times { |n| create(:wishlist_product, wishlist: first, product: product("Item #{n}")) }
    create(:wishlist_product, wishlist: second, product: product("Only item"))
    deleted = create(:wishlist, user: seller, name: "Gone")
    deleted.mark_deleted!
    create(:seller_profile_wishlists_section, seller:, shown_wishlists: [second.id, deleted.id, first.id])

    get_profile

    expect(response).to be_successful
    wishlists = inertia_props["sections"].first["wishlists"]
    expect(wishlists.map { _1["name"] }).to eq(%w[Second First])
    expect(wishlists.map { _1["thumbnails"].size }).to eq([1, 4])
  end

  it "hands back a profile whose products include a membership with tiers", parity: true do
    membership = create(:membership_product_with_preset_tiered_pricing, user: seller, name: "Membership")
    show_products_section([membership])

    get_profile

    expect(response).to be_successful
  end

  it "hands back a profile whose seller has an auto-applied offer code", parity: true do
    shown = product("Discounted", price_cents: 1_000)
    create(:universal_offer_code, user: seller, auto_apply: true, amount_percentage: 10, amount_cents: nil)
    show_products_section([shown])

    get_profile

    expect(response).to be_successful
  end

  it "hands back a visit that carries the visitor's search filters", parity: true do
    show_products_section([product("Alpha ebook")])

    get_profile(query: "alpha", sort: "price_asc")

    expect(response).to be_successful
  end
end
