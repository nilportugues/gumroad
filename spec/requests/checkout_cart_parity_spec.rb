# frozen_string_literal: true

require "spec_helper"

# PATCH/PUT /checkout (CheckoutController#update, the cart save) for the plain lines Node saves
# (nextjs/src/server/controllers/checkout-cart-save.ts). Written for recording (PARITY_RECORD=1).
# Seeded carts are aged so a row Rails leaves alone is told apart from one it touches.
describe "Checkout cart save", type: :request do
  include Parity::AudienceSignedIn

  let(:guid) { "cart-save-guid" }

  let(:seller) { create(:user) }
  let(:product) { create(:product, user: seller, unique_permalink: "cartone", price_cents: 500) }
  let(:other_product) { create(:product, user: seller, unique_permalink: "carttwo", price_cents: 700) }
  let(:headers) do
    {
      "Accept" => "text/html, application/xhtml+xml",
      "X-Requested-With" => "XMLHttpRequest",
      "X-Inertia" => "true",
      "X-Inertia-Partial-Component" => "Checkout/Show",
      "X-Inertia-Partial-Data" => "cart, flash, checkout_payment, checkout_style",
      "Content-Type" => "application/json",
    }
  end

  before { host! DOMAIN }

  def item(record = product, **extra)
    { product: { id: record.external_id }, price: record.price_cents, quantity: 1, rent: false, referrer: "direct", url_parameters: {} }.merge(extra)
  end

  def cart_body(*items, **extra) = { cart: { discountCodes: [], items: }.merge(extra) }

  def save_cart(body, verb: :patch, signed_in: nil)
    cookies[:_gumroad_guid] = guid
    log_in(signed_in) if signed_in
    token = csrf_token
    public_send(verb, "/checkout", params: body.to_json, headers: headers.merge("X-CSRF-Token" => token))
  end

  def age(cart)
    cart.update_columns(created_at: 5.minutes.ago, updated_at: 5.minutes.ago)
    cart.cart_products.update_all(created_at: 5.minutes.ago, updated_at: 5.minutes.ago)
  end

  def seed_cart(user: nil, **attributes)
    attributes = { browser_guid: guid }.merge(attributes)
    cart = build(:cart, user:, ip_address: "127.0.0.1", **attributes)
    cart.save!
    yield cart if block_given?
    age(cart)
    cart
  end

  def seed_line(cart, record = product, **attributes)
    create(:cart_product, cart:, product: record, **attributes)
  end

  def expect_saved
    expect(response).to have_http_status(:see_other)
    expect(response).to redirect_to("/checkout")
  end

  def expect_alert(message)
    expect(response).to have_http_status(:see_other)
    expect(flash[:alert]).to eq(message)
  end

  describe "a guest" do
    it "saves a new cart with one line", parity: true do
      save_cart(cart_body(item, email: "guest@example.com", returnUrl: "https://example.com/back"))

      expect_saved
      expect(Cart.sole).to have_attributes(user_id: nil, browser_guid: guid, email: "guest@example.com", return_url: "https://example.com/back")
      expect(CartProduct.sole).to have_attributes(product_id: product.id, price: 500, quantity: 1, referrer: "direct")
    end

    it "saves a new cart with no lines", parity: true do
      save_cart(cart_body)

      expect_saved
      expect(Cart.sole.cart_products).to be_empty
    end

    it "saves two lines in the order they arrive", parity: true do
      save_cart(cart_body(item(other_product, quantity: 3), item))

      expect_saved
      expect(CartProduct.order(:id).pluck(:product_id)).to eq([other_product.id, product.id])
    end

    it "saves the optional fields of a line", parity: true do
      save_cart(cart_body(item(recurrence: "monthly", recommended_by: "gumroad_products_for_you", recommender_model_name: "sales", rent: true, referrer: "google.com", url_parameters: { utm_source: "google" }, price: 1250, quantity: 4)))

      expect_saved
      expect(CartProduct.sole).to have_attributes(recurrence: "monthly", rent: true, quantity: 4, price: 1250, url_parameters: { "utm_source" => "google" })
    end

    it "saves discount codes and the PPP rejection", parity: true do
      save_cart(cart_body(item, discountCodes: [{ code: "BLACKFRIDAY", fromUrl: false }, { code: "FROMLINK", fromUrl: true, extra: "dropped" }], rejectPppDiscount: true))

      expect_saved
      expect(Cart.sole).to have_attributes(reject_ppp_discount: true, discount_codes: [{ "code" => "BLACKFRIDAY", "fromUrl" => false }, { "code" => "FROMLINK", "fromUrl" => true }])
    end

    it "keeps an email only when it is not blank", parity: true do
      save_cart(cart_body(item, email: ""))

      expect_saved
      expect(Cart.sole.email).to be_nil
    end

    it "saves a line sent with a numeric price string and a blank rent", parity: true do
      save_cart(cart_body(item(price: "500", quantity: "2", rent: "")))

      expect_saved
      expect(CartProduct.sole).to have_attributes(price: 500, quantity: 2, rent: false)
    end

    it "saves through PUT", parity: true do
      save_cart(cart_body(item), verb: :put)

      expect_saved
      expect(CartProduct.sole.product_id).to eq(product.id)
    end

    it "saves a line for a variant", parity: true do
      tiered = create(:product_with_digital_versions, user: seller, unique_permalink: "carttier")
      option = tiered.alive_variants.first
      save_cart(cart_body(item(tiered, option_id: option.external_id, price: 300)))

      expect_saved
      expect(CartProduct.sole).to have_attributes(product_id: tiered.id, option_id: option.id)
    end

    it "updates the line it already has", parity: true do
      seed_cart { |cart| seed_line(cart) }
      save_cart(cart_body(item(quantity: 5, price: 600)))

      expect_saved
      expect(CartProduct.sole).to have_attributes(quantity: 5, price: 600)
    end

    it "leaves a cart alone when nothing changed", parity: true do
      seed_cart(email: "guest@example.com", return_url: "https://example.com") { |cart| seed_line(cart) }
      save_cart(cart_body(item, email: "guest@example.com", returnUrl: "https://example.com"))

      expect_saved
      expect(Cart.sole.updated_at).to be < 1.minute.ago
    end

    it "touches the cart only when the line changed", parity: true do
      seed_cart { |cart| seed_line(cart) }
      save_cart(cart_body(item(recommended_by: "search")))

      expect_saved
      expect(Cart.sole.updated_at).to be > 1.minute.ago
    end

    it "updates only the cart when the lines are the same", parity: true do
      seed_cart { |cart| seed_line(cart) }
      save_cart(cart_body(item, returnUrl: "https://example.com/new"))

      expect_saved
      expect(CartProduct.sole.updated_at).to be < 1.minute.ago
    end

    it "changes the discount codes of a cart", parity: true do
      seed_cart(discount_codes: [{ code: "OLD", fromUrl: false }]) { |cart| seed_line(cart) }
      save_cart(cart_body(item, discountCodes: [{ code: "NEW", fromUrl: true }]))

      expect_saved
      expect(Cart.sole.discount_codes).to eq([{ "code" => "NEW", "fromUrl" => true }])
    end

    it "clears the discount codes when none are sent", parity: true do
      seed_cart(discount_codes: [{ code: "OLD", fromUrl: false }]) { |cart| seed_line(cart) }
      save_cart({ cart: { items: [item] } })

      expect_saved
      expect(Cart.sole.discount_codes).to eq([])
    end

    it "soft deletes a line that is no longer sent", parity: true do
      seed_cart do |cart|
        seed_line(cart)
        seed_line(cart, other_product)
      end
      save_cart(cart_body(item))

      expect_saved
      expect(CartProduct.alive.sole.product_id).to eq(product.id)
      expect(CartProduct.deleted.sole.product_id).to eq(other_product.id)
    end

    it "soft deletes every line when the cart is emptied", parity: true do
      seed_cart do |cart|
        seed_line(cart)
        seed_line(cart, other_product)
      end
      save_cart(cart_body)

      expect_saved
      expect(CartProduct.alive).to be_empty
    end

    it "treats quantity 0 as a removal", parity: true do
      seed_cart do |cart|
        seed_line(cart)
        seed_line(cart, other_product)
      end
      save_cart(cart_body(item, item(other_product, quantity: 0)))

      expect_saved
      expect(CartProduct.alive.sole.product_id).to eq(product.id)
    end

    it "treats a string quantity of 0 as a removal and saves nothing for a new line", parity: true do
      save_cart(cart_body(item(quantity: "0")))

      expect_saved
      expect(CartProduct.count).to eq(0)
    end

    it "adds a line again after it was soft deleted", parity: true do
      seed_cart do |cart|
        seed_line(cart).update_columns(deleted_at: 1.hour.ago)
      end
      save_cart(cart_body(item))

      expect_saved
      expect(CartProduct.alive.sole.id).not_to eq(CartProduct.deleted.sole.id)
    end

    it "does not use another browser's cart", parity: true do
      other = build(:cart, :guest, browser_guid: "someone-else", ip_address: "127.0.0.1")
      other.save!
      seed_line(other)
      age(other)
      save_cart(cart_body(item))

      expect_saved
      expect(Cart.count).to eq(2)
    end

    it "does not reuse a deleted cart", parity: true do
      seed_cart.update_columns(deleted_at: 1.hour.ago)
      save_cart(cart_body(item))

      expect_saved
      expect(Cart.alive.sole.browser_guid).to eq(guid)
    end

    it "keeps the url parameters of a line that sends none", parity: true do
      seed_cart { |cart| seed_line(cart, url_parameters: { "utm_source" => "kept" }) }
      save_cart(cart_body(item.except(:url_parameters, :referrer)))

      expect_saved
      expect(CartProduct.sole).to have_attributes(url_parameters: { "utm_source" => "kept" }, referrer: "direct")
    end

    it "clears an accepted offer the line no longer carries", parity: true do
      seed_cart { |cart| seed_line(cart) }
      save_cart(cart_body(item(accepted_offer: {})))

      expect_saved
      expect(CartProduct.sole).to have_attributes(accepted_offer_id: nil, accepted_offer_details: {})
    end

    it "drops an affiliate the line no longer carries", parity: true do
      affiliate = create(:direct_affiliate, seller:)
      seed_cart { |cart| seed_line(cart, affiliate:) }
      save_cart(cart_body(item(affiliate_id: 0)))

      expect_saved
      expect(CartProduct.sole.affiliate_id).to be_nil
    end
  end

  describe "a signed-in buyer" do
    let(:buyer) { create(:user) }

    it "saves a new cart under the account email", parity: true do
      save_cart(cart_body(item, email: "ignored@example.com"), signed_in: buyer)

      expect_saved
      expect(Cart.sole).to have_attributes(user_id: buyer.id, email: buyer.email, browser_guid: guid)
    end

    it "updates the account's cart even when the browser has another guid", parity: true do
      seed_cart(user: buyer, browser_guid: "older-browser") { |cart| seed_line(cart) }
      save_cart(cart_body(item(quantity: 2)), signed_in: buyer)

      expect_saved
      expect(Cart.sole).to have_attributes(browser_guid: guid, email: buyer.email)
      expect(CartProduct.sole.quantity).to eq(2)
    end

    it "updates the oldest of an account's live carts", parity: true do
      first = seed_cart(user: buyer, browser_guid: "first-browser") { |cart| seed_line(cart) }
      second = build(:cart, user: buyer, browser_guid: "second-browser", ip_address: "127.0.0.1")
      second.save!(validate: false)
      age(second)
      save_cart(cart_body(item(quantity: 4)), signed_in: buyer)

      expect_saved
      expect(first.reload.browser_guid).to eq(guid)
      expect(second.reload.browser_guid).to eq("second-browser")
    end
  end

  describe "a request Rails refuses with an alert" do
    it "redirects a cart that is not an object", parity: true do
      save_cart({ cart: "foo" })

      expect_alert("Sorry, something went wrong. Please try again.")
      expect(Cart.count).to eq(0)
    end

    it "redirects a request without a cart", parity: true do
      save_cart({})

      expect_alert("Sorry, something went wrong. Please try again.")
    end

    it "refuses a cart above the product limit", parity: true do
      save_cart(cart_body(*Array.new(Cart::MAX_ALLOWED_CART_PRODUCTS + 1) { item }))

      expect_alert("You cannot add more than 50 products to the cart.")
      expect(Cart.count).to eq(0)
    end

    it "refuses a line without a product", parity: true do
      seed_cart { |cart| seed_line(cart) }
      save_cart(cart_body(item.except(:product)))

      expect_alert("A product in your cart is missing. Refresh the page and try again.")
      expect(CartProduct.alive.count).to eq(1)
    end

    it "refuses a line whose product id is blank", parity: true do
      save_cart(cart_body(item.merge(product: { id: "" })))

      expect_alert("A product in your cart is missing. Refresh the page and try again.")
    end
  end

  describe "a request Node hands to Rails" do
    it "hands a line for a product that does not exist", parity: true do
      save_cart(cart_body(item.merge(product: { id: "nothere==" })))

      expect(response).to have_http_status(:not_found)
    end

    it "hands a line with an invalid quantity", parity: true do
      save_cart(cart_body(item(quantity: -1)))

      expect_alert("Sorry, something went wrong. Please try again.")
    end

    it "hands a line with a quantity above the limit", parity: true do
      save_cart(cart_body(item(quantity: CartProduct::MAX_QUANTITY + 1)))

      expect_alert("Sorry, something went wrong. Please try again.")
    end

    it "hands a line with a fractional quantity", parity: true do
      save_cart(cart_body(item(quantity: 0.5)))

      expect_alert("Sorry, something went wrong. Please try again.")
    end

    it "hands a line with a word for a quantity", parity: true do
      save_cart(cart_body(item(quantity: "abc")))

      expect_alert("Sorry, something went wrong. Please try again.")
    end

    it "hands a line with a negative price", parity: true do
      save_cart(cart_body(item(price: -5)))

      expect_alert("Sorry, something went wrong. Please try again.")
    end

    it "hands a new line without a referrer", parity: true do
      save_cart(cart_body(item.except(:referrer)))

      expect_alert("Sorry, something went wrong. Please try again.")
    end

    it "hands a line with an affiliate", parity: true do
      affiliate = create(:direct_affiliate, seller:)
      save_cart(cart_body(item(affiliate_id: affiliate.external_id_numeric)))

      expect_saved
      expect(CartProduct.sole.affiliate_id).to eq(affiliate.id)
    end

    it "hands a line with an accepted offer", parity: true do
      offer = create(:upsell, product:, seller:)
      save_cart(cart_body(item(accepted_offer: { id: offer.external_id, original_product_id: product.external_id })))

      expect_saved
      expect(CartProduct.sole.accepted_offer_id).to eq(offer.id)
    end

    it "hands a line with a call start time", parity: true do
      save_cart(cart_body(item(call_start_time: 1.week.from_now.round.iso8601)))

      expect_saved
      expect(CartProduct.sole.call_start_time).to be_present
    end

    it "hands a line paid in installments", parity: true do
      create(:product_installment_plan, link: product)
      save_cart(cart_body(item(pay_in_installments: true)))

      expect_saved
      expect(CartProduct.sole.pay_in_installments).to be(true)
    end

    it "hands a cart with discount codes that fail the schema", parity: true do
      save_cart(cart_body(item, discountCodes: [{ code: "NOURL" }]))

      expect_alert("Sorry, something went wrong. Please try again.")
    end

    it "hands a line whose url parameters are not strings", parity: true do
      save_cart(cart_body(item(url_parameters: { count: 3 })))

      expect_alert("Sorry, something went wrong. Please try again.")
    end

    it "hands a browser with two live carts", parity: true do
      seed_cart { |cart| seed_line(cart) }
      twin = build(:cart, :guest, browser_guid: guid, ip_address: "127.0.0.1")
      twin.save!(validate: false)
      age(twin)
      save_cart(cart_body(item(quantity: 4)))

      expect_saved
      expect(Cart.alive.count).to eq(2)
    end

    it "hands a line for a variant that does not exist", parity: true do
      save_cart(cart_body(item(option_id: "nothere==")))

      expect_saved
      expect(CartProduct.sole.option_id).to be_nil
    end
  end
end
