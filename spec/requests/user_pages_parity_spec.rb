# frozen_string_literal: true

require "spec_helper"

# A seller's slugged pages (UserPagesController: #show, #landing_iframe_content, #landing_version) on the seller's own host, recorded for the
# Next.js port (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/user-pages.replay.test.ts, which sends the last request of each
# example. The examples named "hands ..." are what stays in Rails.
describe "Seller pages", type: :request do
  include Parity::AudienceSignedIn

  let(:seller) { create(:named_seller, name: "Pages Seller", bio: "Bio of <i>the</i> seller") }
  let(:custom_html) { "<section><h1 data-gumroad-field=\"name\">x</h1><p data-gumroad-field=\"bio\">y</p></section>" }

  def create_page(slug: "studio", title: "Studio", **attributes)
    create(:user_page, pageable: seller, slug:, title:, **attributes).tap do |page|
      page.update_columns(updated_at: Time.utc(2025, 3, 4, 5, 6, 7))
    end
  end

  def sign_in_as_owner
    host! DOMAIN
    log_in(seller)
    host! seller.subdomain
  end

  describe "GET /:slug" do
    it "renders a rich text page", parity: true do
      create_page(slug: "about", title: "About", content: "<p>Hello there</p>")
      host! seller.subdomain

      get "/about"

      expect(response).to have_http_status(:ok)
      expect(response.body).to include("<p>Hello there</p>")
      expect(response.body).to include("<title>About — Pages Seller</title>")
      expect(response.headers["X-Robots-Tag"]).to eq("noindex")
    end

    it "renders a rich text page on the verified custom domain", parity: true do
      create(:custom_domain, :verified_with_certificate, user: seller, domain: "pages-seller.example.com")
      create_page(slug: "about", title: "About", content: "<p>Hello there</p>")
      host! "pages-seller.example.com"

      get "/about"

      expect(response).to have_http_status(:ok)
      expect(response.body).to include('<a href="/">Pages Seller</a>')
    end

    it "renders a rich text page of a compliant seller without the noindex header", parity: true do
      seller.update_columns(user_risk_state: "compliant")
      create_page(slug: "about", title: "About", content: "<p>Hello there</p>")
      host! seller.subdomain

      get "/about"

      expect(response).to have_http_status(:ok)
      expect(response.headers["X-Robots-Tag"]).to be_nil
    end

    it "uses the seller's SEO title and description", parity: true do
      create_page(slug: "about", title: "About", content: "<p>Hi</p>", seo_title: "About Jane's studio", seo_description: "Hand-lettered posters & prints.")
      host! seller.subdomain

      get "/about"

      expect(response.body).to include("<title>About Jane&#39;s studio</title>")
      expect(response.body).to include(%(name="description" content="Hand-lettered posters &amp; prints."))
    end

    it "does not repeat the store name when the title already ends with it", parity: true do
      create_page(slug: "about", title: "About | pages seller", content: "<p>Hi</p>")
      host! seller.subdomain

      get "/about"

      expect(response.body).to include("<title>About | pages seller</title>")
    end

    it "escapes markup in the title and the seller's name", parity: true do
      seller.update_columns(name: "Q&A <Shop>")
      create_page(slug: "about", title: "Notes <b>1</b> & more", content: "<p>Hi</p>")
      host! seller.subdomain

      get "/about"

      expect(response.body).to include("Notes &lt;b&gt;1&lt;/b&gt; &amp; more")
    end

    it "names the page after the username for a seller without a name", parity: true do
      seller.update_columns(name: nil)
      create_page(slug: "about", title: "About", content: "<p>Hi</p>")
      host! seller.subdomain

      get "/about"

      expect(response).to have_http_status(:ok)
    end

    it "renders the sandboxed wrapper of a custom HTML page", parity: true do
      create_page(custom_html:)
      Feature.activate_user(:custom_html_pages, seller)
      host! seller.subdomain

      get "/studio"

      expect(response).to have_http_status(:ok)
      expect(response.body).to include(%(src="/studio/landing/embed"))
      expect(response.body).not_to include("live-reload")
    end

    it "renders the wrapper while the custom HTML feature is off", parity: true do
      create_page(custom_html:)
      host! seller.subdomain

      get "/studio"

      expect(response).to have_http_status(:ok)
    end

    it "renders the wrapper on the custom domain with the seller's theme background", parity: true do
      create(:custom_domain, :verified_with_certificate, user: seller, domain: "pages-seller.example.com")
      create(:seller_profile, seller:).update_columns(background_color: "#112233")
      create_page(custom_html:, seo_title: "Studio sessions", seo_description: "Book a studio session.")
      host! "pages-seller.example.com"

      get "/studio"

      expect(response.body).to include("html{background:#112233}")
      expect(response.body).to include(%(<title>Studio sessions</title>))
    end

    it "leaves the theme background out when the stored colour is not a hex colour", parity: true do
      create(:seller_profile, seller:).update_columns(background_color: "red")
      create_page(custom_html:)
      host! seller.subdomain

      get "/studio"

      expect(response.body).not_to include("html{background:")
    end

    it "adds the live reload script for the owner", parity: true do
      create_page(custom_html:)
      sign_in_as_owner

      get "/studio"

      expect(response).to have_http_status(:ok)
      expect(response.body).to include("/studio/landing/version")
    end

    it "hands a rich text page of a seller with an avatar to Rails", parity: true do
      seller.avatar.attach(io: File.open(Rails.root.join("spec", "support", "fixtures", "smilie.png")), filename: "smilie.png", content_type: "image/png")
      create_page(slug: "about", title: "About", content: "<p>Hello there</p>")
      host! seller.subdomain

      get "/about"

      expect(response).to have_http_status(:ok)
      expect(response.body).to include("og:image")
    end

    it "answers 404 to a slug nobody owns", parity: true do
      host! seller.subdomain

      get "/nope"

      expect(response).to have_http_status(:not_found)
    end
  end

  describe "GET /:slug/landing/embed" do
    it "renders the page with the strict CSP", parity: true do
      create_page(custom_html:)
      host! seller.subdomain

      get "/studio/landing/embed"

      expect(response).to have_http_status(:ok)
      expect(response.headers["Content-Security-Policy"]).to eq(RendersCustomHtmlPages::CUSTOM_HTML_CSP)
      expect(response.headers["X-Frame-Options"]).to eq("SAMEORIGIN")
      expect(response.headers["X-Robots-Tag"]).to eq("noindex")
      expect(response.body).to include("Pages Seller")
    end

    it "renders the page while the custom HTML feature is off", parity: true do
      create_page(custom_html:)
      host! seller.subdomain

      get "/studio/landing/embed"

      expect(response).to have_http_status(:ok)
    end

    it "allows the verified custom domain in the navigation bridge", parity: true do
      create(:custom_domain, :verified_with_certificate, user: seller, domain: "pages-seller.example.com")
      create_page(custom_html:)
      host! "pages-seller.example.com"

      get "/studio/landing/embed"

      expect(response.body).to include("pages-seller.example.com")
    end

    it "adds the Tailwind v3 shim for a page that loads its CDN", parity: true do
      create_page(custom_html: "<script src=\"https://cdn.tailwindcss.com\"></script><div class=\"bg-gradient-to-r from-red-500\">x</div>")
      host! seller.subdomain

      get "/studio/landing/embed"

      expect(response.body).to include("@property --tw-gradient-from")
    end

    it "leaves product price fields as written", parity: true do
      create_page(custom_html: "<span data-gumroad-product=\"abc\" data-gumroad-field=\"price\">$1</span><span data-gumroad-field=\"name\">x</span>")
      host! seller.subdomain

      get "/studio/landing/embed"

      expect(response.body).to include(">$1</span>")
    end

    it "answers an empty not found for a rich text page", parity: true do
      create_page(slug: "about", title: "About", content: "<p>Hi</p>")
      host! seller.subdomain

      get "/about/landing/embed"

      expect(response).to have_http_status(:not_found)
      expect(response.body).to be_blank
    end

    it "answers 404 to a slug nobody owns", parity: true do
      host! seller.subdomain

      get "/nope/landing/embed"

      expect(response).to have_http_status(:not_found)
    end
  end

  describe "GET /:slug/landing/version" do
    it "reports the version to the owner", parity: true do
      create_page(custom_html:)
      sign_in_as_owner

      get "/studio/landing/version"

      expect(response.parsed_body).to eq("present" => true, "version" => Time.utc(2025, 3, 4, 5, 6, 7).to_i)
    end

    it "reports nothing to a visitor", parity: true do
      create_page(custom_html:)
      host! seller.subdomain

      get "/studio/landing/version"

      expect(response.parsed_body).to eq("present" => false, "version" => nil)
    end

    it "reports nothing to the owner for a rich text page", parity: true do
      create_page(slug: "about", title: "About", content: "<p>Hi</p>")
      sign_in_as_owner

      get "/about/landing/version"

      expect(response.parsed_body).to eq("present" => false, "version" => nil)
    end

    it "answers 404 to a slug nobody owns", parity: true do
      host! seller.subdomain

      get "/nope/landing/version"

      expect(response).to have_http_status(:not_found)
    end
  end
end
