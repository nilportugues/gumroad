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

    def embed(file, uid = "00000000-0000-4000-8000-000000000001") = { "type" => "fileEmbed", "attrs" => { "id" => file.external_id, "uid" => uid } }
    def paragraph(text) = { "type" => "paragraph", "content" => [{ "type" => "text", "text" => text }] }

    def zip_of(build) = create(:product_file, link: product, url: "#{S3_BASE_URL}#{build.storage_key}", display_name: "Playable build #{build.number}.zip")

    def live_build(number: 1, public_id: "buildpublicid00live01")
      build = create(:product_build, product:, number:, public_id:, status: "live", promoted_at: Time.utc(2026, 1, 2, 3, 4, 5))
      build.update!(product_file: zip_of(build))
      build
    end

    it "promotes the first build of a product with no pages", parity: true, parity_timeline: true do
      build = create(:product_build, product:, number: 1, public_id: "buildpublicid00000006")

      promote(build.public_id)

      expect(response.parsed_body["build"]).to include("id" => "buildpublicid00000006", "status" => "live")
      expect(build.reload.product_file.display_name).to eq("Playable build 1.zip")
    end

    it "promotes a build through the /api prefix on the Gumroad domain", parity: true, parity_timeline: true do
      build = create(:product_build, product:, public_id: "buildpublicid00000007")

      promote(build.public_id, api_host: false)

      expect(response.parsed_body["success"]).to eq(true)
    end

    it "supersedes the live build and swaps its file in the pages", parity: true, parity_timeline: true do
      old_build = live_build
      create(:rich_content, entity: product, description: [paragraph("Intro"), embed(old_build.product_file), paragraph("Outro")])
      build = create(:product_build, product:, number: 2, public_id: "buildpublicid00000008")

      promote(build.public_id)

      expect(old_build.reload.status).to eq("superseded")
      expect(old_build.product_file).not_to be_alive
      expect(product.alive_rich_contents.first.embedded_product_file_ids_in_order).to eq([build.reload.product_file.id])
    end

    it "puts the file on the first page only and keeps the other files of the pages", parity: true, parity_timeline: true do
      old_build = live_build
      other = create(:product_file, link: product)
      create(:rich_content, entity: product, position: 1, title: "Second", description: [embed(old_build.product_file, "00000000-0000-4000-8000-000000000002"), embed(other, "00000000-0000-4000-8000-000000000003")])
      create(:rich_content, entity: product, position: 0, title: "First", description: [paragraph("Start")])
      build = create(:product_build, product:, number: 2, public_id: "buildpublicid00000009")

      promote(build.public_id)

      first, second = product.alive_rich_contents.order(:position).to_a
      expect(first.embedded_product_file_ids_in_order).to eq([build.reload.product_file.id])
      expect(second.embedded_product_file_ids_in_order).to eq([other.id])
    end

    it "removes the old embed from inside a list", parity: true, parity_timeline: true do
      old_build = live_build
      create(:rich_content, entity: product, description: [{ "type" => "bulletList", "content" => [{ "type" => "listItem", "content" => [embed(old_build.product_file)] }] }, paragraph("After")])
      build = create(:product_build, product:, number: 2, public_id: "buildpublicid00000010")

      promote(build.public_id)

      expect(response.parsed_body["build"]).to include("status" => "live")
    end

    it "promotes a superseded build again", parity: true, parity_timeline: true do
      live = live_build(number: 2, public_id: "buildpublicid00live02")
      create(:rich_content, entity: product, description: [embed(live.product_file)])
      older = create(:product_build, product:, number: 1, public_id: "buildpublicid00000011", status: "superseded")

      promote(older.public_id)

      expect(live.reload.status).to eq("superseded")
      expect(older.reload.status).to eq("live")
    end

    it "hands a promotion of the live build to Rails", parity: true do
      build = live_build

      promote(build.public_id)

      expect(response.parsed_body["build"]).to include("status" => "live")
    end

    it "hands a promotion for a product with versions to Rails", parity: true do
      category = create(:variant_category, link: product, title: "Edition")
      create(:variant, variant_category: category, name: "Standard")
      build = create(:product_build, product:, public_id: "buildpublicid00000012")

      promote(build.public_id)

      expect(response.parsed_body["build"]).to include("status" => "live")
    end

    it "hands a promotion for a page with a folder to Rails", parity: true do
      first_file = create(:product_file, link: product)
      second_file = create(:product_file, link: product)
      group = { "type" => "fileEmbedGroup", "attrs" => { "name" => "Pack", "uid" => "00000000-0000-4000-8000-000000000009" }, "content" => [embed(first_file, "00000000-0000-4000-8000-000000000004"), embed(second_file, "00000000-0000-4000-8000-000000000005")] }
      create(:rich_content, entity: product, description: [group])
      build = create(:product_build, product:, public_id: "buildpublicid00000013")

      promote(build.public_id)

      expect(response.parsed_body["build"]).to include("status" => "live")
    end
  end
end
