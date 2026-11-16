# frozen_string_literal: true

require "spec_helper"

# ProductDuplicatesController, BundlesController#show and Products::BuildsController#index, recorded for the Next.js port
# (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/ws12c.replay.test.ts. A fixture named `hands-a-...` is a request
# the port gives back to Rails.
describe "Product editor actions when signed in", type: :request do
  include Parity::AudienceSignedIn

  let(:seller) { create(:user, name: "Editor Seller") }
  let(:product) { create(:product, user: seller, name: "Editable product", unique_permalink: "editprod", created_at: Time.utc(2025, 1, 1)) }
  let(:json_headers) { { "Accept" => "application/json, text/html", "Content-Type" => "application/json" } }
  let(:duplicator_redis) { Redis::Namespace.new(:product_duplicator_service, redis: $redis) }

  before { host! DOMAIN }

  def get_json(path)
    get path, headers: { "Accept" => "application/json, text/html" }
  end

  def send_json(method, path, body = {})
    public_send(method, path, params: body.to_json, headers: json_headers.merge("X-CSRF-Token" => csrf_token))
  end

  def team_member(role)
    member = create(:user, name: "#{role.capitalize} Member")
    membership = create(:team_membership, user: member, seller:, role:)
    log_in(member)
    switch_to(membership)
  end

  describe "product duplicates" do
    it "queues the duplication and marks the product as duplicating", parity: true do
      product
      log_in(seller)

      send_json(:post, product_duplicates_path, { id: product.unique_permalink })

      expect(response.parsed_body).to eq("success" => true)
      expect(product.reload).to be_is_duplicating
      expect(DuplicateProductWorker.jobs.size).to eq(1)
    end

    it "does not queue a second duplication", parity: true do
      product.update!(is_duplicating: true)
      log_in(seller)

      send_json(:post, product_duplicates_path, { id: product.unique_permalink })

      expect(response.parsed_body).to eq("success" => false, "error_message" => "Duplication in progress...")
      expect(DuplicateProductWorker.jobs.size).to eq(0)
    end

    it "answers 404 for another seller's product", parity: true do
      other = create(:product, unique_permalink: "notmine")
      log_in(seller)

      send_json(:post, product_duplicates_path, { id: other.unique_permalink })

      expect(response).to have_http_status(:not_found)
    end

    it "refuses a support team member", parity: true do
      product
      team_member(TeamMembership::ROLE_SUPPORT)

      send_json(:post, product_duplicates_path, { id: product.unique_permalink })

      expect(response).to have_http_status(:unauthorized)
      expect(product.reload).not_to be_is_duplicating
    end

    it "reports a duplication in progress", parity: true do
      product.update!(is_duplicating: true)
      log_in(seller)

      get_json product_duplicate_path(product.unique_permalink)

      expect(response.parsed_body).to eq("success" => false, "status" => "product_duplicating", "error_message" => "Duplication in progress...")
    end

    it "reports a failed duplication with its message", parity: true do
      duplicator_redis.setex("error:#{product.id}", 600, "Something went wrong")
      log_in(seller)

      get_json product_duplicate_path(product.unique_permalink)

      expect(response.parsed_body).to eq("success" => false, "status" => "product_duplication_failed", "error_message" => "Something went wrong")
    end

    it "reports a duplication nobody remembers", parity: true do
      product
      log_in(seller)

      get_json product_duplicate_path(product.unique_permalink)

      expect(response.parsed_body).to eq("success" => false, "status" => "product_duplication_failed", "error_message" => nil)
    end

    it "hands a finished duplication to Rails", parity: true do
      copy = create(:product, user: seller, name: "Editable product (copy)")
      duplicator_redis.setex(product.id, 600, copy.id)
      log_in(seller)

      get_json product_duplicate_path(product.unique_permalink)

      expect(response.parsed_body["success"]).to eq(true)
    end
  end

  describe "bundle redirect" do
    it "sends a bundle to its editor for good", parity: true do
      bundle = create(:product, :bundle, user: seller)
      log_in(seller)

      get bundle_path(bundle.external_id)

      expect(response).to have_http_status(:moved_permanently)
      expect(response.location).to end_with("/bundles/#{bundle.external_id}/product/edit")
    end

    it "sends a plain product that can become a bundle to the bundle editor", parity: true do
      log_in(seller)

      get bundle_path(product.external_id)

      expect(response).to have_http_status(:moved_permanently)
    end

    it "answers 404 for a membership", parity: true do
      membership = create(:membership_product, user: seller)
      log_in(seller)

      get bundle_path(membership.external_id)

      expect(response).to have_http_status(:not_found)
    end

    it "answers 404 for a product with options", parity: true do
      create(:variant_category, link: product)
      log_in(seller)

      get bundle_path(product.external_id)

      expect(response).to have_http_status(:not_found)
    end

    it "answers 404 for an id that decodes to nothing", parity: true do
      log_in(seller)

      get bundle_path("not-an-id")

      expect(response).to have_http_status(:not_found)
    end

    it "sends a support team member to the dashboard", parity: true do
      bundle = create(:product, :bundle, user: seller)
      team_member(TeamMembership::ROLE_SUPPORT)

      get bundle_path(bundle.external_id)

      expect(response).to have_http_status(:found)
    end
  end

  describe "product builds" do
    let!(:first_build) { ProductBuild.create!(product:, number: 1, source_url: "#{S3_BASE_URL}attachments/a.zip", storage_key: "builds/1.zip", byte_size: 2048, status: "superseded", created_at: Time.utc(2025, 3, 1), updated_at: Time.utc(2025, 3, 1)) }
    let!(:second_build) { ProductBuild.create!(product:, number: 2, source_url: "#{S3_BASE_URL}attachments/b.zip", storage_key: "builds/2.zip", byte_size: 4096, status: "live", promoted_at: Time.utc(2025, 3, 3), created_at: Time.utc(2025, 3, 2), updated_at: Time.utc(2025, 3, 3)) }

    it "lists the builds newest first", parity: true do
      Feature.activate_user(:product_build_player, seller)
      log_in(seller)

      get_json product_builds_path(product.unique_permalink, format: :json)

      expect(response.parsed_body["builds"].map { _1["number"] }).to eq([2, 1])
      expect(response.parsed_body["builds"].first).to include("status" => "live", "byte_size" => 4096)
    end

    it "answers 404 while the player is off", parity: true do
      log_in(seller)

      get_json product_builds_path(product.unique_permalink, format: :json)

      expect(response).to have_http_status(:not_found)
    end

    it "refuses a support team member", parity: true do
      Feature.activate_user(:product_build_player, seller)
      team_member(TeamMembership::ROLE_SUPPORT)

      get_json product_builds_path(product.unique_permalink, format: :json)

      expect(response).to have_http_status(:unauthorized)
    end
  end
end
