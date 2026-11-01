# frozen_string_literal: true

require "spec_helper"

# LinksController#show: the public product page (Products/Show) on the Gumroad domain, which always
# redirects to the seller's host, on a seller subdomain and on a product's custom domain. Recorded for
# the Next.js port (PARITY_RECORD=1) through the full Rack stack. Replayed by
# nextjs/parity/__tests__/product-page.replay.test.ts, which sends the last request of each example.
describe "Product page", type: :request do
  include Parity::SignedInRequests

  let(:seller) { create(:named_seller, name: "Parity Seller", bio: "Makes things.", created_at: User::MIN_AGE_FOR_SERVICE_PRODUCTS.ago - 1.day) }
  let(:buyer) { create(:user, name: "Parity Buyer") }

  def seller_host!(user = seller)
    host! user.subdomain
  end

  def inertia_visit(path)
    get path, headers: { "X-Inertia" => "true", "X-Requested-With" => "XMLHttpRequest" }
  end

  describe "on the Gumroad domain" do
    let(:product) { create(:product, user: seller, name: "Redirected") }

    before { host! DOMAIN }

    it "redirects to the seller's subdomain", parity: true do
      get "/l/#{product.unique_permalink}"

      expect(response).to have_http_status(:moved_permanently)
    end

    it "keeps the query string and the offer code of the redirect", parity: true do
      get "/l/#{product.unique_permalink}/sxsw?recommended_by=search&variant=Large%20Size"

      expect(response).to have_http_status(:moved_permanently)
    end

    it "redirects a custom permalink to the general permalink", parity: true do
      product.update!(custom_permalink: "my-thing")

      get "/l/#{product.unique_permalink}"

      expect(response).to have_http_status(:moved_permanently)
    end

    it "is a 404 for an unknown permalink", parity: true do
      get "/l/does-not-exist"

      expect(response).to have_http_status(:not_found)
    end

    it "sets the affiliate cookie before redirecting", parity: true do
      affiliate = create(:direct_affiliate, seller:, products: [product])

      get "/l/#{product.unique_permalink}?affiliate_id=#{affiliate.external_id_numeric}"

      expect(response).to have_http_status(:moved_permanently)
      expect(set_cookies).to include(affiliate.cookie_key)
    end

    it "reads the short affiliate parameter", parity: true do
      affiliate = create(:direct_affiliate, seller:, products: [product])

      get "/l/#{product.unique_permalink}?a=#{affiliate.external_id_numeric}&recommended_by=search"

      expect(response).to have_http_status(:moved_permanently)
      expect(set_cookies).to include(affiliate.cookie_key)
    end

    it "sets no cookie for an unknown or deleted affiliate", parity: true do
      deleted = create(:direct_affiliate, seller:, products: [product], deleted_at: Time.current)

      get "/l/#{product.unique_permalink}?a=999999&affiliate_id=#{deleted.external_id_numeric}"

      expect(response).to have_http_status(:moved_permanently)
    end

    it "moves a code query parameter into the path", parity: true do
      get "/l/#{product.unique_permalink}?code=five"

      expect(response).to have_http_status(:moved_permanently)
      expect(response.headers["X-Robots-Tag"]).to include("noindex")
    end

    it "redirects a differently cased permalink to the stored one", parity: true do
      get "/l/#{product.unique_permalink.upcase}"

      expect(response).to have_http_status(:moved_permanently)
    end

    it "redirects the pre-coffee page of a coffee product", parity: true do
      coffee = create(:coffee_product, user: seller)

      get "/l/#{coffee.unique_permalink}?native=true&wanted=true"

      expect(response).to have_http_status(:moved_permanently)
    end

    it "is a 404 for a banned product", parity: true do
      product.update!(banned_at: Time.current)

      get "/l/#{product.unique_permalink}"

      expect(response).to have_http_status(:not_found)
    end

    it "is a 404 for a deleted product", parity: true do
      product.mark_deleted!

      get "/l/#{product.unique_permalink}"

      expect(response).to have_http_status(:not_found)
    end

    it "is a 404 for a product of a deleted seller", parity: true do
      product
      seller.update_columns(deleted_at: Time.current)

      get "/l/#{product.unique_permalink}"

      expect(response).to have_http_status(:moved_permanently).or have_http_status(:not_found)
    end

    it "serves a product found through its legacy permalink", parity: true do
      LegacyPermalink.create!(permalink: "old-name", product:)

      get "/l/old-name"

      expect(response).to have_http_status(:moved_permanently)
    end

    it "keeps the redirect for a signed-in visitor", parity: true do
      host! DOMAIN
      log_in(buyer, token_path: "/help")

      get "/l/#{product.unique_permalink}"

      expect(response).to have_http_status(:moved_permanently)
    end

    it "sends a coffee product to the custom domain coffee page", parity: true do
      coffee = create(:coffee_product, user: seller)

      get "/l/#{coffee.unique_permalink}"

      expect(response).to have_http_status(:moved_permanently)
    end
  end

  describe "on a seller subdomain" do
    before { seller_host! }

    it "renders a digital product", parity: true do
      product = create(:product_with_pdf_file, user: seller, name: "Digital thing", price_cents: 500)

      get "/l/#{product.unique_permalink}"

      expect(response).to be_successful
      expect(inertia_props_of(response)["product"]).to include("name" => "Digital thing", "price_cents" => 500)
    end

    it "renders a product by its custom permalink", parity: true do
      product = create(:product, user: seller, name: "Custom", custom_permalink: "custom-one")

      get "/l/custom-one"

      expect(response).to be_successful
      expect(inertia_props_of(response)["product"]["name"]).to eq("Custom")
    end

    it "renders a tiered membership with its tiers", parity: true do
      product = create(:membership_product_with_preset_tiered_pricing, user: seller, name: "Membership")

      get "/l/#{product.unique_permalink}"

      expect(response).to be_successful
      expect(inertia_props_of(response)["product"]["options"].size).to eq(2)
    end

    it "renders a membership with a free trial", parity: true do
      product = create(:membership_product, :with_free_trial_enabled, user: seller, name: "Trial membership")

      get "/l/#{product.unique_permalink}"

      expect(response).to be_successful
      expect(inertia_props_of(response)["product"]["free_trial"]).to be_present
    end

    it "renders a versioned product", parity: true do
      product = create(:product_with_digital_versions_with_price_difference_cents, user: seller, name: "Versions")

      get "/l/#{product.unique_permalink}"

      expect(response).to be_successful
      expect(inertia_props_of(response)["product"]["options"].size).to eq(2)
    end

    it "renders a physical product with SKUs", parity: true do
      product = create(:physical_product, user: seller, name: "Physical")

      get "/l/#{product.unique_permalink}"

      expect(response).to be_successful
      expect(inertia_props_of(response)["product"]["is_physical"]).to eq(true)
    end

    it "renders a bundle with its products", parity: true do
      product = create(:product, :bundle, user: seller)

      get "/l/#{product.unique_permalink}"

      expect(response).to be_successful
      expect(inertia_props_of(response)["product"]["bundle_products"].size).to eq(2)
    end

    it "renders a call product", parity: true do
      product = create(:call_product, :available_for_a_year, user: seller, name: "Call")

      get "/l/#{product.unique_permalink}"

      expect(response).to be_successful
      expect(inertia_props_of(response)["product"]["native_type"]).to eq("call")
    end

    it "renders a commission product", parity: true do
      product = create(:commission_product, user: seller, name: "Commission")

      get "/l/#{product.unique_permalink}"

      expect(response).to be_successful
      expect(inertia_props_of(response)["product"]["native_type"]).to eq("commission")
    end

    it "sends a coffee product to the coffee page", parity: true do
      product = create(:coffee_product, user: seller)

      get "/l/#{product.unique_permalink}?wanted=true"

      expect(response).to have_http_status(:found)
    end

    it "renders a preorder", parity: true do
      product = create(:product, user: seller, name: "Preorder")
      create(:preorder_link, link: product, release_at: 1.month.from_now)
      product.update!(is_in_preorder_state: true)

      get "/l/#{product.unique_permalink}"

      expect(response).to be_successful
      expect(inertia_props_of(response)["product"]["preorder"]).to be_present
    end

    it "renders a pay-what-you-want product", parity: true do
      product = create(:product, user: seller, name: "PWYW", price_cents: 0, customizable_price: true, suggested_price_cents: 300)

      get "/l/#{product.unique_permalink}"

      expect(response).to be_successful
      expect(inertia_props_of(response)["product"]["pwyw"]).to be_present
    end

    it "renders an unpublished product with a noindex header", parity: true do
      product = create(:product, :unpublished, user: seller, name: "Draft")

      get "/l/#{product.unique_permalink}"

      expect(response).to be_successful
      expect(response.headers["X-Robots-Tag"]).to include("noindex")
    end

    it "renders a deleted product with a noindex header", parity: true do
      product = create(:product, user: seller, name: "Deleted")
      product.mark_deleted!

      get "/l/#{product.unique_permalink}"
    end

    it "renders an adult product", parity: true do
      product = create(:product, user: seller, name: "Adult", is_adult: true)

      get "/l/#{product.unique_permalink}"

      expect(response).to be_successful
    end

    it "is a 404 for a banned product", parity: true do
      product = create(:product, user: seller)
      product.update!(banned_at: Time.current)

      get "/l/#{product.unique_permalink}"

      expect(response).to have_http_status(:not_found)
    end

    it "is a 404 for a product of a deleted seller", parity: true do
      product = create(:product, user: seller)
      seller.update_columns(deleted_at: Time.current)

      get "/l/#{product.unique_permalink}"

      expect(response).to have_http_status(:not_found)
    end

    it "shows the ratings and the sales count", parity: true do
      product = create(:product, user: seller, name: "Rated", price_cents: 0, should_show_sales_count: true)
      purchase = create(:free_purchase, link: product)
      create(:product_review, purchase:, rating: 4)

      get "/l/#{product.unique_permalink}"

      expect(response).to be_successful
      expect(inertia_props_of(response)["product"]["ratings"]).to be_present
    end

    it "shows a limited quantity remaining", parity: true do
      product = create(:product, user: seller, name: "Limited", price_cents: 0, max_purchase_count: 10)
      create(:free_purchase, link: product)

      get "/l/#{product.unique_permalink}"

      expect(response).to be_successful
      expect(inertia_props_of(response)["product"]["quantity_remaining"]).to eq(9)
    end

    it "shows the product's refund policy", parity: true do
      product = create(:product, user: seller, name: "Refundable")
      product.update!(product_refund_policy_enabled: true)
      product.find_or_initialize_product_refund_policy.update!(max_refund_period_in_days: 14, fine_print: "No refunds on tuesdays")

      get "/l/#{product.unique_permalink}"

      expect(response).to be_successful
    end

    it "applies the offer code of the path", parity: true do
      product = create(:product, user: seller, name: "Discounted", price_cents: 1000)
      create(:offer_code, user: seller, products: [product], code: "half", amount_cents: nil, amount_percentage: 50)

      get "/l/#{product.unique_permalink}/half"

      expect(response).to be_successful
      expect(inertia_props_of(response)["discount_code"]).to include("valid" => true)
    end

    it "applies the code query parameter", parity: true do
      product = create(:product, user: seller, name: "Discounted", price_cents: 1000)
      create(:offer_code, user: seller, products: [product], code: "five", amount_cents: 500)

      get "/l/#{product.unique_permalink}?code=five&quantity=2"

      expect(response).to be_successful
      expect(inertia_props_of(response)["discount_code"]).to include("valid" => true)
    end

    it "reports an invalid code", parity: true do
      product = create(:product, user: seller)

      get "/l/#{product.unique_permalink}?code=nope"

      expect(response).to be_successful
      expect(inertia_props_of(response)["discount_code"]).to include("valid" => false)
    end

    it "shows the seller's auto-applied sale", parity: true do
      product = create(:product, user: seller, name: "On sale", price_cents: 1000)
      create(:universal_offer_code, user: seller, code: "sale", amount_cents: nil, amount_percentage: 20, auto_apply: true, sale_label: "Spring sale")

      get "/l/#{product.unique_permalink}"

      expect(response).to be_successful
    end

    it "sets the affiliate cookie of an affiliate_id", parity: true do
      product = create(:product, user: seller)
      affiliate = create(:direct_affiliate, seller:, products: [product])

      get "/l/#{product.unique_permalink}?affiliate_id=#{affiliate.external_id_numeric}"

      expect(response).to be_successful
      expect(set_cookies).to include(affiliate.cookie_key)
    end

    it "ignores an unknown affiliate", parity: true do
      product = create(:product, user: seller)

      get "/l/#{product.unique_permalink}?a=999999"

      expect(response).to be_successful
    end

    it "marks a code URL as noindex", parity: true do
      product = create(:product, user: seller)

      get "/l/#{product.unique_permalink}/anything"

      expect(response.headers["X-Robots-Tag"]).to include("noindex")
    end

    it "redirects ?wanted=true to checkout", parity: true do
      product = create(:product, user: seller, price_cents: 700)

      get "/l/#{product.unique_permalink}?wanted=true"

      expect(response).to have_http_status(:found)
    end

    it "renders the iframe layout for embeds", parity: true do
      product = create(:product, user: seller)

      get "/l/#{product.unique_permalink}?embed=true"

      expect(response).to be_successful
    end

    it "renders the profile layout", parity: true do
      product = create(:product, user: seller)

      get "/l/#{product.unique_permalink}?layout=profile"

      expect(response).to be_successful
    end

    it "answers an Inertia visit with the page as JSON", parity: true do
      product = create(:product, user: seller, name: "Inertia")

      inertia_visit "/l/#{product.unique_permalink}"

      expect(response).to be_successful
      expect(response.parsed_body["component"]).to eq("Products/Show")
    end

    it "answers the public JSON API", parity: true do
      product = create(:product, user: seller, name: "Json")

      get "/l/#{product.unique_permalink}.json"

      expect(response).to be_successful
    end
  end

  describe "on a product's custom domain" do
    it "renders the product at the root", parity: true do
      product = create(:product, user: seller, name: "Own domain")
      create(:custom_domain, domain: "product.example.com", user: nil, product:)
      host! "product.example.com"

      get "/"

      expect(response).to be_successful
      expect(inertia_props_of(response)["product"]["name"]).to eq("Own domain")
    end

    it "renders the product by its permalink", parity: true do
      product = create(:product, user: seller, name: "Own domain")
      create(:custom_domain, domain: "product.example.com", user: nil, product:)
      host! "product.example.com"

      get "/#{product.unique_permalink}"

      expect(response).to be_successful
    end
  end

  describe "signed in" do
    before { create(:product, user: seller, name: "Warm") }

    it "shows a buyer the product they own", parity: true do
      product = create(:product, user: seller, name: "Owned", price_cents: 0)
      create(:free_purchase, link: product, purchaser: buyer, email: buyer.email)
      host! DOMAIN
      log_in(buyer, token_path: "/help")
      seller_host!

      get "/l/#{product.unique_permalink}"

      expect(response).to be_successful
      expect(inertia_props_of(response)["purchase"]).to be_present
    end

    it "shows the seller their own product with the edit controls", parity: true do
      product = create(:product, user: seller, name: "Mine")
      host! DOMAIN
      log_in(seller, token_path: "/help")
      seller_host!

      get "/l/#{product.unique_permalink}"

      expect(response).to be_successful
      expect(inertia_props_of(response)["product"]["can_edit"]).to eq(true)
    end
  end
end
