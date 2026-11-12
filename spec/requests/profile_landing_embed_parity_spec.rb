# frozen_string_literal: true

require "spec_helper"

# The sandboxed document of a seller's custom HTML profile (UsersController#landing_iframe_content), recorded for the Next.js port
# (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/profile-landing-embed.replay.test.ts, which sends the last request of each
# example. Node renders the page of a seller who lists nothing; the examples named "hands ..." are what stays in Rails.
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
end
