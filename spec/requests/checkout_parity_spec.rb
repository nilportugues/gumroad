# frozen_string_literal: true

require "spec_helper"

# CheckoutController#show (Checkout/Show), recorded for the Next.js port (PARITY_RECORD=1) through the full Rack
# stack. Replayed by nextjs/parity/__tests__/checkout.replay.test.ts, which sends the last request of each example.
#
# The port renders a page whose cart holds nothing and whose URL adds nothing; every other request is handed back
# to Rails, and the replay checks that it is. The examples under "handed back" record Rails' answer so a reader sees
# what the port declines.
describe "Checkout page", type: :request do
  include Parity::SignedInDashboard

  let(:fixture_geoip) { MaxMind::GeoIP2::Reader.new(database: Rails.root.join("nextjs/src/server/infra/__fixtures__/GeoLite2-City-Test.mmdb").to_s) }
  let(:guid) { "checkout-parity-guid" }
  let(:buyer) { create(:user, name: "Checkout Buyer", country: "Canada", state: "ON", street_address: "1 Main St", city: "Toronto", zip_code: "M5V 1A1") }

  before do
    stub_const("GEOIP", fixture_geoip)
    allow(GeoIp).to receive(:lookup).and_call_original
    allow(GlobalConfig).to receive(:get).and_call_original
    allow(GlobalConfig).to receive(:get).with("RECAPTCHA_MONEY_SITE_KEY").and_return("challenge-site-key")
    allow(GlobalConfig).to receive(:get).with("RECAPTCHA_MONEY_SCORE_SITE_KEY").and_return("score-site-key")
  end

  def inertia_visit(path, headers = {})
    get path, headers: { "X-Inertia" => "true", "X-Requested-With" => "XMLHttpRequest" }.merge(headers)
  end

  def from_ip(ip) = { "X-Forwarded-For" => ip }

  def props = inertia_props_of(response)

  describe "signed out" do
    it "renders an empty page for a visitor without a cart", parity: true do
      get checkout_path

      expect(response).to be_successful
      expect(props["cart"]).to be_nil
      expect(props["checkout"]["add_products"]).to eq([])
    end

    it "renders the page for a visitor whose guid has no cart", parity: true do
      cookies[:_gumroad_guid] = guid

      get checkout_path

      expect(props["cart"]).to be_nil
    end

    it "renders a guest cart that holds nothing", parity: true do
      create(:cart, :guest, browser_guid: guid, email: "guest@example.com", return_url: "https://example.com/back", reject_ppp_discount: true)
      cookies[:_gumroad_guid] = guid

      get checkout_path

      expect(props["cart"]).to include("email" => "guest@example.com", "returnUrl" => "https://example.com/back", "rejectPppDiscount" => true, "items" => [])
    end

    it "ignores a guest cart whose products were all removed", parity: true do
      cart = create(:cart, :guest, browser_guid: guid)
      create(:cart_product, cart:).mark_deleted!
      cookies[:_gumroad_guid] = guid

      get checkout_path

      expect(props["cart"]["items"]).to eq([])
    end

    it "ignores a deleted cart", parity: true do
      create(:cart, :guest, browser_guid: guid).mark_deleted!
      cookies[:_gumroad_guid] = guid

      get checkout_path

      expect(props["cart"]).to be_nil
    end

    it "names the buyer's country and US region from the GeoIP database", parity: true do
      get checkout_path, headers: from_ip("216.160.83.56")

      expect(props["checkout"]).to include("country" => "US", "state" => "WA")
    end

    it "names the country without a region outside the US and Canada", parity: true do
      get checkout_path, headers: from_ip("81.2.69.142")

      expect(props["checkout"]).to include("country" => "GB", "state" => nil)
    end

    it "leaves the country empty for an address the GeoIP database lacks", parity: true do
      get checkout_path, headers: from_ip("10.0.0.1")

      expect(props["checkout"]["country"]).to be_nil
    end

    it "offers the tip options an admin set", parity: true do
      TipOptionsService.set_tip_options([0, 5, 10])
      TipOptionsService.set_default_tip_option(5)

      get checkout_path

      expect(props["checkout"]).to include("tip_options" => [0, 5, 10], "default_tip_option" => 5)
    end

    it "falls back to the default tip options when the stored ones are not integers", parity: true do
      $redis.set(RedisKey.tip_options, [0, "x"].to_json)

      get checkout_path

      expect(props["checkout"]["tip_options"]).to eq(TipOptionsService::DEFAULT_TIP_OPTIONS)
    end

    it "answers an Inertia visit with the page props", parity: true do
      inertia_visit checkout_path

      expect(response.headers["X-Inertia"]).to eq("true")
    end

    it "answers a partial reload of the payment configuration", parity: true do
      inertia_visit checkout_path, "X-Inertia-Partial-Component" => "Checkout/Show", "X-Inertia-Partial-Data" => "checkout_payment"

      expect(response.parsed_body["props"].keys).to include("checkout_payment")
    end

    it "keeps the page for an unknown query parameter", parity: true do
      get checkout_path(foo: "bar")

      expect(response).to be_successful
    end
  end

  describe "signed in" do
    before { log_in(buyer) }

    it "prefills the address, country and region of the account", parity: true do
      get checkout_path

      expect(props["checkout"]).to include("country" => "CA", "state" => "ON", "address" => { "street" => "1 Main St", "zip" => "M5V 1A1", "city" => "Toronto" })
    end

    it "shows the saved card", parity: true do
      buyer.update!(credit_card: create(:indian_stripe_credit_card, card_country: "US"))

      get checkout_path

      expect(props["checkout"]["saved_credit_card"]).to include("type", "number", "expiration_date", "requires_mandate")
    end

    it "shows a saved card that requires a mandate", parity: true do
      buyer.update!(credit_card: create(:indian_stripe_credit_card))

      get checkout_path

      expect(props["checkout"]["saved_credit_card"]["requires_mandate"]).to eq(true)
    end

    it "shows no saved card when the saved payment method is PayPal", parity: true do
      buyer.update!(credit_card: create(:indian_stripe_credit_card, card_type: "paypal", visual: "buyer@example.com", expiry_month: nil, expiry_year: nil))

      get checkout_path

      expect(props["checkout"]["saved_credit_card"]).to be_nil
    end

    it "prefers the account's country over the detected one", parity: true do
      get checkout_path, headers: from_ip("216.160.83.56")

      expect(props["checkout"]).to include("country" => "CA", "state" => "ON")
    end

    it "uses the detected country for an account without one", parity: true do
      buyer.update_columns(country: nil, state: nil)

      get checkout_path, headers: from_ip("216.160.83.56")

      expect(props["checkout"]).to include("country" => "US", "state" => "WA")
    end

    it "renders the account's saved cart when it holds nothing", parity: true do
      create(:cart, user: buyer, email: nil)

      get checkout_path

      expect(props["cart"]).to include("email" => nil, "items" => [])
    end

    it "uses the challenge key outside the score cohort", parity: true do
      get checkout_path

      expect(props["checkout"]).to include("recaptcha_key" => "challenge-site-key", "recaptcha_score_based" => false, "recaptcha_challenge_key" => "challenge-site-key")
    end

    it "uses the score key for a buyer in the cohort", parity: true do
      Feature.activate_user(:recaptcha_score_checkout, buyer)

      get checkout_path

      expect(props["checkout"]).to include("recaptcha_key" => "score-site-key", "recaptcha_score_based" => true, "recaptcha_challenge_key" => "challenge-site-key")
    end

    it "uses the score key for everyone when the cohort flag is on globally", parity: true do
      Feature.activate(:recaptcha_score_checkout)

      get checkout_path

      expect(props["checkout"]["recaptcha_score_based"]).to eq(true)
    end
  end

  describe "the cart_id parameter" do
    let(:guest_cart) { create(:cart, :guest, browser_guid: "another-browser") }
    let(:cart_id) { guest_cart.secure_external_id(scope: "cart_login") }

    it "sends a signed-in buyer to their own cart", parity: true do
      log_in(buyer)

      get checkout_path(cart_id: "whatever", product: "abc")

      expect(response).to have_http_status(:found)
      expect(response.location).to include("/checkout?product=abc&referrer=")
    end

    it "sends a visitor with an unknown cart id to the page without it", parity: true do
      get checkout_path(cart_id: "not-a-cart-id")

      expect(response).to have_http_status(:found)
    end

    it "sends a visitor with the id of a deleted cart to the page without it", parity: true do
      guest_cart.mark_deleted!

      get checkout_path(cart_id:)

      expect(response).to have_http_status(:found)
    end

    it "sends a visitor with the id of a cart for another scope to the page without it", parity: true do
      get checkout_path(cart_id: guest_cart.secure_external_id(scope: "something_else"))

      expect(response).to have_http_status(:found)
    end

    it "asks a visitor to log in when the cart belongs to an account", parity: true do
      owned = create(:cart, user: buyer, browser_guid: "owner-browser")

      get checkout_path(cart_id: owned.secure_external_id(scope: "cart_login"))

      expect(response.location).to start_with(login_url(next: "x").split("?").first)
      expect(flash[:alert]).to eq("Please log in to complete checkout.")
    end

    it "redirects without merging when the visitor's browser already holds the cart", parity: true do
      cookies[:_gumroad_guid] = guest_cart.browser_guid

      get checkout_path(cart_id:)

      expect(response).to have_http_status(:found)
    end

    it "keeps the other query parameters", parity: true do
      get checkout_path(cart_id: "unknown", wishlist: "w1")

      expect(response.location).to include("wishlist=w1")
    end
  end

  describe "handed back to Rails" do
    let(:product) { create(:product, name: "Handed back") }

    it "merges the visitor's cart into the one the id names", parity: true do
      guest_cart = create(:cart, :guest, browser_guid: "another-browser")
      create(:cart_product, cart: guest_cart, product:)
      mine = create(:cart, :guest, browser_guid: guid)
      create(:cart_product, cart: mine, product: create(:product, name: "Mine"))
      cookies[:_gumroad_guid] = guid

      get checkout_path(cart_id: guest_cart.secure_external_id(scope: "cart_login"))

      expect(response).to have_http_status(:found)
      expect(guest_cart.reload.alive_cart_products.count).to eq(2)
    end

    it "renders a cart that holds a product", parity: true do
      cart = create(:cart, :guest, browser_guid: guid)
      create(:cart_product, cart:, product:)
      cookies[:_gumroad_guid] = guid

      get checkout_path

      expect(props["cart"]["items"].size).to eq(1)
    end

    it "renders a product added by the URL", parity: true do
      get checkout_path(product: product.unique_permalink)

      expect(props["checkout"]["add_products"].size).to eq(1)
    end

    it "renders a cart that holds a discount code", parity: true do
      create(:cart, :guest, browser_guid: guid, discount_codes: [{ "code" => "SAVE", "fromUrl" => false }])
      cookies[:_gumroad_guid] = guid

      get checkout_path

      expect(props["cart"]["discountCodes"].size).to eq(1)
    end

    it "renders the recommended products of a partial reload", parity: true do
      inertia_visit checkout_path, "X-Inertia-Partial-Component" => "Checkout/Show", "X-Inertia-Partial-Data" => "recommended_products"

      expect(response.parsed_body["props"].keys).to include("recommended_products")
    end
  end
end
