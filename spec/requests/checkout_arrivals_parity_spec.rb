# frozen_string_literal: true

require "spec_helper"

# What a URL puts on the checkout page (CheckoutController#show with `?product=`, `?wishlist=`, `?gift_wishlist_product=` and
# `accepted_offer_id`), recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/checkout-arrivals.replay.test.ts, which sends the last request of each example. The cart of every
# example holds nothing; a cart with lines is still handed back (checkout_parity_spec.rb). The examples whose name starts with
# "hands a" record the pages Node declines because its answer depends on code that is not ported.
describe "Checkout page arrivals", type: :request do
  include Parity::SignedInDashboard

  let(:fixture_geoip) { MaxMind::GeoIP2::Reader.new(database: Rails.root.join("nextjs/src/server/infra/__fixtures__/GeoLite2-City-Test.mmdb").to_s) }
  let(:seller) { create(:named_seller, name: "Arrival Seller", created_at: Time.utc(2025, 1, 1)) }
  let(:buyer) { create(:user, name: "Arrival Buyer", country: "Canada", state: "ON", street_address: "1 Main St", city: "Toronto", zip_code: "M5V 1A1") }
  let(:product) { create(:product, user: seller, name: "Arrival course", price_cents: 1500, created_at: Time.utc(2025, 1, 2)) }
  let(:gb_ip) { "81.2.69.142" }

  before do
    stub_const("GEOIP", fixture_geoip)
    allow(GeoIp).to receive(:lookup).and_call_original
    allow(GlobalConfig).to receive(:get).and_call_original
    allow(GlobalConfig).to receive(:get).with("RECAPTCHA_MONEY_SITE_KEY").and_return("challenge-site-key")
    allow(GlobalConfig).to receive(:get).with("RECAPTCHA_MONEY_SCORE_SITE_KEY").and_return("score-site-key")
  end

  def props = inertia_props_of(response)
  def added = props["checkout"]["add_products"]
  def payment = props["checkout_payment"]
  def from_ip(ip) = { "X-Forwarded-For" => ip }

  def inertia_visit(path, headers = {})
    get path, headers: { "X-Inertia" => "true", "X-Requested-With" => "XMLHttpRequest" }.merge(headers)
  end

  describe "?product=" do
    it "puts the product on the page for a visitor", parity: true do
      get checkout_path(product: product.unique_permalink)

      expect(added.sole["product"]).to include("name" => "Arrival course", "price_cents" => 1500)
      expect(payment).to include("integration" => "card_element", "fallback_reason" => "stripe_payment_element_flag_disabled")
    end

    it "reads the product by the custom permalink of the seller named in the URL", parity: true do
      product.update!(custom_permalink: "my-course")

      get checkout_path(username: seller.username, product: "my-course")

      expect(added.sole["product"]["permalink"]).to eq(product.unique_permalink)
    end

    it "adds nothing for a permalink no product has", parity: true do
      get checkout_path(product: "nothing-here")

      expect(added).to eq([])
      expect(payment["fallback_reason"]).to eq("empty_cart")
    end

    it "adds nothing for an empty product parameter", parity: true do
      get checkout_path(product: "")

      expect(added).to eq([])
    end

    it "reads the product by its permalink when the username names nobody", parity: true do
      get checkout_path(username: "nobody", product: product.unique_permalink)

      expect(added.sole["product"]["name"]).to eq("Arrival course")
    end

    it "puts a deleted product on the page like any other", parity: true do
      product.mark_deleted!

      get checkout_path(product: product.unique_permalink)

      expect(added.sole["product"]["name"]).to eq("Arrival course")
    end

    it "selects the version and quantity named in the URL", parity: true do
      versioned = create(:product_with_digital_versions, user: seller, name: "Versioned", quantity_enabled: true, created_at: Time.utc(2025, 1, 3))
      second = versioned.alive_variants.second

      get checkout_path(product: versioned.unique_permalink, option: second.external_id, quantity: "3")

      expect(added.sole).to include("option_id" => second.external_id, "quantity" => 3)
    end

    it "falls back to the first version that is not sold out when the option is unknown", parity: true do
      versioned = create(:product_with_digital_versions, user: seller, name: "Versioned", created_at: Time.utc(2025, 1, 3))

      get checkout_path(product: versioned.unique_permalink, option: "unknown")

      expect(added.sole["option_id"]).to eq(versioned.alive_variants.first.external_id)
    end

    it "reads a price the buyer names on a pay-what-you-want product", parity: true do
      product.update!(customizable_price: true, suggested_price_cents: 2000)

      get checkout_path(product: product.unique_permalink, price: "2500")

      expect(added.sole).to include("price" => 2500)
    end

    it "keeps the listed price when a price is named on a fixed-price product", parity: true do
      get checkout_path(product: product.unique_permalink, price: "5")

      expect(added.sole["price"]).to eq(1500)
    end

    it "keeps the listed price when the named price is below it", parity: true do
      product.update!(customizable_price: true)

      get checkout_path(product: product.unique_permalink, price: "100")

      expect(added.sole["price"]).to eq(1500)
    end

    it "rents a product that can be rented when asked to", parity: true do
      film = create(:product, user: seller, name: "Film", price_cents: 1500, purchase_type: :buy_and_rent, rental_price_cents: 400, created_at: Time.utc(2025, 1, 3))

      get checkout_path(product: film.unique_permalink, rent: "true")

      expect(added.sole).to include("rent" => true, "price" => 400)
    end

    it "treats any rent value as a request to rent, even one that reads false", parity: true do
      film = create(:product, user: seller, name: "Film", price_cents: 1500, purchase_type: :buy_and_rent, rental_price_cents: 400, created_at: Time.utc(2025, 1, 3))

      get checkout_path(product: film.unique_permalink, rent: "false")

      expect(added.sole).to include("rent" => true, "price" => 400)
    end

    it "does not rent a product that is only for sale", parity: true do
      get checkout_path(product: product.unique_permalink, rent: "true")

      expect(added.sole).to include("rent" => false, "price" => 1500)
    end

    it "does not rent when the rent key has no value", parity: true do
      film = create(:product, user: seller, name: "Film", price_cents: 1500, purchase_type: :buy_and_rent, rental_price_cents: 400, created_at: Time.utc(2025, 1, 3))

      get "#{checkout_path}?product=#{film.unique_permalink}&rent"

      expect(added.sole).to include("rent" => false)
    end

    it "carries the affiliate and recommender into the product and the creator's profile link", parity: true do
      get checkout_path(product: product.unique_permalink, affiliate_id: "123", recommended_by: "search results", recommender_model_name: "sample_model")

      expect(added.sole).to include("affiliate_id" => "123", "recommended_by" => "search results", "recommender_model_name" => "sample_model")
      expect(added.sole["product"]["creator"]["profile_url"]).to include("recommended_by=search+results")
    end

    it "selects the tier named in the URL for a membership and falls back to the recurrence it offers", parity: true do
      membership = create(:membership_product_with_preset_tiered_pricing, user: seller, name: "Club", created_at: Time.utc(2025, 1, 3))

      get checkout_path(product: membership.unique_permalink, recurrence: "yearly", option: membership.alive_variants.second.external_id)

      expect(added.sole).to include("recurrence" => "monthly", "price" => 500, "option_id" => membership.alive_variants.second.external_id)
      expect(added.sole["restart_intent"]).to be_present
    end

    it "puts a legacy subscription at its default recurrence", parity: true do
      subscription = create(:subscription_product, user: seller, name: "Legacy", price_cents: 700, created_at: Time.utc(2025, 1, 3))

      get checkout_path(product: subscription.unique_permalink)

      expect(added.sole).to include("price" => 700, "recurrence" => "monthly")
    end

    it "keeps the time named for a call product", parity: true do
      call = create(:call_product, :available_for_a_year, user: seller, name: "Office hours", created_at: Time.utc(2025, 1, 3))

      get checkout_path(product: call.unique_permalink, call_start_time: "next tuesday at ten")

      expect(added.sole["call_start_time"]).to eq("next tuesday at ten")
    end

    it "ignores a start time on a product that is not a call", parity: true do
      get checkout_path(product: product.unique_permalink, call_start_time: "next tuesday at ten")

      expect(added.sole["call_start_time"]).to be_nil
    end

    it "offers to pay in installments when the product has a plan", parity: true do
      create(:product_installment_plan, link: product, number_of_installments: 3)

      get checkout_path(product: product.unique_permalink, pay_in_installments: "true")

      expect(added.sole["pay_in_installments"]).to eq(true)
    end

    it "does not offer to pay in installments without a plan", parity: true do
      get checkout_path(product: product.unique_permalink, pay_in_installments: "true")

      expect(added.sole["pay_in_installments"]).to eq(false)
    end

    it "lists the cross-sells of the product", parity: true do
      offered = create(:product, user: seller, name: "Extra", price_cents: 500, created_at: Time.utc(2025, 1, 1))
      code = create(:offer_code, user: seller, products: [offered], amount_cents: nil, amount_percentage: 20, code: "XSELL")
      create(:upsell, seller:, product: offered, name: "Add", cross_sell: true, selected_products: [product], offer_code: code)

      get checkout_path(product: product.unique_permalink)

      expect(added.sole["product"]["cross_sells"].sole["discount"]).to include("percents" => 20)
    end

    it "shows the seller's theme when every product on the page is theirs", parity: true do
      seller.seller_profile.update!(highlight_color: "#112233", background_color: "#fafafa", font: "Inter", border_radius: "large")

      get checkout_path(product: product.unique_permalink)

      expect(props["checkout_style"]).to include("seller_id" => seller.external_id)
      expect(props["checkout_style"]["theme"]).to include("accent_color" => "#112233", "border_radius" => "1rem")
    end

    it "shows the theme of a seller whose accent colour is lost on their background", parity: true do
      seller.seller_profile.update!(highlight_color: "#fafafa", background_color: "#ffffff")

      get checkout_path(product: product.unique_permalink)

      expect(props["checkout_style"]["theme"]["indicator_color"]).not_to eq("#fafafa")
    end

    it "keeps the saved cart that holds nothing beside the product", parity: true do
      create(:cart, :guest, browser_guid: "arrivals-guid", email: "guest@example.com")
      cookies[:_gumroad_guid] = "arrivals-guid"

      get checkout_path(product: product.unique_permalink)

      expect(props["cart"]).to include("email" => "guest@example.com", "items" => [])
      expect(added.size).to eq(1)
    end

    it "prices the product for the visitor's country when the seller offers purchasing power parity", parity: true do
      seller.update!(purchasing_power_parity_enabled: true, purchasing_power_parity_limit: 40)
      PurchasingPowerParityService.new.set_factor("GB", 0.6)
      cheap = create(:product, user: seller, name: "Cheap", price_cents: 150, created_at: Time.utc(2025, 1, 3))

      get checkout_path(product: cheap.unique_permalink), headers: from_ip(gb_ip)

      expect(added.sole["product"]["ppp_details"]).to include("country" => "United Kingdom", "factor" => 0.6, "minimum_price" => 99)
      expect(added.sole["price"]).to eq(150)
    end

    it "shows no purchasing power parity to a visitor from a country without a discount", parity: true do
      seller.update!(purchasing_power_parity_enabled: true, purchasing_power_parity_limit: 10)

      get checkout_path(product: product.unique_permalink), headers: from_ip(gb_ip)

      expect(added.sole["product"]["ppp_details"]).to be_nil
    end
  end

  describe "the payment configuration" do
    before { Feature.activate_user(:stripe_payment_element_checkout, seller) }

    it "mounts the payment element for a paid product when the seller is on it", parity: true do
      get checkout_path(product: product.unique_permalink)

      expect(payment).to include("integration" => "payment_element", "fallback_reason" => nil)
      expect(payment["elements_options"]).to include("stripe_elements_mode" => "payment", "stripe_link_enabled" => true)
    end

    it "mounts the payment element for a pay-what-you-want product that starts at zero", parity: true do
      product.update!(price_cents: 0, customizable_price: true)

      get checkout_path(product: product.unique_permalink)

      expect(payment).to include("integration" => "payment_element")
    end

    it "mounts the element in setup mode for a free trial of a paid membership", parity: true do
      trial = create(:membership_product, :with_free_trial_enabled, user: seller, name: "Trial", created_at: Time.utc(2025, 1, 3))

      get checkout_path(product: trial.unique_permalink)

      expect(payment["elements_options"]).to include("stripe_elements_mode" => "setup")
    end

    it "turns the element's wallets and the rollout flags on for the seller", parity: true do
      Feature.activate_user(:payment_element_wallets, seller)
      Feature.activate_user(:apple_pay_merchant_tokens, seller)

      get checkout_path(product: product.unique_permalink)

      expect(payment).to include("payment_element_wallets" => true, "flat_payment_methods" => true, "request_apple_pay_merchant_tokens" => true)
    end

    it "leaves Link off when the seller switched it off", parity: true do
      seller.update!(link_disabled: true)

      get checkout_path(product: product.unique_permalink)

      expect(payment["elements_options"]["stripe_link_enabled"]).to eq(false)
    end

    it "leaves Link off for a purchasing power parity discount that is verified", parity: true do
      seller.update!(purchasing_power_parity_enabled: true, purchasing_power_parity_limit: 40)
      PurchasingPowerParityService.new.set_factor("GB", 0.6)
      cheap = create(:product, user: seller, name: "Cheap", price_cents: 1000, created_at: Time.utc(2025, 1, 3))

      get checkout_path(product: cheap.unique_permalink), headers: from_ip(gb_ip)

      expect(payment["elements_options"]["stripe_link_enabled"]).to eq(false)
    end

    it "keeps the card element when the seller is not on the payment element", parity: true do
      Feature.deactivate_user(:stripe_payment_element_checkout, seller)

      get checkout_path(product: product.unique_permalink)

      expect(payment["fallback_reason"]).to eq("stripe_payment_element_flag_disabled")
    end

    it "hands a seller without a username to Rails", parity: true do
      nameless = create(:user)
      nameless.update_columns(username: nil)
      stray = create(:product, user: nameless, name: "Stray", created_at: Time.utc(2025, 1, 3))

      get checkout_path(product: stray.unique_permalink)

      expect(added.sole["product"]["creator"]["profile_url"]).to be_present
    end

    it "hands a seller on the client-confirm payment element to Rails", parity: true do
      Feature.activate_user(:stripe_payment_element_client_confirm, seller)

      get checkout_path(product: product.unique_permalink)

      expect(payment["integration"]).to be_present
    end

    it "hands a seller on india card mandate reliability to Rails", parity: true do
      Feature.activate_user(:india_card_mandate_reliability, seller)

      get checkout_path(product: product.unique_permalink)

      expect(payment["integration"]).to be_present
    end
  end

  describe "an upsell the buyer accepted" do
    let(:variant_product) { create(:product_with_digital_versions, user: seller, name: "Versioned", price_cents: 2000, created_at: Time.utc(2025, 1, 3)) }
    let(:cross_sell) do
      code = create(:offer_code, user: seller, products: [variant_product], amount_cents: nil, amount_percentage: 25, code: "ACCEPT")
      create(:upsell, seller:, product: variant_product, variant: variant_product.alive_variants.second, name: "Take it", cross_sell: true, selected_products: [product], offer_code: code)
    end

    it "marks the offer accepted and selects its version", parity: true do
      get checkout_path(product: variant_product.unique_permalink, accepted_offer_id: cross_sell.external_id)

      expect(added.sole["accepted_offer"]).to include("id" => cross_sell.external_id, "variant_id" => variant_product.alive_variants.second.external_id)
      expect(added.sole["accepted_offer"]["discount"]).to include("percents" => 25)
      expect(added.sole["option_id"]).to eq(variant_product.alive_variants.second.external_id)
    end

    it "ignores an offer that is paused", parity: true do
      cross_sell.update!(paused: true)

      get checkout_path(product: variant_product.unique_permalink, accepted_offer_id: cross_sell.external_id)

      expect(added.sole["accepted_offer"]).to be_nil
    end

    it "ignores an offer of another product", parity: true do
      get checkout_path(product: product.unique_permalink, accepted_offer_id: cross_sell.external_id)

      expect(added.sole["accepted_offer"]).to be_nil
    end

    it "ignores an offer id that is not an id", parity: true do
      get checkout_path(product: variant_product.unique_permalink, accepted_offer_id: "garbage")

      expect(added.sole["accepted_offer"]).to be_nil
    end

    it "marks an offer without a version accepted", parity: true do
      plain = create(:upsell, seller:, product: variant_product, name: "Plain", cross_sell: true, selected_products: [product])

      get checkout_path(product: variant_product.unique_permalink, accepted_offer_id: plain.external_id)

      expect(added.sole["accepted_offer"]).to include("variant_id" => nil, "discount" => nil)
    end
  end

  describe "?wishlist=" do
    let(:wishlist) { create(:wishlist, user: seller, name: "Picks") }

    def add(wishlist, product, **attributes) = create(:wishlist_product, wishlist:, product:, **attributes)

    it "puts every available product of the wishlist on the page", parity: true do
      first = create(:product, user: seller, name: "First pick", price_cents: 700, created_at: Time.utc(2025, 1, 2))
      second = create(:product, user: create(:named_user, username: "other", email: "other@example.com"), name: "Second pick", price_cents: 900, created_at: Time.utc(2025, 1, 3))
      add(wishlist, first)
      add(wishlist, second)

      get checkout_path(wishlist: wishlist.external_id)

      expect(added.map { _1["product"]["name"] }).to eq(["First pick", "Second pick"])
      expect(added.first).to include("recommended_by" => "wishlist", "affiliate_id" => seller.global_affiliate.external_id_numeric.to_s)
      expect(props["checkout_style"]).to be_nil
    end

    it "shows the seller's theme for a wishlist of one seller's products", parity: true do
      add(wishlist, product)

      get checkout_path(wishlist: wishlist.external_id)

      expect(props["checkout_style"]["seller_id"]).to eq(seller.external_id)
    end

    it "uses the version, recurrence and quantity the wishlist recorded", parity: true do
      membership = create(:membership_product_with_preset_tiered_pricing, user: seller, name: "Club", created_at: Time.utc(2025, 1, 3))
      add(wishlist, membership, variant: membership.alive_variants.second, recurrence: "monthly")
      physical = create(:physical_product, user: seller, name: "Poster", quantity_enabled: true, created_at: Time.utc(2025, 1, 4))
      add(wishlist, physical, quantity: 4)

      get checkout_path(wishlist: wishlist.external_id)

      expect(added.first).to include("recurrence" => "monthly", "option_id" => membership.alive_variants.second.external_id)
      expect(added.second).to include("quantity" => 4)
    end

    it "skips products that were removed, banned or sold by a suspended account", parity: true do
      add(wishlist, product)
      add(wishlist, create(:product, user: seller, name: "Removed", created_at: Time.utc(2025, 1, 3))).mark_deleted!
      add(wishlist, create(:product, user: seller, name: "Banned", banned_at: Time.utc(2025, 1, 1), created_at: Time.utc(2025, 1, 4)))
      add(wishlist, create(:product, user: create(:user, user_risk_state: "suspended_for_fraud", username: "suspended"), name: "Suspended seller", created_at: Time.utc(2025, 1, 5)))

      get checkout_path(wishlist: wishlist.external_id)

      expect(added.map { _1["product"]["name"] }).to eq(["Arrival course"])
    end

    it "uses the affiliate and recommender in the URL over the defaults", parity: true do
      add(wishlist, product)

      get checkout_path(wishlist: wishlist.external_id, affiliate_id: "77", recommended_by: "shared")

      expect(added.sole).to include("affiliate_id" => "77", "recommended_by" => "shared")
    end

    it "adds nothing for a wishlist that was deleted", parity: true do
      add(wishlist, product)
      wishlist.mark_deleted!

      get checkout_path(wishlist: wishlist.external_id)

      expect(added).to eq([])
    end

    it "adds nothing for a wishlist id that is not an id", parity: true do
      get checkout_path(wishlist: "garbage")

      expect(added).to eq([])
    end

    it "shows no theme for a wishlist of two sellers' products", parity: true do
      add(wishlist, product)
      add(wishlist, create(:product, user: create(:named_user, username: "other", email: "other@example.com"), name: "Other seller", created_at: Time.utc(2025, 1, 3)))

      get checkout_path(wishlist: wishlist.external_id)

      expect(props["checkout_style"]).to be_nil
    end
  end

  describe "?gift_wishlist_product=" do
    let(:wishlist) { create(:wishlist, user: seller, name: "Gifts") }
    let(:wishlist_product) { create(:wishlist_product, wishlist:, product:) }

    it "puts the product on the page as a gift and clears the cart", parity: true do
      get checkout_path(gift_wishlist_product: wishlist_product.external_id)

      expect(props["checkout"]).to include("clear_cart" => true, "gift" => { "type" => "anonymous", "id" => seller.external_id, "name" => "Arrival Seller", "note" => "", "hideGifter" => false })
      expect(added.sole).to include("recommended_by" => "wishlist")
    end

    it "gifts a product of a wishlist the visitor does not own", parity: true do
      log_in(buyer)

      get checkout_path(gift_wishlist_product: wishlist_product.external_id)

      expect(props["checkout"]["clear_cart"]).to eq(true)
    end

    it "adds nothing for the owner of the wishlist", parity: true do
      log_in(seller)

      get checkout_path(gift_wishlist_product: wishlist_product.external_id)

      expect(props["checkout"]).to include("clear_cart" => false, "gift" => nil)
    end

    it "names the owner by username when they have no name", parity: true do
      seller.update!(name: nil)

      get checkout_path(gift_wishlist_product: wishlist_product.external_id)

      expect(props["checkout"]["gift"]["name"]).to eq("seller")
    end

    it "adds nothing for a wishlist product that was removed", parity: true do
      wishlist_product.mark_deleted!

      get checkout_path(gift_wishlist_product: wishlist_product.external_id)

      expect(props["checkout"]).to include("clear_cart" => false, "gift" => nil)
    end

    it "replaces what ?product= and ?wishlist= put on the page", parity: true do
      other = create(:product, user: seller, name: "Other pick", created_at: Time.utc(2025, 1, 3))
      create(:wishlist_product, wishlist:, product: other)

      get checkout_path(product: other.unique_permalink, wishlist: wishlist.external_id, gift_wishlist_product: wishlist_product.external_id)

      expect(added.map { _1["product"]["name"] }).to eq(["Arrival course"])
    end
  end

  describe "when signed in" do
    before { log_in(buyer) }

    it "keeps the account's address and puts the product on the page", parity: true do
      get checkout_path(product: product.unique_permalink)

      expect(props["checkout"]).to include("country" => "CA", "state" => "ON")
      expect(added.sole["product"]["name"]).to eq("Arrival course")
    end

    it "keeps the new subscription a signed-in buyer asked for", parity: true do
      membership = create(:membership_product_with_preset_tiered_pricing, user: seller, name: "Club", created_at: Time.utc(2025, 1, 3))

      get checkout_path(product: membership.unique_permalink, force_new_subscription: "true")

      expect(added.sole["force_new_subscription"]).to eq(true)
    end

    it "does not start a new subscription of a product that is not a membership", parity: true do
      get checkout_path(product: product.unique_permalink, force_new_subscription: "true")

      expect(added.sole["force_new_subscription"]).to eq(false)
    end

    it "leaves out a cross-sell the buyer already owns", parity: true do
      offered = create(:product, user: seller, name: "Extra", price_cents: 500, created_at: Time.utc(2025, 1, 1))
      other = create(:product, user: seller, name: "Another extra", price_cents: 600, created_at: Time.utc(2025, 1, 4))
      create(:upsell, seller:, product: offered, name: "Add", cross_sell: true, selected_products: [product])
      create(:upsell, seller:, product: other, name: "Add another", cross_sell: true, selected_products: [product])
      build(:purchase, link: offered, purchaser: buyer, email: buyer.email, seller:, purchase_state: "successful").save!(validate: false)

      get checkout_path(product: product.unique_permalink)

      expect(added.sole["product"]["cross_sells"].map { _1["offered_product"]["product"]["name"] }).to eq(["Another extra"])
    end

    it "offers the version upsell unless the buyer owns that version", parity: true do
      versioned = create(:product_with_digital_versions, user: seller, name: "Versioned", created_at: Time.utc(2025, 1, 3))
      first, second = versioned.alive_variants.first, versioned.alive_variants.second
      upsell = create(:upsell, seller:, product: versioned, name: "Upgrade")
      create(:upsell_variant, upsell:, selected_variant: first, offered_variant: second)
      purchase = build(:purchase, link: versioned, purchaser: buyer, email: buyer.email, seller:, purchase_state: "successful")
      purchase.variant_attributes << second
      purchase.save!(validate: false)

      get checkout_path(product: versioned.unique_permalink)

      expect(added.sole["product"]["options"].first["upsell_offered_variant_id"]).to be_nil
    end

    it "shows the discount of an accepted offer to a buyer it applies to", parity: true do
      variant_product = create(:product_with_digital_versions, user: seller, name: "Versioned", price_cents: 2000, created_at: Time.utc(2025, 1, 3))
      code = create(:offer_code, user: seller, products: [variant_product], amount_cents: nil, amount_percentage: 25, code: "ACCEPT")
      cross_sell = create(:upsell, seller:, product: variant_product, name: "Take it", cross_sell: true, selected_products: [product], offer_code: code)

      get checkout_path(product: variant_product.unique_permalink, accepted_offer_id: cross_sell.external_id)

      expect(added.sole["accepted_offer"]["discount"]).to include("percents" => 25)
    end

    it "hands an accepted offer whose code is for existing customers to Rails", parity: true do
      variant_product = create(:product_with_digital_versions, user: seller, name: "Versioned", price_cents: 2000, created_at: Time.utc(2025, 1, 3))
      code = create(:offer_code, user: seller, products: [variant_product], amount_cents: nil, amount_percentage: 25, code: "LOYAL", existing_customers_only: true, ownership_products: [product])
      cross_sell = create(:upsell, seller:, product: variant_product, name: "Take it", cross_sell: true, selected_products: [product], offer_code: code)

      get checkout_path(product: variant_product.unique_permalink, accepted_offer_id: cross_sell.external_id)

      expect(response).to be_successful
    end
  end

  describe "when signed in as the seller" do
    before { log_in(seller) }

    it "keeps a cross-sell of the seller's own product for the seller", parity: true do
      offered = create(:product, user: seller, name: "Extra", price_cents: 500, created_at: Time.utc(2025, 1, 1))
      create(:upsell, seller:, product: offered, name: "Add", cross_sell: true, selected_products: [product])
      build(:purchase, link: offered, purchaser: seller, email: seller.email, seller:, purchase_state: "successful").save!(validate: false)

      get checkout_path(product: product.unique_permalink)

      expect(added.sole["product"]["cross_sells"].size).to eq(1)
    end
  end

  describe "handed back to Rails" do
    it "hands a seller who shows buyers their own currency to Rails", parity: true do
      seller.update!(disable_buyer_local_currency: false)
      Feature.activate_user(:buyer_local_currency, seller)

      get checkout_path(product: product.unique_permalink), headers: from_ip(gb_ip)

      expect(added.sole["product"]["buyer_currency_display"]).to be_present
    end

    it "hands a partial reload of the recommended products to Rails", parity: true do
      inertia_visit checkout_path(product: product.unique_permalink), "X-Inertia-Partial-Component" => "Checkout/Show", "X-Inertia-Partial-Data" => "recommended_products"

      expect(response.parsed_body["props"].keys).to include("recommended_products")
    end

    it "hands a cart that holds a product beside the URL's product to Rails", parity: true do
      cart = create(:cart, :guest, browser_guid: "arrivals-guid")
      create(:cart_product, cart:, product: create(:product, user: seller, name: "In cart", created_at: Time.utc(2025, 1, 3)))
      cookies[:_gumroad_guid] = "arrivals-guid"

      get checkout_path(product: product.unique_permalink)

      expect(props["cart"]["items"].size).to eq(1)
    end
  end
end
