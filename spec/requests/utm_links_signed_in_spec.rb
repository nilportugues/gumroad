# frozen_string_literal: true

require "spec_helper"

# Signed-in visits to the UTM links pages, recorded for the Next.js port (PARITY_RECORD=1) and
# replayed by nextjs/parity/__tests__/utm-links.replay.test.ts, which sends the last request of each
# example.
describe "UTM links when signed in", type: :request do
  include Parity::AudienceSignedIn

  let(:seller) { create(:user, name: "UTM Seller") }
  let(:product) { create(:product, user: seller, name: "Tagged product") }

  before { host! DOMAIN }

  it "redirects a signed-out visitor to the login page", parity: true do
    get dashboard_utm_links_path

    expect(response).to redirect_to(login_path(next: "/dashboard/utm_links"))
  end

  it "lists the links of a seller with no links", parity: true do
    log_in(seller)

    get dashboard_utm_links_path

    expect(response).to be_successful
    expect(inertia_props_of(response)["utm_links"]).to eq([])
  end

  it "lists links to the profile, a product and a post with their clicks", parity: true do
    post = create(:audience_installment, seller:, name: "Launch post", shown_on_profile: true, published_at: Time.utc(2025, 1, 5))
    create(:utm_link, seller:, title: "Profile link", target_resource_type: :profile_page, unique_clicks: 12, created_at: Time.utc(2025, 1, 2, 3, 4, 5))
    create(:utm_link, seller:, title: "Subscribe link", target_resource_type: :subscribe_page, utm_term: "term & co", utm_content: "banner", unique_clicks: 3, created_at: Time.utc(2025, 1, 3))
    create(:utm_link, seller:, title: "Product link", target_resource_type: :product_page, target_resource_id: product.id, created_at: Time.utc(2025, 1, 4))
    create(:utm_link, seller:, title: "Post link", target_resource_type: :post_page, target_resource_id: post.id, created_at: Time.utc(2025, 1, 5))
    log_in(seller)

    get dashboard_utm_links_path

    expect(response).to be_successful
    expect(inertia_props_of(response)["utm_links"].size).to eq(4)
  end

  it "searches and sorts the links", parity: true do
    create(:utm_link, seller:, title: "Spring newsletter", utm_campaign: "spring", unique_clicks: 5)
    create(:utm_link, seller:, title: "Spring tweet", utm_campaign: "spring-tweet", unique_clicks: 50)
    create(:utm_link, seller:, title: "Autumn tweet", utm_campaign: "autumn", unique_clicks: 500)
    log_in(seller)

    get dashboard_utm_links_path, params: { query: " spring ", key: "clicks", direction: "desc" }

    expect(response).to be_successful
    expect(inertia_props_of(response)["utm_links"].map { _1["title"] }).to eq(["Spring tweet", "Spring newsletter"])
  end

  it "sorts by revenue with the sales of each link", parity: true do
    link = create(:utm_link, seller:, title: "Revenue link", target_resource_type: :product_page, target_resource_id: product.id, unique_clicks: 10)
    purchase = create(:free_purchase, link: product, seller:).tap { _1.update_columns(price_cents: 500) }
    create(:utm_link_driven_sale, utm_link: link, purchase:)
    create(:utm_link, seller:, title: "Quiet link", unique_clicks: 4)
    log_in(seller)

    get dashboard_utm_links_path, params: { key: "revenue_cents", direction: "desc" }

    expect(response).to be_successful
    expect(inertia_props_of(response)["utm_links"].first).to include("title" => "Revenue link", "sales_count" => 1)
  end

  it "paginates past the last page back to the last page", parity: true do
    3.times { |index| create(:utm_link, seller:, created_at: Time.utc(2025, 1, index + 1)) }
    log_in(seller)

    get dashboard_utm_links_path, params: { page: 9 }

    expect(response).to be_successful
    expect(inertia_props_of(response)["pagination"]).to eq("pages" => 1, "page" => 1)
  end

  it "answers a stats reload for the given links", parity: true do
    link = create(:utm_link, seller:, target_resource_type: :product_page, target_resource_id: product.id, unique_clicks: 8)
    create(:utm_link_driven_sale, utm_link: link, purchase: create(:free_purchase, link: product, seller:).tap { _1.update_columns(price_cents: 700) })
    log_in(seller)

    get dashboard_utm_links_path, params: { ids: [link.external_id, "unknown"] },
                                  headers: { "X-Inertia" => "true", "X-Inertia-Partial-Component" => "UtmLinks/Index", "X-Inertia-Partial-Data" => "utm_links_stats", "X-Requested-With" => "XMLHttpRequest" }

    expect(response).to be_successful
    expect(response.parsed_body["props"]["utm_links_stats"][link.external_id]).to include("sales_count" => 1, "revenue_cents" => 700)
  end

  it "renders the new link form with the destinations of the seller", parity: true do
    create(:audience_installment, seller:, name: "A post", shown_on_profile: true, published_at: Time.utc(2025, 1, 5))
    create(:utm_link, seller:, utm_campaign: "spring", utm_medium: "email", utm_source: "newsletter", utm_term: "t1", utm_content: "c1")
    product
    log_in(seller)

    get new_dashboard_utm_link_path

    expect(response).to be_successful
    expect(inertia_props_of(response)["context"]["destination_options"].size).to eq(4)
  end

  it "prefills the new link form from the link it copies", parity: true do
    link = create(:utm_link, seller:, title: "Original", target_resource_type: :product_page, target_resource_id: product.id)
    log_in(seller)

    get new_dashboard_utm_link_path, params: { copy_from: link.external_id }

    expect(response).to be_successful
    expect(inertia_props_of(response)["utm_link"]).to include("title" => "Original")
  end

  it "answers a partial reload for the new link's additional metadata", parity: true do
    log_in(seller)

    get new_dashboard_utm_link_path, headers: { "X-Inertia" => "true", "X-Inertia-Partial-Component" => "UtmLinks/New", "X-Inertia-Partial-Data" => "additional_metadata", "X-Requested-With" => "XMLHttpRequest" }

    expect(response).to be_successful
    expect(response.parsed_body["props"]["additional_metadata"]).to have_key("new_permalink")
  end

  it "renders the edit form", parity: true do
    link = create(:utm_link, seller:, title: "Editable", target_resource_type: :product_page, target_resource_id: product.id)
    log_in(seller)

    get edit_dashboard_utm_link_path(link.external_id)

    expect(response).to be_successful
    expect(inertia_props_of(response)["utm_link"]).to include("title" => "Editable")
  end

  it "answers 404 for the edit form of a link that belongs to someone else", parity: true do
    other = create(:utm_link)
    log_in(seller)

    get edit_dashboard_utm_link_path(other.external_id)

    expect(response).to have_http_status(:not_found)
  end

  it "sends a support team member away from the new link form", parity: true do
    member = create(:user, name: "Support Member")
    create(:team_membership, user: member, seller:, role: TeamMembership::ROLE_SUPPORT)
    log_in(member)
    switch_to(seller.reload.seller_memberships.first)

    get new_dashboard_utm_link_path

    expect(response).to redirect_to(dashboard_url)
    expect(flash[:alert]).to eq("Your current role as Support cannot perform this action.")
  end

  it "lets a support team member see the list", parity: true do
    member = create(:user, name: "Support Member")
    membership = create(:team_membership, user: member, seller:, role: TeamMembership::ROLE_SUPPORT)
    create(:utm_link, seller:, title: "Visible to support")
    log_in(member)
    switch_to(membership)

    get dashboard_utm_links_path

    expect(response).to be_successful
    expect(inertia_props_of(response)["utm_links"].map { _1["title"] }).to eq(["Visible to support"])
  end
end
