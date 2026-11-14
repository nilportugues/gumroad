# frozen_string_literal: true

require "spec_helper"

# Creating, updating and deleting UTM links from the dashboard, and following the short link, recorded for the Next.js port
# (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/ws11b.replay.test.ts.
describe "UTM links mutations", type: :request do
  include Parity::AudienceSignedIn

  let(:seller) { create(:user, name: "UTM Writer") }
  let(:product) { create(:product, user: seller, name: "Tagged product") }
  let(:inertia_headers) do
    { "X-Inertia" => "true", "X-Requested-With" => "XMLHttpRequest", "Accept" => "text/html, application/xhtml+xml", "Content-Type" => "application/json" }
  end
  let(:valid_attributes) { { title: "Spring push", target_resource_type: "profile_page", utm_source: "newsletter", utm_medium: "email", utm_campaign: "spring", permalink: "ab12cd34" } }

  before { host! DOMAIN }

  def send_form(method, path, body)
    public_send(method, path, params: body.to_json, headers: inertia_headers.merge("X-CSRF-Token" => csrf_token))
  end

  it "creates a link to the profile", parity: true do
    log_in(seller)

    send_form(:post, dashboard_utm_links_path, { utm_link: valid_attributes })

    expect(response).to have_http_status(:see_other)
    expect(UtmLink.last).to have_attributes(title: "Spring push", seller_id: seller.id)
  end

  it "generates a permalink when none is given", parity: true do
    log_in(seller)

    send_form(:post, dashboard_utm_links_path, { utm_link: valid_attributes.except(:permalink) })

    expect(response).to have_http_status(:see_other)
    expect(UtmLink.last.permalink).to match(/\A[a-z0-9]{8}\z/)
  end

  it "creates a link to a product with the optional parameters", parity: true do
    log_in(seller)

    send_form(:post, dashboard_utm_links_path, { utm_link: valid_attributes.merge(target_resource_type: "product_page", target_resource_id: product.external_id, utm_term: "term", utm_content: "banner") })

    expect(response).to have_http_status(:see_other)
    expect(UtmLink.last.target_resource_id).to eq(product.id)
  end

  it "creates a link to a post", parity: true do
    post = create(:audience_installment, seller:, name: "Launch post", shown_on_profile: true, published_at: Time.utc(2025, 1, 5))
    log_in(seller)

    send_form(:post, dashboard_utm_links_path, { utm_link: valid_attributes.merge(target_resource_type: "post_page", target_resource_id: post.external_id) })

    expect(response).to have_http_status(:see_other)
    expect(UtmLink.last.target_resource_id).to eq(post.id)
  end

  it "does not point a link at another seller's product", parity: true do
    foreign = create(:product, name: "Foreign")
    log_in(seller)

    send_form(:post, dashboard_utm_links_path, { utm_link: valid_attributes.merge(target_resource_type: "product_page", target_resource_id: foreign.external_id) })

    expect(response).to have_http_status(:found)
    expect(UtmLink.count).to eq(0)
  end

  it "redirects with the first validation error when the title is blank", parity: true do
    log_in(seller)

    send_form(:post, dashboard_utm_links_path, { utm_link: valid_attributes.merge(title: "") })

    expect(response).to have_http_status(:found)
    expect(UtmLink.count).to eq(0)
  end

  it "redirects back to the copied link's form when the source is blank", parity: true do
    log_in(seller)

    send_form(:post, "#{dashboard_utm_links_path}?copy_from=abc", { utm_link: valid_attributes.merge(utm_source: "") })

    expect(response).to have_http_status(:found)
  end

  it "rejects an unknown target type", parity: true do
    log_in(seller)

    send_form(:post, dashboard_utm_links_path, { utm_link: valid_attributes.merge(target_resource_type: "nowhere") })

    expect(response).to have_http_status(:found)
  end

  it "rejects a duplicate of an alive link", parity: true do
    create(:utm_link, seller:, title: "Existing", target_resource_type: :profile_page, utm_source: "newsletter", utm_medium: "email", utm_campaign: "spring")
    log_in(seller)

    send_form(:post, dashboard_utm_links_path, { utm_link: valid_attributes })

    expect(response).to have_http_status(:found)
    expect(UtmLink.count).to eq(1)
  end

  it "ignores unpermitted attributes", parity: true do
    log_in(seller)

    send_form(:post, dashboard_utm_links_path, { utm_link: valid_attributes.merge(seller_id: 1, total_clicks: 99, permalink: "abcd1234") })

    expect(response).to have_http_status(:see_other)
    expect(UtmLink.last).to have_attributes(total_clicks: 0, seller_id: seller.id, permalink: "abcd1234")
  end

  it "hands a request without a utm_link parameter to Rails", parity: true do
    log_in(seller)

    send_form(:post, dashboard_utm_links_path, { other: 1 })

    expect(response).to have_http_status(:bad_request)
  end

  it "updates the title and UTM parameters", parity: true do
    link = create(:utm_link, seller:, title: "Old title")
    log_in(seller)

    send_form(:patch, dashboard_utm_link_path(link.external_id), { utm_link: { title: "New title", utm_source: "twitter", target_resource_type: "subscribe_page" } })

    expect(response).to have_http_status(:see_other)
    expect(link.reload).to have_attributes(title: "New title", utm_source: "twitter")
  end

  it "answers a validation error of an update", parity: true do
    link = create(:utm_link, seller:, title: "Old title")
    log_in(seller)

    send_form(:put, dashboard_utm_link_path(link.external_id), { utm_link: { title: "" } })

    expect(response).to have_http_status(:see_other)
    expect(link.reload.title).to eq("Old title")
  end

  it "does not update a deleted link", parity: true do
    link = create(:utm_link, seller:, title: "Gone", deleted_at: Time.current)
    log_in(seller)

    send_form(:patch, dashboard_utm_link_path(link.external_id), { utm_link: { title: "Revived" } })

    expect(response).to have_http_status(:see_other)
    expect(link.reload.title).to eq("Gone")
  end

  it "answers 404 for a link of another seller", parity: true do
    link = create(:utm_link, title: "Foreign")
    log_in(seller)

    send_form(:patch, dashboard_utm_link_path(link.external_id), { utm_link: { title: "Mine" } })

    expect(response).to have_http_status(:not_found)
  end

  it "deletes a link and keeps the list's query", parity: true do
    link = create(:utm_link, seller:, title: "Doomed")
    log_in(seller)

    send_form(:delete, "#{dashboard_utm_link_path(link.external_id)}?query=spring&key=clicks&direction=desc&ids=abc", {})

    expect(response).to have_http_status(:see_other)
    expect(link.reload.deleted_at).to be_present
  end

  it "forbids a seller's support role from creating a link", parity: true do
    support = create(:user)
    create(:team_membership, user: support, seller:, role: TeamMembership::ROLE_SUPPORT)
    log_in(support)
    switch_to(support.user_memberships.find_by(seller:))

    send_form(:post, dashboard_utm_links_path, { utm_link: valid_attributes })

    expect(response).to have_http_status(:found)
    expect(UtmLink.count).to eq(0)
  end

  describe "short link" do
    it "redirects to the profile with the UTM parameters", parity: true do
      link = create(:utm_link, seller:, target_resource_type: :profile_page, utm_source: "newsletter", utm_medium: "email", utm_campaign: "spring", utm_term: "term", permalink: "ab12cd34")

      get "/u/#{link.permalink}"

      expect(response).to have_http_status(:found)
      expect(response.location).to include("utm_source=newsletter")
    end

    it "redirects to a product page", parity: true do
      create(:utm_link, seller:, target_resource_type: :product_page, target_resource_id: product.id, permalink: "pr12od34")

      get "/u/pr12od34"

      expect(response).to have_http_status(:found)
    end

    it "redirects to the subscribe page", parity: true do
      create(:utm_link, seller:, target_resource_type: :subscribe_page, utm_content: "banner", permalink: "su12bs34")

      get "/u/su12bs34"

      expect(response).to have_http_status(:found)
    end

    it "answers 404 for a disabled link", parity: true do
      create(:utm_link, seller:, disabled_at: Time.current, permalink: "di12ab34")

      get "/u/di12ab34"

      expect(response).to have_http_status(:not_found)
    end

    it "answers 404 for an unknown link", parity: true do
      get "/u/unknown0"

      expect(response).to have_http_status(:not_found)
    end

    it "says the destination is gone when the product was deleted for good", parity: true do
      link = create(:utm_link, seller:, target_resource_type: :product_page, target_resource_id: product.id, permalink: "go12ne34")
      product.delete

      get "/u/#{link.permalink}"

      expect(response).to have_http_status(:not_found)
      expect(response.body).to include("no longer available")
    end
  end
end
