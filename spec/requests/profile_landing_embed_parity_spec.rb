# frozen_string_literal: true

require "spec_helper"

# The sandboxed document of a seller's custom HTML profile (UsersController#landing_iframe_content), recorded for the Next.js port
# (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/profile-landing-embed.replay.test.ts, which sends the last request of each
# example. Node renders the page of a seller whose `gumroad-data` payload it can build (no post, no reputation summary, products with no
# thumbnail or cover and a plain USD price); the examples named "hands ..." are what stays in Rails.
describe "Profile landing embed", type: :request do
  include Parity::AudienceSignedIn

  let(:seller) { create(:named_seller, name: "Embed Seller", bio: "I make <b>things</b> & more") }
  let(:custom_html) { "<section><h1 data-gumroad-field=\"name\">x</h1><p data-gumroad-field=\"bio\">y</p></section>" }

  def publish(html = custom_html, user: seller)
    user.update!(custom_html: html)
    Feature.activate_user(:custom_html_pages, user)
  end

  def expect_sandboxed_document
    expect(response).to have_http_status(:ok)
    expect(response.headers["Content-Security-Policy"]).to eq(RendersCustomHtmlPages::CUSTOM_HTML_CSP)
    expect(response.headers["X-Frame-Options"]).to eq("SAMEORIGIN")
    expect(response.headers["Referrer-Policy"]).to eq("no-referrer")
  end

  describe "GET landing/embed" do
    it "renders the page on the seller's own host", parity: true do
      publish
      host! seller.subdomain

      get "/landing/embed"

      expect_sandboxed_document
      expect(response.body).to include("Embed Seller")
      expect(response.body).to include('"products":[]')
      expect(response.headers["Cache-Control"]).to include("no-store")
    end

    it "renders the page under the username on the Gumroad domain", parity: true do
      publish
      host! DOMAIN

      get "/#{seller.username}/landing/embed"

      expect_sandboxed_document
      expect(response.headers["X-Robots-Tag"]).to eq("noindex")
    end

    it "finds the seller by external id", parity: true do
      publish
      host! DOMAIN

      get "/#{seller.external_id}/landing/embed"

      expect_sandboxed_document
    end

    it "renders a page whose seller has no bio or name", parity: true do
      seller.update_columns(name: nil, bio: nil)
      publish
      host! seller.subdomain

      get "/landing/embed"

      expect_sandboxed_document
    end

    it "lists the profile's tab names", parity: true do
      # The schema validation would refuse the nameless tab; the payload skips what it cannot name.
      create(:seller_profile, seller:).update_columns(json_data: { "tabs" => [{ "name" => "Shop", "sections" => [] }, { "name" => "", "sections" => [] }, { "name" => "Notes <3", "sections" => [] }, { "sections" => [] }] })
      publish
      host! seller.subdomain

      get "/landing/embed"

      expect_sandboxed_document
      expect(response.body).to include(%q("pages":[{"name":"Shop"},{"name":"Notes \u003c3"}]))
    end

    it "allows the verified custom domain in the navigation bridge", parity: true do
      create(:custom_domain, :verified_with_certificate, user: seller, domain: "embed-seller.example.com")
      publish
      host! "embed-seller.example.com"

      get "/landing/embed"

      expect_sandboxed_document
      expect(response.body).to include("embed-seller.example.com")
    end

    it "adds the live fields script for the owner previewing", parity: true do
      publish
      host! DOMAIN
      log_in(seller)

      get "/#{seller.username}/landing/embed", params: { preview: "1" }

      expect_sandboxed_document
      expect(response.body).to include("addEventListener(\"message\"")
    end

    it "leaves the live fields script out for a visitor previewing", parity: true do
      publish
      host! DOMAIN

      get "/#{seller.username}/landing/embed", params: { preview: "1" }

      expect_sandboxed_document
    end

    it "adds the Tailwind v3 shim for a page that loads its CDN", parity: true do
      publish("<script src=\"https://cdn.tailwindcss.com\"></script><div class=\"bg-gradient-to-r from-red-500\">x</div>")
      host! seller.subdomain

      get "/landing/embed"

      expect_sandboxed_document
      expect(response.body).to include("@property --tw-gradient-from")
    end

    it "serves a compliant seller's page without the noindex header", parity: true do
      seller.update!(user_risk_state: "compliant")
      publish
      host! DOMAIN

      get "/#{seller.username}/landing/embed"

      expect_sandboxed_document
      expect(response.headers["X-Robots-Tag"]).to be_nil
    end
  end

  describe "GET landing/products" do
    def slice(query = { offset: 0, limit: 100 })
      get "/landing/products", params: query
      JSON.parse(response.body)
    end

    before do
      publish
      host! seller.subdomain
    end

    it "answers the slice of a seller who lists nothing", parity: true do
      body = slice

      expect(response).to have_http_status(:ok)
      expect(response.headers["Cache-Control"]).to include("no-store")
      expect(body).to eq("success" => true, "offset" => 0, "limit" => 100, "products" => [], "products_total" => 0, "prices" => {})
    end

    it "pages through the newest products first", parity: true do
      create(:product, user: seller, name: "Old", created_at: 3.days.ago)
      create(:product, user: seller, name: "Middle <b> & more", created_at: 2.days.ago)
      create(:product, user: seller, name: "New", created_at: 1.day.ago)

      body = slice(offset: 1, limit: 1)

      expect(body["products"].map { |product| product["name"] }).to eq(["Middle <b> & more"])
      expect(body.slice("offset", "limit", "products_total")).to eq("offset" => 1, "limit" => 1, "products_total" => 3)
    end

    it "caps the limit at 100", parity: true do
      create(:product, user: seller, name: "Only")

      expect(slice(offset: 0, limit: 5000).slice("limit")).to eq("limit" => 100)
    end

    it "answers an empty slice when the offset equals the total", parity: true do
      create(:product, user: seller, name: "Only")

      expect(slice(offset: 1, limit: 10)["products"]).to eq([])
    end

    it "answers a bad request when the offset is past the total", parity: true do
      create(:product, user: seller, name: "Only")

      slice(offset: 2, limit: 10)

      expect(response).to have_http_status(:bad_request)
      expect(response.body).to eq('{"success":false}')
    end

    {
      "no parameter" => {},
      "a negative offset" => { offset: -1, limit: 10 },
      "a zero limit" => { offset: 0, limit: 0 },
      "a non-numeric offset" => { offset: "abc", limit: 10 },
      "an empty limit" => { offset: 0, limit: "" },
      "a missing limit" => { offset: 0 }
    }.each do |name, params|
      it "answers a bad request for #{name}", parity: true do
        slice(params)

        expect(response).to have_http_status(:bad_request)
        expect(response.body).to eq('{"success":false}')
      end
    end

    it "reads a signed offset", parity: true do
      create(:product, user: seller, name: "Only")

      expect(slice(offset: "+0", limit: "+1")["products"].size).to eq(1)
    end

    it "answers under the username on the Gumroad domain", parity: true do
      create(:product, user: seller, name: "Only")
      host! DOMAIN

      get "/#{seller.username}/landing/products", params: { offset: 0, limit: 10 }

      expect(response).to have_http_status(:ok)
      expect(JSON.parse(response.body)["products"].size).to eq(1)
    end

    it "reads an offset with a leading zero as octal", parity: true do
      create(:product, user: seller, name: "Only")

      slice(offset: "010", limit: 10)

      expect(response).to have_http_status(:bad_request)
    end

    it "hands a slice of a page that references prices to Rails", parity: true do
      seller.update!(custom_html: "<span data-gumroad-product=\"abc\" data-gumroad-field=\"price\">$1</span>")

      expect(slice).to include("success" => true)
    end

    it "hands a product with a cover to Rails", parity: true do
      create(:asset_preview, link: create(:product, user: seller))

      expect(slice).to include("success" => true)
    end
  end

  describe "GET landing/embed with live products" do
    def embedded_products
      get "/landing/embed"
      expect_sandboxed_document
      body = response.body[/<script[^>]*id="gumroad-data"[^>]*>(.*?)<\/script>/m, 1]
      JSON.parse(body)
    end

    before do
      publish
      host! seller.subdomain
    end

    it "lists a live product with its price, type and description", parity: true do
      create(:product, user: seller, name: "Guide", price_cents: 500, description: "A plain description").update_columns(description: "A plain description")

      payload = embedded_products

      expect(payload["products"].map { |product| product.slice("name", "price", "native_type", "description") }).to eq([{ "name" => "Guide", "price" => "$5", "native_type" => "digital", "description" => "A plain description" }])
      expect(payload["products_total"]).to eq(1)
    end

    it "lists the newest products first and leaves out drafts, archived and deleted ones", parity: true do
      create(:product, user: seller, name: "Old", created_at: 2.days.ago)
      create(:product, user: seller, name: "New", created_at: 1.day.ago)
      create(:product, user: seller, name: "Draft").update_columns(draft: true)
      create(:product, user: seller, name: "Archived").update_attribute(:archived, true)
      create(:product, user: seller, name: "Deleted").update_columns(deleted_at: Time.current)
      create(:product, user: seller, name: "Disabled").update_columns(purchase_disabled_at: Time.current)

      payload = embedded_products

      expect(payload["products"].map { |product| product["name"] }).to eq(%w[New Old])
      expect(payload["products_total"]).to eq(2)
    end

    it "quotes pay-what-you-want, 99 cent and free products (a free price is pay-what-you-want)", parity: true do
      create(:product, user: seller, name: "Free", price_cents: 0, created_at: 3.days.ago)
      create(:product, user: seller, name: "Cheap", price_cents: 99, created_at: 2.days.ago)
      create(:product, user: seller, name: "Flexible", price_cents: 250, customizable_price: true, created_at: 1.day.ago)

      expect(embedded_products["products"].map { |product| product["price"] }).to eq(["$2.50+", "99¢", "$0+"])
    end

    it "quotes a membership with its recurrence", parity: true do
      create(:subscription_product, user: seller, name: "Club", price_cents: 700)

      expect(embedded_products["products"].first["price"]).to eq("$7 a month")
    end

    it "quotes a tiered membership from its cheapest tier", parity: true do
      create(:membership_product, user: seller, name: "Tiers")

      expect(embedded_products["products"].first["price"]).to match(/\A\$\d/)
    end

    it "links a product by its custom permalink", parity: true do
      create(:product, user: seller, name: "Linked", custom_permalink: "my-guide")

      expect(embedded_products["products"].first["url"]).to end_with("/l/my-guide")
    end

    it "squishes and truncates a long description", parity: true do
      create(:product, user: seller, name: "Wordy").update_columns(description: "  lots   of\nspace #{'word ' * 80}")

      expect(embedded_products["products"].first["description"].length).to eq(200)
    end

    it "counts the products beyond the 100 it lists", parity: true do
      Link.bypass_product_creation_limit do
        101.times { |i| create(:product, user: seller, name: "Bulk #{i}", created_at: (i + 1).minutes.ago) }
      end

      payload = embedded_products

      expect(payload["products"].size).to eq(100)
      expect(payload["products_total"]).to eq(101)
    end

    it "hands a product with an uploaded thumbnail to Rails", parity: true do
      create(:thumbnail, product: create(:product, user: seller))

      get "/landing/embed"

      expect(response.body).to include("thumbnail_url")
    end

    it "hands a product with a cover to Rails", parity: true do
      create(:asset_preview, link: create(:product, user: seller))

      get "/landing/embed"

      expect(response).to have_http_status(:ok)
    end

    it "hands a product priced in another currency to Rails", parity: true do
      create(:product, user: seller, price_currency_type: "eur", price_cents: 500)

      expect(embedded_products["products"].first["price"]).to include("€")
    end

    it "lists a product whose description has markup as text", parity: true do
      create(:product, user: seller).update_columns(description: "<p>Hello &amp; welcome</p>")

      expect(embedded_products["products"].first["description"]).to eq("Hello &amp; welcome")
    end

    it "hands a seller with a published post to Rails", parity: true do
      create(:audience_installment, seller:, name: "News", published_at: 1.day.ago, shown_on_profile: true)

      expect(embedded_products["posts"].map { |post| post["name"] }).to eq(["News"])
    end

    it "hands a seller with the reputation summary to Rails", parity: true do
      Feature.activate_user(:seller_reputation_summary, seller)

      expect(embedded_products).to have_key("products")
    end
  end
end
