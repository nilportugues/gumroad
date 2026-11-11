# frozen_string_literal: true

require "spec_helper"

# The guards and refusals of the Bundles::{Product,Content,Share}Controller writes that Node answers in front of the save, recorded for
# the Next.js port (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/ws12n.replay.test.ts, which sends the last request of each
# example. An example named "hands a ..." records what Node passes to Rails whole: the action saves, reindexes or enqueues a job.
describe "Bundle writes guards", type: :request do
  include Parity::AudienceSignedIn

  let(:seller) { create(:named_seller, name: "Bundle Seller") }
  let(:bundle) { create(:product, :bundle, user: seller, name: "Guarded bundle") }
  let(:json_headers) { { "Accept" => "application/json", "Content-Type" => "application/json" } }

  before { host! DOMAIN }

  def as_team_member(role)
    member = create(:user, name: "#{role.capitalize} Member")
    membership = create(:team_membership, user: member, seller:, role:)
    log_in(member)
    switch_to(membership)
  end

  def send_inertia(method, path, body = {})
    public_send(
      method, path,
      params: body.to_json,
      headers: { "X-Inertia" => "true", "X-Requested-With" => "XMLHttpRequest", "Accept" => "text/html, application/xhtml+xml", "Content-Type" => "application/json", "X-CSRF-Token" => csrf_token }
    )
  end

  def send_form(method, path, body = {})
    public_send(method, path, params: body.merge(authenticity_token: csrf_token), headers: { "X-Inertia" => "true", "Accept" => "text/html, application/xhtml+xml" })
  end

  def remove_file(id, bundle_id = bundle.external_id)
    post "/bundles/#{bundle_id}/product/remove_file", params: { file_id: id }.to_json, headers: json_headers.merge("X-CSRF-Token" => csrf_token)
  end

  describe "PATCH /bundles/:bundle_id/share" do
    it "sends a signed-out visitor to sign in", parity: true do
      send_inertia(:patch, "/bundles/#{bundle.external_id}/share")

      expect(response).to have_http_status(:see_other)
      expect(response.location).to start_with("#{PROTOCOL}://#{DOMAIN}/login")
    end

    it "sends a support team member away with the role in the flash", parity: true do
      as_team_member(TeamMembership::ROLE_SUPPORT)

      send_inertia(:patch, "/bundles/#{bundle.external_id}/share")

      expect(response).to redirect_to(dashboard_url)
      expect(flash[:alert]).to eq("Your current role as Support cannot perform this action.")
    end

    it "answers not found for an id nobody owns", parity: true do
      log_in(seller)

      send_inertia(:patch, "/bundles/unknownbundle/share")

      expect(response).to have_http_status(:not_found)
    end

    it "answers not found for a membership product, which cannot be a bundle", parity: true do
      membership = create(:membership_product, user: seller)
      log_in(seller)

      send_inertia(:patch, "/bundles/#{membership.external_id}/share")

      expect(response).to have_http_status(:not_found)
    end

    it "sends a seller away from the bundle of another seller", parity: true do
      other = create(:product, :bundle, user: create(:user, name: "Other Seller"), name: "Other bundle")
      log_in(seller)

      send_inertia(:patch, "/bundles/#{other.external_id}/share")

      expect(response).to redirect_to(dashboard_url)
      expect(flash[:alert]).to eq("You are not allowed to perform this action.")
    end

    it "sends an unpublished bundle to the content editor", parity: true do
      bundle.update_columns(draft: true)
      log_in(seller)

      send_inertia(:patch, "/bundles/#{bundle.external_id}/share", display_product_reviews: true)

      expect(response).to redirect_to(edit_bundle_content_path(bundle.external_id))
      expect(flash[:alert]).to start_with("Not yet!")
    end

    it "hands a published bundle's save to Rails", parity: true do
      log_in(seller)

      send_inertia(:patch, "/bundles/#{bundle.external_id}/share", display_product_reviews: true, tags: ["guarded"])

      expect(response).to have_http_status(:see_other)
      expect(flash[:notice]).to eq("Changes saved!")
    end
  end

  describe "PATCH /bundles/:bundle_id/product" do
    it "sends a support team member away with the role in the flash", parity: true do
      as_team_member(TeamMembership::ROLE_SUPPORT)

      send_inertia(:patch, "/bundles/#{bundle.external_id}/product", name: "Renamed")

      expect(response).to redirect_to(dashboard_url)
    end

    it "answers not found for an id nobody owns", parity: true do
      log_in(seller)

      send_inertia(:patch, "/bundles/unknownbundle/product", name: "Renamed")

      expect(response).to have_http_status(:not_found)
    end

    it "hands a save of a bundle to Rails", parity: true do
      log_in(seller)

      send_inertia(:patch, "/bundles/#{bundle.external_id}/product", name: "Renamed")

      expect(response).to have_http_status(:see_other)
      expect(bundle.reload.name).to eq("Renamed")
    end
  end

  describe "PATCH /bundles/:bundle_id/content" do
    it "sends a signed-out visitor to sign in", parity: true do
      send_inertia(:patch, "/bundles/#{bundle.external_id}/content", products: [])

      expect(response).to have_http_status(:see_other)
      expect(response.location).to start_with("#{PROTOCOL}://#{DOMAIN}/login")
    end

    it "refuses products sent as an index-keyed form hash", parity: true do
      member = bundle.bundle_products.first.product
      log_in(seller)

      send_form(:patch, "/bundles/#{bundle.external_id}/content", products: { "0" => { product_id: member.external_id, quantity: "1" } })

      expect(response).to redirect_to(edit_bundle_content_path(bundle.external_id))
      expect(flash[:alert]).to eq("Products must be an array.")
    end

    it "hands a list of products to Rails", parity: true do
      member = bundle.bundle_products.first.product
      log_in(seller)

      send_inertia(:patch, "/bundles/#{bundle.external_id}/content", products: [{ product_id: member.external_id, quantity: 1, position: 0 }])

      expect(response).to have_http_status(:see_other)
    end

    it "hands a request without products to Rails", parity: true do
      log_in(seller)

      send_inertia(:patch, "/bundles/#{bundle.external_id}/content")

      expect(response).to have_http_status(:see_other)
    end
  end

  describe "POST /bundles/:bundle_id/content/update_purchases_content" do
    it "sends a support team member away with the role in the flash", parity: true do
      as_team_member(TeamMembership::ROLE_SUPPORT)

      send_inertia(:post, "/bundles/#{bundle.external_id}/content/update_purchases_content")

      expect(response).to redirect_to(dashboard_url)
    end

    it "refuses a bundle with no outdated purchases", parity: true do
      log_in(seller)

      send_inertia(:post, "/bundles/#{bundle.external_id}/content/update_purchases_content")

      expect(response).to redirect_to(edit_bundle_content_path(bundle.external_id))
      expect(flash[:alert]).to eq("This bundle has no purchases with outdated content.")
    end

    it "hands a bundle with outdated purchases to Rails", parity: true do
      bundle.update_attribute(:has_outdated_purchases, true)
      log_in(seller)

      send_inertia(:post, "/bundles/#{bundle.external_id}/content/update_purchases_content")

      expect(response).to have_http_status(:see_other)
      expect(flash[:notice]).to start_with("Queued an update")
    end
  end

  describe "POST /bundles/:bundle_id/product/remove_file" do
    let!(:file) { create(:product_file, link: bundle) }

    it "hands a signed-out request to Rails", parity: true do
      remove_file(file.external_id)

      expect(response).to be_client_error
    end

    it "refuses a support team member", parity: true do
      as_team_member(TeamMembership::ROLE_SUPPORT)

      remove_file(file.external_id)

      expect(response).to have_http_status(:unauthorized)
      expect(response.parsed_body["success"]).to eq(false)
    end

    it "answers not found for a bundle nobody owns", parity: true do
      log_in(seller)

      remove_file(file.external_id, "unknownbundle")

      expect(response).to have_http_status(:not_found)
    end

    it "answers not found for a file that is not attached to the bundle", parity: true do
      other_file = create(:product_file, link: create(:product, user: seller))
      log_in(seller)

      remove_file(other_file.external_id)

      expect(response).to have_http_status(:not_found)
      expect(response.parsed_body).to eq("success" => false, "error_message" => "That file is no longer attached to this bundle.")
    end

    it "answers not found for a file that was already removed", parity: true do
      file.mark_deleted!
      log_in(seller)

      remove_file(file.external_id)

      expect(response).to have_http_status(:not_found)
    end

    it "hands a removal of an attached file to Rails", parity: true do
      log_in(seller)

      remove_file(file.external_id)

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body).to eq("success" => true)
    end
  end
end
