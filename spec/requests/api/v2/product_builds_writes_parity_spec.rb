# frozen_string_literal: true

require "spec_helper"

# Api::V2::ProductBuildsController#deploy and #promote through the full Rack stack, recorded for the Next.js port (PARITY_RECORD=1) and
# replayed by nextjs/parity/__tests__/api-v2-ws17c.replay.test.ts. Node answers the checks on the url, a repeated deploy and the 404 of
# #promote; copying the upload in S3 and swapping the live file are recorded as what Node hands back.
describe "API v2 product build writes", type: :request do
  include Parity::ApiV2Requests

  let(:seller) { create(:user, name: "Build Seller", email: "build-seller@example.com") }
  let(:product) { create(:product, user: seller, name: "Playable", unique_permalink: "playable") }
  let(:token) { api_token(seller) }
  let(:seller_prefix) { "#{S3_BASE_URL}attachments/#{seller.external_id}/" }

  def deploy(params = {}, options = {})
    api_call(:post, "/products/#{options.fetch(:product_id) { product.external_id }}/builds/deploy", params:, token: options.fetch(:token) { token }, **options.slice(:as, :api_host))
  end

  def promote(build_id, options = {})
    api_call(:post, "/products/#{options.fetch(:product_id) { product.external_id }}/builds/#{build_id}/promote", token: options.fetch(:token) { token }, **options.slice(:api_host))
  end

  describe "POST /products/:link_id/builds/deploy" do
    it "asks for a url", parity: true do
      deploy

      expect(response.parsed_body).to eq("success" => false, "message" => "url is required.")
    end

    it "asks for a url when it is blank", parity: true do
      deploy({ url: "   " })

      expect(response.parsed_body["message"]).to eq("url is required.")
    end

    it "asks for a url when it is a list", parity: true do
      deploy({ url: ["#{seller_prefix}a/original/game.zip"] }, as: :json)

      expect(response.parsed_body["message"]).to eq("url is required.")
    end

    it "refuses a url outside the upload prefix of the seller", parity: true do
      deploy({ url: "https://example.com/game.zip" })

      expect(response.parsed_body["message"]).to eq("url must be a .zip you uploaded with POST /v2/files/presign and /v2/files/complete.")
    end

    it "refuses the upload prefix of another seller", parity: true do
      deploy({ url: "#{S3_BASE_URL}attachments/someone-else/a/original/game.zip" })

      expect(response.parsed_body["message"]).to start_with("url must be a .zip you uploaded")
    end

    it "refuses a url that climbs out of the prefix", parity: true do
      deploy({ url: "#{seller_prefix}../other/original/game.zip" })

      expect(response.parsed_body["message"]).to start_with("url must be a .zip you uploaded")
    end

    it "refuses a url with an encoded slash", parity: true do
      deploy({ url: "#{seller_prefix}a%2Fb/original/game.zip" })

      expect(response.parsed_body["message"]).to start_with("url must be a .zip you uploaded")
    end

    it "refuses a url that is not a zip", parity: true do
      deploy({ url: "#{seller_prefix}a/original/game.rar" })

      expect(response.parsed_body["message"]).to start_with("url must be a .zip you uploaded")
    end

    it "does not find an unknown product", parity: true do
      deploy({ url: "#{seller_prefix}a/original/game.zip" }, product_id: "unknown")

      expect(response.parsed_body).to eq("success" => false, "message" => "The product was not found.")
    end

    it "refuses a request without a token", parity: true do
      deploy({ url: "#{seller_prefix}a/original/game.zip" }, token: nil)

      expect(response).to have_http_status(:unauthorized)
    end

    it "refuses a token that lacks the edit_products scope", parity: true do
      deploy({ url: "#{seller_prefix}a/original/game.zip" }, token: api_token(seller, scopes: "view_sales"))

      expect(response).to have_http_status(:forbidden)
    end

    it "answers a repeated deploy with the build it made", parity: true do
      url = "#{seller_prefix}a/original/game.zip"
      create(:product_build, product:, number: 1, source_url: url, public_id: "buildpublicid00000001", status: "live", promoted_at: Time.utc(2026, 1, 2, 3, 4, 5))

      deploy({ url: })

      expect(response.parsed_body["build"]).to include("id" => "buildpublicid00000001", "number" => 1, "status" => "live")
    end

    it "answers a repeated deploy through the /api prefix on the Gumroad domain", parity: true do
      url = "#{seller_prefix}b/original/game.zip"
      create(:product_build, product:, number: 2, source_url: url, public_id: "buildpublicid00000002")

      deploy({ url: }, api_host: false)

      expect(response.parsed_body["build"]).to include("number" => 2, "status" => "uploaded")
    end

    it "hands a deploy of an upload that another product deployed to Rails", parity: true do
      url = "#{seller_prefix}c/original/game.zip"
      create(:product_build, product: create(:product, user: seller, unique_permalink: "playablb"), source_url: url)

      deploy({ url: })

      expect(response.parsed_body["message"]).to eq("The uploaded zip was not found. Finish the upload with POST /v2/files/complete first.")
    end

    it "hands an upload that is not in S3 to Rails", parity: true do
      deploy({ url: "#{seller_prefix}d/original/game.zip" })

      expect(response.parsed_body["success"]).to eq(false)
    end
  end

  describe "POST /products/:link_id/builds/:id/promote" do
    it "does not find an unknown build", parity: true do
      promote("unknown")

      expect(response.parsed_body).to eq("success" => false, "message" => "The build was not found.")
    end

    it "does not find the build of another product", parity: true do
      build = create(:product_build, product: create(:product, user: seller, unique_permalink: "playablc"), public_id: "buildpublicid00000003")

      promote(build.public_id)

      expect(response.parsed_body["message"]).to eq("The build was not found.")
    end

    it "does not find the product", parity: true do
      promote("buildpublicid00000004", product_id: "unknown")

      expect(response.parsed_body["message"]).to eq("The product was not found.")
    end

    it "refuses a request without a token", parity: true do
      promote("buildpublicid00000005", token: nil)

      expect(response).to have_http_status(:unauthorized)
    end

    it "hands a promotion of a build to Rails", parity: true do
      build = create(:product_build, product:, public_id: "buildpublicid00000006")

      promote(build.public_id)

      expect(response).to have_http_status(:ok)
    end

    it "hands a promotion through the /api prefix on the Gumroad domain to Rails", parity: true do
      build = create(:product_build, product:, public_id: "buildpublicid00000007")

      promote(build.public_id, api_host: false)

      expect(response.parsed_body["success"]).to eq(true)
    end
  end
end
