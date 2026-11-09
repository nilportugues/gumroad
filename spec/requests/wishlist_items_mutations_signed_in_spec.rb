# frozen_string_literal: true

require "spec_helper"

# Following wishlists and adding or removing their products, recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/ws11b.replay.test.ts.
describe "Wishlist followers and products when signed in", type: :request do
  include Parity::AudienceSignedIn

  let(:buyer) { create(:user, name: "Wishing Buyer") }
  let(:owner) { create(:user, name: "Wishlist Owner") }
  let(:wishlist) { create(:wishlist, user: owner, name: "Reading list") }
  let(:product) { create(:product, name: "Wishlisted") }
  let(:json_headers) { { "Accept" => "application/json", "Content-Type" => "application/json" } }

  before { host! DOMAIN }

  def send_json(method, path, body = {}, host: DOMAIN)
    token = csrf_token
    host! host
    public_send(method, path, params: body.to_json, headers: json_headers.merge("X-CSRF-Token" => token))
  end

  describe "followers" do
    it "follows a wishlist", parity: true do
      log_in(buyer)

      send_json(:post, "/wishlists/#{wishlist.external_id}/followers")

      expect(response).to have_http_status(:created)
      expect(wishlist.reload.follower_count).to eq(1)
    end

    it "refuses to follow one's own wishlist", parity: true do
      log_in(owner)

      send_json(:post, "/wishlists/#{wishlist.external_id}/followers")

      expect(response).to have_http_status(:unprocessable_entity)
      expect(response.parsed_body["error"]).to eq("You cannot follow your own wishlist.")
    end

    it "refuses to follow twice", parity: true do
      create(:wishlist_follower, wishlist:, follower_user: buyer)
      log_in(buyer)

      send_json(:post, "/wishlists/#{wishlist.external_id}/followers")

      expect(response).to have_http_status(:unprocessable_entity)
      expect(response.parsed_body["error"]).to eq("Follower user is already following this wishlist.")
    end

    it "unfollows a wishlist", parity: true do
      create(:wishlist_follower, wishlist:, follower_user: buyer)
      wishlist.update_columns(follower_count: 1)
      log_in(buyer)

      send_json(:delete, "/wishlists/#{wishlist.external_id}/followers")

      expect(response).to have_http_status(:no_content)
      expect(wishlist.reload.follower_count).to eq(0)
    end

    it "answers 404 when unfollowing a wishlist that is not followed", parity: true do
      log_in(buyer)

      send_json(:delete, "/wishlists/#{wishlist.external_id}/followers")

      expect(response).to have_http_status(:not_found)
    end

    it "answers 404 for an unknown wishlist", parity: true do
      log_in(buyer)

      send_json(:post, "/wishlists/unknown-id/followers")

      expect(response).to have_http_status(:not_found)
    end

    it "unsubscribes through the email link", parity: true do
      follower = create(:wishlist_follower, wishlist:, follower_user: buyer)
      wishlist.update_columns(follower_count: 1)

      get "/wishlists/#{wishlist.external_id}/followers/unsubscribe", params: { follower_id: follower.external_id }

      expect(response).to have_http_status(:found)
      expect(follower.reload.deleted_at).to be_present
    end

    it "answers 404 for an unknown unsubscribe link", parity: true do
      get "/wishlists/#{wishlist.external_id}/followers/unsubscribe", params: { follower_id: "nope" }

      expect(response).to have_http_status(:not_found)
    end
  end

  describe "products" do
    it "adds a product", parity: true do
      log_in(owner)

      send_json(:post, "/wishlists/#{wishlist.external_id}/products", { wishlist_product: { product_id: product.external_id } })

      expect(response).to have_http_status(:created)
      expect(wishlist.wishlist_products.sole.product).to eq(product)
      expect(wishlist.reload.recommendable).to eq(true)
    end

    it "adds the same product twice without a second row", parity: true do
      create(:wishlist_product, wishlist:, product:)
      log_in(owner)

      send_json(:post, "/wishlists/#{wishlist.external_id}/products", { wishlist_product: { product_id: product.external_id } })

      expect(response).to have_http_status(:created)
      expect(wishlist.wishlist_products.count).to eq(1)
    end

    it "schedules the update emails when the wishlist has followers", parity: true do
      create(:wishlist_follower, wishlist:, follower_user: buyer)
      log_in(owner)

      send_json(:post, "/wishlists/#{wishlist.external_id}/products", { wishlist_product: { product_id: product.external_id } })

      expect(response).to have_http_status(:created)
      expect(SendWishlistUpdatedEmailsJob.jobs.size).to eq(1)
    end

    it "answers 404 for a wishlist of another user", parity: true do
      log_in(buyer)

      send_json(:post, "/wishlists/#{wishlist.external_id}/products", { wishlist_product: { product_id: product.external_id } })

      expect(response).to have_http_status(:not_found)
    end

    it "answers 404 for an unknown product", parity: true do
      log_in(owner)

      send_json(:post, "/wishlists/#{wishlist.external_id}/products", { wishlist_product: { product_id: "unknown" } })

      expect(response).to have_http_status(:not_found)
    end

    it "hands a product with a version through to Rails", parity: true do
      versioned = create(:subscription_product_with_versions)
      log_in(owner)

      send_json(:post, "/wishlists/#{wishlist.external_id}/products", { wishlist_product: { product_id: versioned.external_id, recurrence: BasePrice::Recurrence::MONTHLY, option_id: versioned.options.first[:id] } })

      expect(response).to have_http_status(:created)
    end

    it "removes a product", parity: true do
      wishlist_product = create(:wishlist_product, wishlist:, product:)
      log_in(owner)

      send_json(:delete, "/wishlists/#{wishlist.external_id}/products/#{wishlist_product.external_id}", {}, host: owner.subdomain)

      expect(response).to have_http_status(:no_content)
      expect(wishlist_product.reload.deleted_at).to be_present
    end

    it "does not let another user remove a product", parity: true do
      wishlist_product = create(:wishlist_product, wishlist:, product:)
      log_in(buyer)

      send_json(:delete, "/wishlists/#{wishlist.external_id}/products/#{wishlist_product.external_id}", {}, host: owner.subdomain)

      expect(response).to have_http_status(:unauthorized)
      expect(wishlist_product.reload.deleted_at).to be_nil
    end
  end
end
