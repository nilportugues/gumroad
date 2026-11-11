# frozen_string_literal: true

require "spec_helper"

# GET /wishlists/:slug on the owner's host (WishlistsController#show, WishlistPresenter#public_props, PageMeta::Wishlist), recorded
# for the Next.js port (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/wishlist-show.replay.test.ts. An example named
# "hands a ..." is one Node leaves to Rails whole.
describe "Wishlist show page", type: :request do
  include Parity::AudienceSignedIn

  let(:owner) { create(:user, name: "Wishlist Owner", username: "wishowner") }
  let(:wishlist) { create(:wishlist, user: owner, name: "Reading list", description: "Books worth the shelf space") }

  def add_products(count, seller: create(:user, name: "Shelf Seller"))
    count.times { |index| create(:wishlist_product, wishlist:, product: create(:product, user: seller, name: "Book #{index}", price_cents: 500 + index * 100)) }
  end

  def visit_wishlist(list = wishlist, params: {}, headers: {})
    host! owner.subdomain
    get "/wishlists/#{list.url_slug}", params:, headers:
  end

  def props
    page = response.body[/<script[^>]*data-page="[^"]*"[^>]*>(.*?)<\/script>/m, 1] || CGI.unescapeHTML(response.body[/\sdata-page="([^"]*)"/, 1])
    JSON.parse(page)["props"]
  end

  before { host! DOMAIN }

  it "renders a wishlist the search engines may index, with its structured data", parity: true do
    add_products(3)

    visit_wishlist

    expect(response).to be_successful
    expect(props).to include("name" => "Reading list", "description" => "Books worth the shelf space", "following" => false, "can_follow" => true, "can_edit" => false, "checkout_enabled" => true)
    expect(props["items"].size).to eq(3)
    expect(props["_inertia_meta"].map { _1["headKey"] }).to include("structured-data", "canonical")
  end

  it "keeps a thin wishlist out of the index", parity: true do
    add_products(1)

    visit_wishlist

    expect(props["_inertia_meta"].find { _1["name"] == "robots" }["content"]).to eq("noindex")
  end

  it "describes a wishlist without a description by its product count", parity: true do
    wishlist.update!(description: nil)
    add_products(2)

    visit_wishlist

    expect(props["_inertia_meta"].find { _1["name"] == "description" }["content"]).to eq("Reading list — a wishlist of 2 digital products curated by Wishlist Owner on Gumroad.")
  end

  it "renders an empty wishlist", parity: true do
    visit_wishlist

    expect(response).to be_successful
    expect(props).to include("items" => [], "checkout_enabled" => false)
  end

  it "lists the first twenty of twenty-one products and the pagination", parity: true do
    # Frozen, so the 21 rows share one created_at, as the replay's clock does for them.
    freeze_time do
      add_products(21)

      visit_wishlist
    end

    expect(props["items"].size).to eq(20)
    expect(props["pagination"]).to include("count" => 21, "pages" => 2, "next" => 2)
  end

  it "passes the recommender through to the product links", parity: true do
    add_products(1)

    visit_wishlist(params: { recommended_by: "search" })

    expect(props["items"].first["product"]["url"]).to include("recommended_by=search")
  end

  it "answers an Inertia visit with the page as JSON", parity: true do
    add_products(2)

    visit_wishlist(headers: { "X-Inertia" => "true", "X-Requested-With" => "XMLHttpRequest" })

    expect(response.parsed_body["component"]).to eq("Wishlists/Show")
  end

  it "does not offer checkout when every product is unpublished", parity: true do
    wishlist_product = create(:wishlist_product, wishlist:, product: create(:product, name: "Draft"))
    wishlist_product.product.update_columns(purchase_disabled_at: Time.current)

    visit_wishlist

    expect(props["checkout_enabled"]).to eq(false)
    expect(props["items"].first["purchasable"]).to eq(false)
  end

  it "shares the presentment currency of the visitor's country", parity: true do
    # The GeoLite2 test database the Node port's GeoIP tests read.
    stub_const("GEOIP", MaxMind::GeoIP2::Reader.new(database: Rails.root.join("nextjs/src/server/infra/__fixtures__/GeoLite2-City-Test.mmdb").to_s))
    allow(GeoIp).to receive(:lookup).and_call_original
    add_products(1)

    visit_wishlist(headers: { "X-Forwarded-For" => "81.2.69.142" })

    expect(props["detected_buyer_currency"]).to eq("gbp")
  end

  it "answers 404 for a wishlist of another seller", parity: true do
    other = create(:wishlist, user: create(:user), name: "Elsewhere")

    visit_wishlist(other)

    expect(response).to have_http_status(:not_found)
  end

  it "answers 404 for a removed wishlist", parity: true do
    wishlist.update!(deleted_at: 1.day.ago)

    visit_wishlist

    expect(response).to have_http_status(:not_found)
  end

  it "answers 404 for a slug that names no wishlist", parity: true do
    host! owner.subdomain
    get "/wishlists/reading-list-1"

    expect(response).to have_http_status(:not_found)
  end

  it "renders the wishlist for a signed-in visitor who follows it", parity: true do
    add_products(1)
    visitor = create(:user, name: "Following Visitor")
    create(:wishlist_follower, wishlist:, follower_user: visitor)
    log_in(visitor)

    visit_wishlist

    expect(props).to include("following" => true, "can_follow" => true, "can_edit" => false, "discover_opted_out" => nil)
    expect(props["user"]).to include("name" => "Wishlist Owner")
  end

  it "renders the wishlist for a signed-in visitor who does not follow it", parity: true do
    add_products(1)
    log_in(create(:user))

    visit_wishlist

    expect(props).to include("following" => false, "can_follow" => true, "can_edit" => false)
    expect(props["items"].first).to include("giftable" => true)
  end

  it "renders the owner's own wishlist as editable", parity: true do
    add_products(2)
    log_in(owner)

    visit_wishlist

    expect(props).to include("user" => nil, "can_follow" => false, "can_edit" => true, "discover_opted_out" => false)
    expect(props["items"].first).to include("giftable" => false)
  end

  it "reports a wishlist opted out of discover to its owner", parity: true do
    wishlist.update!(discover_opted_out: true)
    log_in(owner)

    visit_wishlist

    expect(props).to include("can_edit" => true, "discover_opted_out" => true)
  end

  it "renders a wishlist the owner's team member visits as that seller", parity: true do
    add_products(1)
    member = create(:user)
    membership = create(:team_membership, seller: create(:user), user: member, role: TeamMembership::ROLE_ADMIN)
    log_in(member)
    switch_to(membership)

    visit_wishlist

    expect(props).to include("following" => false, "can_follow" => true, "can_edit" => false)
  end

  it "adds the creator profile to a profile-layout wishlist", parity: true do
    add_products(1)

    visit_wishlist(params: { layout: "profile" })

    expect(response).to be_successful
    expect(props["layout"]).to eq("profile")
    expect(props["creator_profile"]).to include("name" => "Wishlist Owner", "can_edit" => false, "subdomain" => owner.subdomain)
  end

  it "lets the owner edit the profile around a profile-layout wishlist", parity: true do
    log_in(owner)

    visit_wishlist(params: { layout: "profile" })

    expect(props["creator_profile"]).to include("can_edit" => true)
  end

  it "adds the taxonomies to a discover-layout wishlist", parity: true do
    add_products(1)
    design = Taxonomy.create!(slug: "design")
    Taxonomy.create!(slug: "icons", parent: design)
    Taxonomy.create!(slug: "other")

    visit_wishlist(params: { layout: "discover" })

    expect(props["layout"]).to eq("discover")
    expect(props["taxonomies_for_nav"].map { _1["slug"] }).to include("design", "icons", "other")
    expect(props["taxonomies_for_nav"]).to be_an(Array).and(be_present)
    expect(props).not_to have_key("creator_profile")
  end

  it "passes an unknown layout through without navigation", parity: true do
    visit_wishlist(params: { layout: "elsewhere" })

    expect(props["layout"]).to eq("elsewhere")
    expect(props.keys).not_to include("creator_profile", "taxonomies_for_nav")
  end

  it "adds nothing for a blank layout", parity: true do
    visit_wishlist(params: { layout: "" })

    expect(props).not_to have_key("layout")
  end

  it "keeps a blank recommender in the product links", parity: true do
    add_products(1)

    visit_wishlist(params: { recommended_by: "" })

    expect(props["items"].first["product"]["url"]).to be_present
  end

  it "hands a discover-layout wishlist of a buyer with a cart to Rails", parity: true do
    add_products(1)
    visitor = create(:user)
    cart = create(:cart, user: visitor)
    create(:cart_product, cart:, product: create(:product))
    log_in(visitor)

    visit_wishlist(params: { layout: "discover" })

    expect(props["layout"]).to eq("discover")
  end
end
