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

    it "adds the chosen version of a product", parity: true do
      versioned = create(:product_with_digital_versions)
      log_in(owner)

      send_json(:post, "/wishlists/#{wishlist.external_id}/products", { wishlist_product: { product_id: versioned.external_id, option_id: versioned.options.second[:id] } })

      expect(response).to have_http_status(:created)
      expect(wishlist.wishlist_products.sole.variant).to eq(versioned.alive_variants.second)
    end

    it "adds a second version of a product as its own row", parity: true do
      versioned = create(:product_with_digital_versions)
      create(:wishlist_product, wishlist:, product: versioned, variant: versioned.alive_variants.first)
      log_in(owner)

      send_json(:post, "/wishlists/#{wishlist.external_id}/products", { wishlist_product: { product_id: versioned.external_id, option_id: versioned.options.second[:id] } })

      expect(response).to have_http_status(:created)
      expect(wishlist.wishlist_products.count).to eq(2)
    end

    it "adds the same version twice without a second row", parity: true do
      versioned = create(:product_with_digital_versions)
      create(:wishlist_product, wishlist:, product: versioned, variant: versioned.alive_variants.first)
      log_in(owner)

      send_json(:post, "/wishlists/#{wishlist.external_id}/products", { wishlist_product: { product_id: versioned.external_id, option_id: versioned.options.first[:id] } })

      expect(response).to have_http_status(:created)
      expect(wishlist.wishlist_products.count).to eq(1)
    end

    it "refuses a product with versions when no version is chosen", parity: true do
      versioned = create(:product_with_digital_versions)
      log_in(owner)

      send_json(:post, "/wishlists/#{wishlist.external_id}/products", { wishlist_product: { product_id: versioned.external_id } })

      expect(response).to have_http_status(:unprocessable_entity)
      expect(response.parsed_body["error"]).to eq("Wishlist product must have variant specified for versioned product")
      expect(wishlist.wishlist_products).to be_empty
    end

    it "answers 404 for a version that belongs to another product", parity: true do
      versioned = create(:product_with_digital_versions)
      other = create(:product_with_digital_versions)
      log_in(owner)

      send_json(:post, "/wishlists/#{wishlist.external_id}/products", { wishlist_product: { product_id: versioned.external_id, option_id: other.options.first[:id] } })

      expect(response).to have_http_status(:not_found)
    end

    it "answers 404 for a version that is not a valid id", parity: true do
      versioned = create(:product_with_digital_versions)
      log_in(owner)

      send_json(:post, "/wishlists/#{wishlist.external_id}/products", { wishlist_product: { product_id: versioned.external_id, option_id: "unknown" } })

      expect(response).to have_http_status(:not_found)
    end

    it "adds a membership tier with its recurrence", parity: true do
      membership = create(:subscription_product_with_versions)
      log_in(owner)

      send_json(:post, "/wishlists/#{wishlist.external_id}/products", { wishlist_product: { product_id: membership.external_id, recurrence: BasePrice::Recurrence::MONTHLY, option_id: membership.options.first[:id] } })

      expect(response).to have_http_status(:created)
      expect(wishlist.wishlist_products.sole.recurrence).to eq(BasePrice::Recurrence::MONTHLY)
    end

    it "adds a recurring product with another recurrence as its own row", parity: true do
      membership = create(:subscription_product_with_versions)
      variant = membership.alive_variants.first
      create(:wishlist_product, wishlist:, product: membership, variant:, recurrence: BasePrice::Recurrence::MONTHLY)
      log_in(owner)

      send_json(:post, "/wishlists/#{wishlist.external_id}/products", { wishlist_product: { product_id: membership.external_id, recurrence: BasePrice::Recurrence::YEARLY, option_id: membership.options.first[:id] } })

      expect(response).to have_http_status(:created)
      expect(wishlist.wishlist_products.count).to eq(2)
    end

    it "refuses a recurring product when no recurrence is chosen", parity: true do
      membership = create(:subscription_product_with_versions)
      log_in(owner)

      send_json(:post, "/wishlists/#{wishlist.external_id}/products", { wishlist_product: { product_id: membership.external_id, option_id: membership.options.first[:id] } })

      expect(response).to have_http_status(:unprocessable_entity)
      expect(response.parsed_body["error"]).to eq("Recurrence is not included in the list")
    end

    it "refuses a recurrence that is not allowed", parity: true do
      membership = create(:subscription_product_with_versions)
      log_in(owner)

      send_json(:post, "/wishlists/#{wishlist.external_id}/products", { wishlist_product: { product_id: membership.external_id, recurrence: "weekly", option_id: membership.options.first[:id] } })

      expect(response).to have_http_status(:unprocessable_entity)
      expect(response.parsed_body["error"]).to eq("Recurrence is not included in the list")
    end

    it "refuses a recurrence for a product that is not recurring", parity: true do
      log_in(owner)

      send_json(:post, "/wishlists/#{wishlist.external_id}/products", { wishlist_product: { product_id: product.external_id, recurrence: BasePrice::Recurrence::MONTHLY } })

      expect(response).to have_http_status(:unprocessable_entity)
      expect(response.parsed_body["error"]).to eq("Recurrence must be blank")
    end

    it "hands a product with skus through to Rails", parity: true do
      physical = create(:physical_product, skus_enabled: true)
      create(:sku, link: physical, name: "Large")
      create(:sku, link: physical, name: "Small")
      log_in(owner)

      send_json(:post, "/wishlists/#{wishlist.external_id}/products", { wishlist_product: { product_id: physical.external_id, option_id: physical.skus.not_is_default_sku.first.external_id } })

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

  describe "when signed out" do
    let(:wishlist_product) { create(:wishlist_product, wishlist:, product:) }

    it "answers 404 JSON to a follow", parity: true do
      send_json(:post, "/wishlists/#{wishlist.external_id}/followers")

      expect(response).to have_http_status(:not_found)
      expect(response.parsed_body).to eq("success" => false, "error" => "Not found")
    end

    it "answers 404 JSON to an unfollow of an unknown wishlist", parity: true do
      send_json(:delete, "/wishlists/unknown/followers")

      expect(response).to have_http_status(:not_found)
      expect(response.parsed_body).to eq("success" => false, "error" => "Not found")
    end

    it "answers 404 JSON to adding a product", parity: true do
      send_json(:post, "/wishlists/#{wishlist.external_id}/products", { wishlist_product: { product_id: product.external_id } })

      expect(response).to have_http_status(:not_found)
      expect(wishlist.reload.wishlist_products).to be_empty
    end

    it "answers 404 JSON to removing a product", parity: true do
      send_json(:delete, "/wishlists/#{wishlist.external_id}/products/#{wishlist_product.external_id}", {}, host: owner.subdomain)

      expect(response).to have_http_status(:not_found)
      expect(wishlist_product.reload.deleted_at).to be_nil
    end

    it "redirects an HTML follow to the login page", parity: true do
      token = csrf_token
      post "/wishlists/#{wishlist.external_id}/followers", params: { authenticity_token: token }

      expect(response).to have_http_status(:found)
      expect(response.location).to eq("http://#{DOMAIN}/login?next=%2Fwishlists%2F#{CGI.escape(wishlist.external_id)}%2Ffollowers")
    end
  end
end
