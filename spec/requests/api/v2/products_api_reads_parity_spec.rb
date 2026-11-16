# frozen_string_literal: true

require "spec_helper"

# The v2 API's read endpoints for a product's resources (SKUs, custom fields, variant categories, variants, builds) and the account refund
# policy, recorded for the Next.js port (nextjs/parity/__tests__/api-v2-products.replay.test.ts).
describe "API v2 product resource reads", type: :request do
  include Parity::ApiV2Requests

  let(:seller) { create(:user) }
  let(:product) { create(:product, user: seller, description: "des", created_at: Time.current) }
  let(:read_token) { api_token(seller, scopes: "view_public") }
  let(:edit_token) { api_token(seller, scopes: "edit_products") }

  describe "skus" do
    it "lists no SKUs for a product without SKUs", parity: true do
      api_call(:get, "/products/#{product.external_id}/skus", token: read_token)

      expect(response.parsed_body).to eq("success" => true, "skus" => [])
    end

    it "lists the alive SKUs of a product with SKUs enabled", parity: true do
      product.update!(skus_enabled: true)
      create(:variant, variant_category: create(:variant_category, title: "Size", link: product), name: "Small")
      colors = create(:variant_category, title: "Color", link: product)
      create(:variant, variant_category: colors, name: "Red")
      create(:variant, variant_category: colors, name: "Blue")
      Product::SkusUpdaterService.new(product:).perform
      product.skus.alive.first.update!(custom_sku: "CUSTOM-1", price_difference_cents: 250, max_purchase_count: 7)

      api_call(:get, "/products/#{product.external_id}/skus", token: read_token)

      expect(response.parsed_body["skus"].size).to eq(2)
    end

    it "lists the default SKU when there is no other", parity: true do
      product.update!(skus_enabled: true)
      create(:variant_category, link: product, title: "Size")
      Product::SkusUpdaterService.new(product:).perform

      api_call(:get, "/products/#{product.external_id}/skus", token: read_token)

      expect(response).to have_http_status(:ok)
    end

    it "lists the versions of a physical product", parity: true do
      product.update!(is_physical: true, require_shipping: true)
      create(:variant, variant_category: create(:variant_category, link: product), name: "Hardcover", price_difference_cents: 500)

      api_call(:get, "/products/#{product.external_id}/skus", token: read_token)

      expect(response.parsed_body["skus"].size).to eq(1)
    end

    it "finds the product by its permalink on the Gumroad domain", parity: true do
      api_call(:get, "/products/#{product.unique_permalink}/skus", token: read_token, api_host: false)

      expect(response.parsed_body["success"]).to be(true)
    end

    it "says the product was not found", parity: true do
      api_call(:get, "/products/nonexistent/skus", token: read_token)

      expect(response.parsed_body).to eq("success" => false, "message" => "The product was not found.")
    end

    it "says the product was not found when it belongs to another seller", parity: true do
      other = create(:product, user: create(:user))

      api_call(:get, "/products/#{other.external_id}/skus", token: read_token)

      expect(response.parsed_body["success"]).to be(false)
    end

    it "still finds a deleted product", parity: true do
      product.mark_deleted!

      api_call(:get, "/products/#{product.external_id}/skus", token: read_token)

      expect(response.parsed_body["success"]).to be(true)
    end

    it "answers a client that asks for JSON", parity: true do
      api_call(:get, "/products/#{product.external_id}/skus", token: read_token, headers: { "Accept" => "application/json" })

      expect(response.headers["Vary"]).to include("Accept")
    end

    it "marks a CLI user while answering", parity: true do
      api_call(:get, "/products/#{product.external_id}/skus", token: read_token, headers: { "User-Agent" => "gumroad-cli/1.2.3" })

      expect(response).to have_http_status(:ok)
      expect(seller.reload.has_used_cli?).to be(true)
    end
  end

  describe "custom fields" do
    it "lists the product's custom fields", parity: true do
      terms = create(:custom_field, seller:, name: "https://example.com/terms", field_type: "terms", required: true)
      text = create(:custom_field, seller:, name: "Nickname")
      terms.products << product
      text.products << product
      text.products << create(:product, user: seller)

      api_call(:get, "/products/#{product.external_id}/custom_fields", token: read_token)

      expect(response.parsed_body["custom_fields"].map { _1["name"] }).to eq(["https://example.com/terms", "Nickname"])
    end

    it "lists nothing for a product without custom fields", parity: true do
      api_call(:get, "/products/#{product.external_id}/custom_fields", token: read_token, api_host: false)

      expect(response.parsed_body["custom_fields"]).to eq([])
    end
  end

  describe "variant categories" do
    let!(:size) { create(:variant_category, link: product, title: "Size") }
    let!(:deleted) { create(:variant_category, link: product, title: "Old", deleted_at: Time.current) }

    it "lists the alive categories", parity: true do
      api_call(:get, "/products/#{product.external_id}/variant_categories", token: read_token)

      expect(response.parsed_body["variant_categories"].map { _1["title"] }).to eq(["Size"])
    end

    it "shows a category", parity: true do
      api_call(:get, "/products/#{product.external_id}/variant_categories/#{size.external_id}", token: read_token)

      expect(response.parsed_body["variant_category"]).to eq("id" => size.external_id, "title" => "Size")
    end

    it "shows a deleted category", parity: true do
      api_call(:get, "/products/#{product.external_id}/variant_categories/#{deleted.external_id}", token: read_token)

      expect(response.parsed_body["variant_category"]["title"]).to eq("Old")
    end

    it "says the category was not found", parity: true do
      api_call(:get, "/products/#{product.external_id}/variant_categories/nonexistent", token: read_token)

      expect(response.parsed_body["message"]).to eq("The variant_category was not found.")
    end

    it "refuses a token without a public scope", parity: true do
      api_call(:get, "/products/#{product.external_id}/variant_categories", token: api_token(seller, scopes: "edit_profile"))

      expect(response).to have_http_status(:forbidden)
    end
  end

  describe "variants" do
    let!(:category) { create(:variant_category, link: product, title: "Version") }
    let!(:basic) { create(:variant, variant_category: category, name: "Basic", description: "The basics", price_difference_cents: 0, max_purchase_count: 10) }
    let!(:pro) { create(:variant, variant_category: category, name: "Pro", price_difference_cents: 500) }
    let!(:retired) { create(:variant, variant_category: category, name: "Retired", deleted_at: Time.current) }

    it "lists the alive versions", parity: true do
      api_call(:get, "/products/#{product.external_id}/variant_categories/#{category.external_id}/variants", token: read_token)

      expect(response.parsed_body["variants"].map { _1["name"] }).to eq(%w[Basic Pro])
    end

    it "lists versions that have prices", parity: true do
      create(:variant_price, variant: pro, price_cents: 1500, recurrence: "monthly", suggested_price_cents: 2000)
      create(:variant_price, variant: pro, price_cents: 15_000, recurrence: "yearly")
      create(:price, link: product, price_cents: 100, recurrence: "monthly")
      create(:price, link: product, price_cents: 1000, recurrence: "yearly")

      api_call(:get, "/products/#{product.external_id}/variant_categories/#{category.external_id}/variants", token: read_token)

      expect(response.parsed_body["variants"].last["recurrence_price_values"]["monthly"]["enabled"]).to be(true)
    end

    it "shows a version with its rich content", parity: true do
      create(:rich_content, entity: pro, title: "Welcome", description: [{ "type" => "paragraph", "content" => [{ "type" => "text", "text" => "Hello" }] }], position: 0)

      api_call(:get, "/products/#{product.external_id}/variant_categories/#{category.external_id}/variants/#{pro.external_id}", token: read_token)

      expect(response.parsed_body["variant"]["rich_content"].size).to eq(1)
    end

    it "shows a deleted version", parity: true do
      api_call(:get, "/products/#{product.external_id}/variant_categories/#{category.external_id}/variants/#{retired.external_id}", token: read_token, api_host: false)

      expect(response.parsed_body["variant"]["name"]).to eq("Retired")
    end

    it "hides the rich content of versions while the product shares one set of pages", parity: true do
      product.update!(has_same_rich_content_for_all_variants: true)
      create(:rich_content, entity: pro, title: "Per version", description: [], position: 0)
      create(:rich_content, entity: product, title: "Shared page", description: [], position: 0)

      api_call(:get, "/products/#{product.external_id}/variant_categories/#{category.external_id}/variants/#{pro.external_id}", token: read_token)

      expect(response.parsed_body["variant"]["rich_content"]).to eq([])
    end

    it "serves the rich content of versions in a recoverable shared-pages state", parity: true do
      product.update!(has_same_rich_content_for_all_variants: true)
      create(:rich_content, entity: pro, title: "Per version", description: [], position: 0)
      create(:rich_content, entity: product, title: nil, description: [], position: 0)

      api_call(:get, "/products/#{product.external_id}/variant_categories/#{category.external_id}/variants/#{pro.external_id}", token: read_token)

      expect(response.parsed_body["variant"]["rich_content"].size).to eq(1)
    end

    it "says the version was not found", parity: true do
      api_call(:get, "/products/#{product.external_id}/variant_categories/#{category.external_id}/variants/nonexistent", token: read_token)

      expect(response.parsed_body["message"]).to eq("The variant was not found.")
    end

    it "says the category was not found when listing", parity: true do
      api_call(:get, "/products/#{product.external_id}/variant_categories/nonexistent/variants", token: read_token)

      expect(response.parsed_body["message"]).to eq("The variant_category was not found.")
    end

    it "lists the tiers of a membership with their prices", parity: true do
      membership = create(:membership_product_with_preset_tiered_pricing, user: seller)

      api_call(:get, "/products/#{membership.external_id}/variant_categories/#{membership.tier_category.external_id}/variants", token: read_token)

      expect(response.parsed_body["variants"].first["recurrence_price_values"]).to be_present
    end
  end

  describe "builds" do
    let!(:first_build) { ProductBuild.create!(product:, number: 1, source_url: "#{S3_BASE_URL}attachments/a.zip", storage_key: "builds/1.zip", byte_size: 2048, status: "superseded") }
    let!(:second_build) { ProductBuild.create!(product:, number: 2, source_url: "#{S3_BASE_URL}attachments/b.zip", storage_key: "builds/2.zip", byte_size: 4096, status: "live", promoted_at: Time.current) }

    it "lists the builds in order", parity: true do
      api_call(:get, "/products/#{product.external_id}/builds", token: edit_token)

      expect(response.parsed_body["builds"].map { _1["number"] }).to eq([1, 2])
    end

    it "shows a build", parity: true do
      api_call(:get, "/products/#{product.external_id}/builds/#{second_build.public_id}", token: edit_token, api_host: false)

      expect(response.parsed_body["build"]["status"]).to eq("live")
    end

    it "says the build was not found", parity: true do
      api_call(:get, "/products/#{product.external_id}/builds/nonexistent", token: edit_token)

      expect(response.parsed_body["message"]).to eq("The build was not found.")
    end

    it "refuses a read-only token", parity: true do
      api_call(:get, "/products/#{product.external_id}/builds", token: read_token)

      expect(response).to have_http_status(:forbidden)
    end
  end

  describe "custom html" do
    it "refuses a seller without access to custom HTML pages", parity: true do
      api_call(:get, "/products/#{product.external_id}/custom_html", token: read_token)

      expect(response.parsed_body).to eq("success" => false, "message" => "You do not have access to custom HTML pages.")
    end

    it "shows the landing page of a product that has one", parity: true do
      Feature.activate_user(:custom_html_pages, seller)
      Page.create!(pageable: product, custom_html: "<main>Hello</main>")

      api_call(:get, "/products/#{product.external_id}/custom_html", token: read_token)

      expect(response.parsed_body).to include("custom_html" => "<main>Hello</main>", "has_landing_page" => true)
    end

    it "reports no landing page for a product without one", parity: true do
      Feature.activate_user(:custom_html_pages, seller)

      api_call(:get, "/products/#{product.unique_permalink}/custom_html", token: read_token, api_host: false)

      expect(response.parsed_body).to include("custom_html" => nil, "has_landing_page" => false)
    end

    it "says the product was not found", parity: true do
      Feature.activate_user(:custom_html_pages, seller)

      api_call(:get, "/products/nonexistent/custom_html", token: read_token)

      expect(response.parsed_body["message"]).to eq("The product was not found.")
    end
  end

  describe "refund policy" do
    it "shows the account-level refund policy", parity: true do
      seller.update!(refund_policy_enabled: true)
      seller.refund_policy.update!(max_refund_period_in_days: 14, fine_print: "No refunds after download.")

      api_call(:get, "/refund_policy", token: read_token)

      expect(response.parsed_body["refund_policy"]).to include("refund_period" => "14", "in_effect" => true)
    end

    it "reports no refunds as none", parity: true do
      seller.refund_policy.update!(max_refund_period_in_days: 0)

      api_call(:get, "/refund_policy", token: read_token, api_host: false)

      expect(response.parsed_body["refund_policy"]["refund_period"]).to eq("none")
    end

    it "reports the policy as not in effect when the seller has it disabled", parity: true do
      seller.update!(refund_policy_enabled: false)

      api_call(:get, "/refund_policy", token: read_token)

      expect(response.parsed_body["refund_policy"]["in_effect"]).to be(false)
    end
  end
end
