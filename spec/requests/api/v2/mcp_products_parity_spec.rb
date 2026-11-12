# frozen_string_literal: true

require "spec_helper"

# The product tools of Mcp::Server (get_product, list_files) through the full Rack stack, recorded for the Next.js port
# (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/api-v2-ws17c.replay.test.ts.
describe "API v2 MCP product tools", type: :request, elasticsearch_wait_for_refresh: true do
  include ProductPageViewHelpers

  let(:seller) { create(:user, username: "dude", name: "Dude") }
  let(:application) { create(:oauth_application, owner: create(:user)) }
  let(:rpc) { { "Content-Type" => "application/json" } }
  let!(:product) { create(:product, user: seller, name: "Sketch pack", unique_permalink: "sketchpk", description: "Draw <b>more</b>") }

  before { host! DOMAIN }

  def auth(scopes) = { "Authorization" => "Bearer #{create("doorkeeper/access_token", application:, resource_owner_id: seller.id, scopes:).token}" }

  def call_tool(name, arguments = {}, scopes: "view_public")
    body = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name:, arguments: } }
    post "/muse/v1/mcp", params: body.to_json, headers: rpc.merge(auth(scopes))
  end

  def sell(link, email:, price_cents:, **attributes)
    build(:purchase, link:, seller:, email:, price_cents:, purchase_state: "successful", created_at: Time.utc(2026, 3, 2, 10), **attributes).tap { |row| row.save!(validate: false) }
  end

  describe "get_product" do
    it "reports a product with its description and no covers", parity: true do
      call_tool("get_product", { id: product.external_id })
    end

    it "finds a product by its permalink", parity: true do
      call_tool("get_product", { id: "sketchpk" })
    end

    it "finds a product by its custom permalink", parity: true do
      product.update!(custom_permalink: "sketch")
      call_tool("get_product", { id: "sketch" })
    end

    it "reports a product with a null description", parity: true do
      product.update_columns(description: nil)
      call_tool("get_product", { id: "sketchpk" })
    end

    it "reports the Unsplash covers of a product in their order", parity: true do
      AssetPreview.create!(link: product, unsplash_url: "https://images.example.com/second.jpg", guid: "covertwo", position: 1)
      AssetPreview.create!(link: product, unsplash_url: "https://images.example.com/first.jpg", guid: "coverone", position: 0)
      AssetPreview.create!(link: product, unsplash_url: "https://images.example.com/gone.jpg", guid: "covergone", position: 2).update_columns(deleted_at: Time.utc(2026, 3, 1))
      call_tool("get_product", { id: "sketchpk" })
    end

    it "reports a pay what you want product", parity: true do
      product.update!(customizable_price: true, suggested_price_cents: 900)
      call_tool("get_product", { id: "sketchpk" })
    end

    it "reports a draft product as unpublished", parity: true do
      product.update_columns(draft: true)
      call_tool("get_product", { id: "sketchpk" })
    end

    it "reports the sales figures to a token with a sales scope", parity: true do
      sell(product, email: "ada@example.com", price_cents: 1000)
      sell(product, email: "bob@example.com", price_cents: 500)
      sell(product, email: "cy@example.com", price_cents: 700, stripe_refunded: true)
      index_model_records(Purchase)
      call_tool("get_product", { id: "sketchpk" }, scopes: "view_public view_sales")
    end

    it "reports zero sales to a token with the account scope", parity: true do
      call_tool("get_product", { id: "sketchpk" }, scopes: "account")
    end

    it "refuses a blank id", parity: true do
      call_tool("get_product", { id: " " })
    end

    it "reports a product that does not exist as a tool error", parity: true do
      call_tool("get_product", { id: "nope" })
    end

    it "reports a product of another seller as a tool error", parity: true do
      other = create(:product, user: create(:user), unique_permalink: "theirs")
      call_tool("get_product", { id: other.external_id })
    end

    it "reports a deleted product as a tool error", parity: true do
      product.update_columns(deleted_at: Time.utc(2026, 3, 10))
      call_tool("get_product", { id: "sketchpk" })
    end

    it "hands back a bundle", parity: true do
      create(:product, :bundle, user: seller, name: "Bundle", unique_permalink: "bundlepk")
      call_tool("get_product", { id: "bundlepk" })
    end

    it "hands back a tiered membership", parity: true do
      create(:membership_product, user: seller, name: "Club", unique_permalink: "clubpk")
      call_tool("get_product", { id: "clubpk" })
    end

    it "hands back a product whose cover is an oembed", parity: true do
      AssetPreview.create!(link: product, unsplash_url: "https://images.example.com/first.jpg", guid: "coverone").update_columns(unsplash_url: nil, oembed: { title: "Video", html: "<iframe></iframe>", info: { width: 1, height: 1, thumbnail_url: "https://i.example.com/t.jpg" } }.to_json)
      call_tool("get_product", { id: "sketchpk" })
    end

    it "hands back a token without a scope the tool needs", parity: true do
      call_tool("get_product", { id: "sketchpk" }, scopes: "view_sales")
    end
  end

  describe "list_files" do
    def file(attributes) = create(:product_file, link: product, **attributes)

    it "lists a product with no files", parity: true do
      call_tool("list_files", { id: "sketchpk" }, scopes: "edit_products")
    end

    it "lists the files of a product in position order", parity: true do
      file(url: "#{S3_BASE_URL}specs/second.pdf", display_name: "Second", filetype: "pdf", filegroup: "document", size: 2048, position: 1)
      file(url: "#{S3_BASE_URL}specs/first.mp3", filetype: "mp3", filegroup: "audio", size: 500_000, position: 0)
      file(url: "https://example.com/link", filetype: "link", filegroup: "url", position: 2)
      call_tool("list_files", { id: "sketchpk" }, scopes: "edit_products")
    end

    it "names a file from its S3 key and takes its type from the extension", parity: true do
      file(url: "#{S3_BASE_URL}specs/My Notes.TXT", filetype: "txt", filegroup: "document", size: nil, position: 0)
      call_tool("list_files", { id: "sketchpk" }, scopes: "account")
    end

    it "leaves out a deleted file", parity: true do
      file(url: "#{S3_BASE_URL}specs/kept.pdf", filetype: "pdf", filegroup: "document", size: 10, position: 0)
      file(url: "#{S3_BASE_URL}specs/gone.pdf", filetype: "pdf", filegroup: "document", size: 10, position: 1).update_columns(deleted_at: Time.utc(2026, 3, 1))
      call_tool("list_files", { id: "sketchpk" }, scopes: "edit_products")
    end

    it "reports a product that does not exist as a tool error", parity: true do
      call_tool("list_files", { id: "nope" }, scopes: "edit_products")
    end

    it "refuses a missing id", parity: true do
      call_tool("list_files", {}, scopes: "edit_products")
    end

    it "hands back files that share a position", parity: true do
      file(url: "#{S3_BASE_URL}specs/a.pdf", filetype: "pdf", filegroup: "document", position: 0)
      file(url: "#{S3_BASE_URL}specs/b.pdf", filetype: "pdf", filegroup: "document", position: 0)
      call_tool("list_files", { id: "sketchpk" }, scopes: "edit_products")
    end

    it "hands back a token without a scope the tool needs", parity: true do
      call_tool("list_files", { id: "sketchpk" }, scopes: "view_public")
    end
  end

  # The rows are literal 2026-03 instants and the seller predates them, so the replay (which pins its seed clock to the
  # recording hour) reads the same activity whatever day it runs.
  describe "get_analytics" do
    let(:seller) { create(:user, username: "dude", name: "Dude", created_at: Time.utc(2026, 1, 1)) }
    let!(:other_product) { create(:product, user: seller, name: "Icon set", unique_permalink: "iconset") }
    let(:march) { { start_date: "2026-03-01", end_date: "2026-03-31" } }

    before do
      Purchase.__elasticsearch__.create_index!(force: true)
      ProductPageView.__elasticsearch__.create_index!(force: true)
    end

    def view(item, day, referrer_domain: "direct")
      add_page_view(item, Time.utc(2026, 3, day, 11, 5).iso8601, { country: "United States", state: "CA", referrer_domain: })
    end

    def seed(*sales)
      sales.each { |item, email, price_cents, day, attributes| sell(item, email:, price_cents:, **{ created_at: Time.utc(2026, 3, day, 10) }.merge(attributes || {})) }
      index_model_records(Purchase)
      EsClient.indices.refresh(index: ProductPageView.index_name)
    end

    def analytics(arguments = {}, scopes = "view_sales")
      call_tool("get_analytics", march.merge(arguments), scopes:)
    end

    context "with views and sales on two products" do
      before do
        3.times { |day| view(product, day + 2) }
        view(other_product, 4)
        seed([product, "ada@example.com", 1000, 2], [product, "bob@example.com", 500, 3], [other_product, "cy@example.com", 700, 4])
      end

      it "reports views, sales and revenue by product, most viewed first", parity: true do
        analytics
      end

      it "rounds the conversion rate to four places", parity: true do
        3.times { view(product, 9) }
        analytics
      end

      it "narrows the report to one product", parity: true do
        analytics({ product_id: other_product.external_id })
      end

      it "narrows the report by permalink and counts only the days in range", parity: true do
        analytics({ product_id: "sketchpk", start_date: "2026-03-03", end_date: "2026-03-03" })
      end

      it "reports the referrers behind the views and sales", parity: true do
        view(product, 5, referrer_domain: "twitter.com")
        view(product, 6, referrer_domain: "twitter.com")
        analytics({ breakdown: "referrer" })
      end

      it "reports the referrers of one product", parity: true do
        view(product, 5, referrer_domain: "twitter.com")
        analytics({ breakdown: "referrer", product_id: "iconset" })
      end

      it "hands back two products with the same number of views", parity: true do
        view(other_product, 5)
        view(other_product, 6)
        analytics
      end

      it "hands back a referrer breakdown with two referrers that have the same number of views", parity: true do
        view(product, 7, referrer_domain: "twitter.com")
        view(other_product, 7, referrer_domain: "google.com")
        analytics({ breakdown: "referrer" })
      end
    end

    it "leaves the conversion rate empty for a product nobody viewed", parity: true do
      seed([product, "ada@example.com", 1000, 2])
      other_product.update_columns(deleted_at: Time.utc(2026, 3, 1))
      analytics
    end

    it "reports a seller with one product and no activity", parity: true do
      other_product.update_columns(deleted_at: Time.utc(2026, 3, 1))
      analytics
    end

    it "returns no rows for a range that ends before the day the account was created", parity: true do
      analytics({ start_date: "2025-11-01", end_date: "2025-12-30" })
    end

    it "refuses a start date after the end date", parity: true do
      analytics({ start_date: "2026-03-10", end_date: "2026-03-01" })
    end

    it "refuses a range of more than a year", parity: true do
      analytics({ start_date: "2024-01-01", end_date: "2026-03-31" })
    end

    it "reports a product that does not exist as a tool error", parity: true do
      analytics({ product_id: "nope" })
    end

    it "hands back a date that is not YYYY-MM-DD", parity: true do
      analytics({ start_date: "March 1" })
    end

    it "hands back a token without a sales scope", parity: true do
      analytics({}, "view_public")
    end
  end
end
