# frozen_string_literal: true

require "spec_helper"

# Signed-in visits to the bundle content tab (Bundles::ContentController#edit, Bundles/Content/Edit), recorded for the Next.js port
# (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/ws12o.replay.test.ts, which sends the last request of each example. Node
# renders the first load, whose `search_data` is deferred; an example named "hands a ..." is what Node leaves to Rails whole: the partial
# reload that fetches the Elasticsearch results, and a product that is only being converted to a bundle (the page flashes an alert).
describe "Bundle content tab when signed in", type: :request do
  include Parity::SignedInDashboard

  let(:seller) { create(:user, name: "Bundle Seller") }
  let(:bundle) do
    create(:product, :bundle, user: seller, name: "Starter bundle", price_cents: 200, native_type: Link::NATIVE_TYPE_BUNDLE).tap do |record|
      # The editor lists each bundled product's created_at; a fixed date keeps the fixture clear of the recording's slow clock.
      record.bundle_products.each { _1.product.update_column(:created_at, Time.utc(2026, 1, 2, 3, 4, 5)) }
    end
  end

  # The first visit inserts the seller's holdout row; the port only reads it.
  before { Marketing::HoldoutAssignment.for_seller!(seller) }

  def team_member(role)
    member = create(:user, name: "#{role.capitalize} Member")
    membership = create(:team_membership, user: member, seller:, role:)
    log_in(member)
    switch_to(membership)
  end

  context "when signed in as the seller" do
    before { log_in(seller) }

    it "renders the first load with the search results deferred", parity: true do
      get edit_bundle_content_path(bundle.external_id)

      expect(response).to be_successful
      page = inertia_page_of(response)
      expect(page["component"]).to eq("Bundles/Content/Edit")
      expect(page["props"]).to include("products_count" => 2, "has_outdated_purchases" => false, "is_bundle" => true)
      expect(page["props"]).not_to have_key("search_data")
      expect(page["deferredProps"]).to eq("default" => ["search_data"])
      expect(page["mergeProps"]).to eq(["search_data"])
    end

    it "serves the Inertia JSON for a visit", parity: true do
      inertia_visit edit_bundle_content_path(bundle.external_id)

      expect(response).to be_successful
      expect(JSON.parse(response.body)).to include("component" => "Bundles/Content/Edit", "deferredProps" => { "default" => ["search_data"] })
    end

    it "counts the products that can join the bundle", parity: true do
      create(:product, user: seller, name: "Plain extra")
      create(:product, user: seller, name: "Archived extra", archived: true)
      create(:product, user: seller, name: "Deleted extra", deleted_at: Time.utc(2025, 2, 1))
      create(:product, user: seller, name: "Unpublished extra", purchase_disabled_at: Time.utc(2025, 2, 1))
      create(:membership_product, user: seller, name: "Membership extra")
      create(:product, user: create(:user, name: "Other Seller"), name: "Someone else's")

      get edit_bundle_content_path(bundle.external_id)

      expect(inertia_props_of(response)["products_count"]).to eq(3)
    end

    it "flags a bundle with purchases that carry outdated content", parity: true do
      bundle.update!(has_outdated_purchases: true)

      get edit_bundle_content_path(bundle.external_id)

      expect(inertia_props_of(response)["has_outdated_purchases"]).to eq(true)
    end

    it "answers 404 for an unknown bundle", parity: true do
      get edit_bundle_content_path("unknown")

      expect(response).to have_http_status(:not_found)
    end

    it "answers 404 for a membership, which cannot be a bundle", parity: true do
      membership = create(:membership_product, user: seller, name: "Membership")

      get edit_bundle_content_path(membership.external_id)

      expect(response).to have_http_status(:not_found)
    end

    it "hands a partial reload of the search results to Rails", parity: true do
      get edit_bundle_content_path(bundle.external_id), headers: {
        "X-Inertia" => "true", "X-Requested-With" => "XMLHttpRequest",
        "X-Inertia-Partial-Component" => "Bundles/Content/Edit", "X-Inertia-Partial-Data" => "search_data"
      }

      expect(response).to be_successful
      expect(JSON.parse(response.body)["props"]).to have_key("search_data")
    end

    it "hands a product that is being converted to a bundle to Rails", parity: true do
      product = create(:product, user: seller, name: "Soon a bundle")

      get edit_bundle_content_path(product.external_id)

      expect(response).to be_successful
      expect(flash[:alert]).to eq("Select products and save your changes to finish converting this product to a bundle.")
    end
  end

  context "when signed in as someone else" do
    it "sends a signed-out visitor to the login page", parity: true do
      get edit_bundle_content_path(bundle.external_id)

      expect(response).to have_http_status(:found)
      expect(response.location).to start_with("#{PROTOCOL}://#{DOMAIN}/login")
    end

    it "sends a seller who does not own the bundle to its product page", parity: true do
      log_in(create(:user, name: "Stranger"))

      get edit_bundle_content_path(bundle.external_id)

      expect(response).to have_http_status(:found)
      expect(response.location).to end_with("/l/#{bundle.unique_permalink}")
    end

    it "renders the page for a marketing team member", parity: true do
      team_member(TeamMembership::ROLE_MARKETING)

      get edit_bundle_content_path(bundle.external_id)

      expect(response).to be_successful
    end

    it "sends a support team member to the product page", parity: true do
      team_member(TeamMembership::ROLE_SUPPORT)

      get edit_bundle_content_path(bundle.external_id)

      expect(response).to have_http_status(:found)
      expect(response.location).to end_with("/l/#{bundle.unique_permalink}")
    end
  end
end
