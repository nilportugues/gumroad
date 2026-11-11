# frozen_string_literal: true

require "spec_helper"

# The checkout dashboard's upsells (Checkout::UpsellsController), recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/ws20u.replay.test.ts, which sends the last request of each example. Creating and updating an upsell, building a
# cart item and deleting an upsell that has an offer code run SaveUpsellService, CheckoutPresenter or OfferCode's callbacks, so those
# examples record what Node hands back.
describe "Checkout upsells when signed in", type: :request do
  include Parity::AudienceSignedIn

  let(:seller) { create(:named_seller) }
  let(:product) { create(:product, user: seller, name: "Base product", price_cents: 1000, created_at: Time.utc(2025, 1, 1)) }
  let(:json_headers) { { "Accept" => "application/json", "Content-Type" => "application/json" } }
  let(:accept_json) { { "Accept" => "application/json" } }

  before { host! DOMAIN }

  def make_upsell(name, **attributes)
    create(:upsell, { seller:, product: create(:product, user: seller, name: "#{name} product"), name:, updated_at: Time.utc(2025, 2, 1) }.merge(attributes))
  end

  def sell(upsell, count: 1, price_cents: 1000, selected_product: upsell.product, upsell_variant: nil, **attributes)
    count.times do
      purchase = build(:purchase, link: upsell.product, seller:, price_cents:, purchase_state: "successful", **attributes)
      purchase.save!(validate: false)
      UpsellPurchase.new(upsell:, purchase:, selected_product:, upsell_variant:).save!(validate: false)
    end
  end

  def team_member(role)
    member = create(:user, name: "#{role.capitalize} Member")
    membership = create(:team_membership, user: member, seller:, role:)
    log_in(member)
    switch_to(membership)
  end

  def delete_json(path)
    delete path, headers: json_headers.merge("X-CSRF-Token" => csrf_token)
  end

  context "when signed in as the seller" do
    before { log_in(seller) }

    describe "index" do
      it "renders the upsells page with its products", parity: true do
        upsell = make_upsell("Alpha")
        create(:upsell_variant, upsell:)
        make_upsell("Beta", cross_sell: true, universal: true)
        create(:product, user: seller, name: "Archived", archived: true)

        get checkout_upsells_path

        expect(response).to have_http_status(:ok)
        expect(inertia_props_of(response).fetch("upsells").size).to eq(2)
      end

      it "renders an empty page for a seller without upsells", parity: true do
        get checkout_upsells_path

        expect(response).to have_http_status(:ok)
        expect(inertia_props_of(response).fetch("upsells")).to eq([])
      end
    end

    describe "paged" do
      it "lists upsells most recently updated first", parity: true do
        make_upsell("Older", updated_at: Time.utc(2025, 1, 1))
        make_upsell("Newer", updated_at: Time.utc(2025, 3, 1))

        get paged_checkout_upsells_path, headers: accept_json

        expect(response).to have_http_status(:ok)
        expect(response.parsed_body["upsells"].map { _1["name"] }).to eq(%w[Newer Older])
      end

      it "sorts by name descending", parity: true do
        %w[Bravo Alpha Charlie].each { make_upsell(_1) }

        get paged_checkout_upsells_path(sort: { key: "name", direction: "desc" }), headers: accept_json

        expect(response.parsed_body["upsells"].map { _1["name"] }).to eq(%w[Charlie Bravo Alpha])
      end

      it "sorts by status", parity: true do
        make_upsell("Live")
        make_upsell("Paused", paused: true)

        get paged_checkout_upsells_path(sort: { key: "status", direction: "desc" }), headers: accept_json

        expect(response.parsed_body["upsells"].map { _1["name"] }).to eq(%w[Paused Live])
      end

      it "searches by name", parity: true do
        make_upsell("Summer sale")
        make_upsell("Winter sale")

        get paged_checkout_upsells_path(query: "summer"), headers: accept_json

        expect(response.parsed_body["upsells"].map { _1["name"] }).to eq(["Summer sale"])
      end

      it "paginates twenty to a page", parity: true do
        21.times { |i| make_upsell("Upsell #{i}", updated_at: Time.utc(2025, 1, 1) + i.days) }

        get paged_checkout_upsells_path(page: 2), headers: accept_json

        expect(response.parsed_body["upsells"].size).to eq(1)
        expect(response.parsed_body["pagination"]).to eq("pages" => 2, "page" => 2)
      end

      it "leaves out deleted upsells and other sellers' upsells", parity: true do
        make_upsell("Mine")
        make_upsell("Gone", deleted_at: Time.utc(2025, 2, 2))
        create(:upsell, name: "Theirs")

        get paged_checkout_upsells_path, headers: accept_json

        expect(response.parsed_body["upsells"].map { _1["name"] }).to eq(["Mine"])
      end

      it "lists a cross-sell with its discount, selected products and versions", parity: true do
        upsell = make_upsell("Bundle offer", product:, cross_sell: true, replace_selected_products: true,
                                             offer_code: create(:offer_code, user: seller, products: [product], amount_cents: 200))
        upsell.selected_products << product
        create(:upsell_variant, upsell: create(:upsell, seller:, product: create(:product_with_digital_versions, user: seller), name: "Versions"))

        get paged_checkout_upsells_path, headers: accept_json

        expect(response).to have_http_status(:ok)
        expect(response.parsed_body["upsells"].find { _1["name"] == "Bundle offer" }["discount"]).to include("type" => "fixed")
      end

      it "hands a sort by revenue to Rails", parity: true do
        make_upsell("One")

        get paged_checkout_upsells_path(sort: { key: "revenue", direction: "desc" }), headers: accept_json

        expect(response).to have_http_status(:ok)
      end
    end

    describe "statistics" do
      it "totals uses and revenue by selected product and version", parity: true do
        upsell = make_upsell("Counted", cross_sell: true)
        other = create(:product, user: seller, name: "Selected")
        variant_upsell = create(:upsell_variant, upsell:)
        sell(upsell, count: 2, price_cents: 1500, selected_product: other)
        sell(upsell, count: 1, price_cents: 500, selected_product: upsell.product, upsell_variant: variant_upsell)

        get statistics_checkout_upsell_path(upsell.external_id), headers: accept_json

        expect(response).to have_http_status(:ok)
        expect(response.parsed_body.dig("uses", "selected_products").size).to eq(2)
      end

      it "leaves out refunded and charged back sales", parity: true do
        upsell = make_upsell("Mixed")
        sell(upsell, count: 1, price_cents: 1000)
        sell(upsell, count: 1, price_cents: 700, stripe_refunded: true)
        sell(upsell, count: 1, price_cents: 300, chargeback_date: Time.utc(2025, 2, 1))

        get statistics_checkout_upsell_path(upsell.external_id), headers: accept_json

        expect(response.parsed_body["revenue_cents"].to_f).to eq(1000.0)
      end

      it "answers zeros for an upsell nobody used", parity: true do
        upsell = make_upsell("Unused")

        get statistics_checkout_upsell_path(upsell.external_id), headers: accept_json

        expect(response.parsed_body).to eq("uses" => { "total" => 0, "selected_products" => {}, "upsell_variants" => {} }, "revenue_cents" => 0)
      end

      it "answers not found for a deleted upsell", parity: true do
        upsell = make_upsell("Removed", deleted_at: Time.utc(2025, 2, 2))

        get statistics_checkout_upsell_path(upsell.external_id), headers: accept_json

        expect(response).to have_http_status(:not_found)
      end

      it "answers not found for another seller's upsell", parity: true do
        upsell = create(:upsell)

        get statistics_checkout_upsell_path(upsell.external_id), headers: accept_json

        expect(response).to have_http_status(:not_found)
      end
    end

    describe "cart_item" do
      it "answers the cart item of a product", parity: true do
        seller.update!(display_offer_code_field: true, tipping_enabled: true)
        create(:custom_field, seller:, name: "Phone", global: true, required: true)
        create(:universal_offer_code, user: seller)

        get cart_item_checkout_upsells_path(product_id: product.external_id), headers: accept_json

        expect(response).to have_http_status(:ok)
        expect(response.parsed_body).to include("price" => 1000, "quantity" => nil, "force_new_subscription" => false)
        expect(response.parsed_body["product"]).to include("name" => "Base product", "has_offer_codes" => true, "has_tipping_enabled" => true, "cross_sells" => [])
      end

      it "answers the first available option of a product with versions", parity: true do
        versions = create(:product_with_digital_versions, user: seller, name: "Versions", created_at: Time.utc(2025, 1, 1))

        get cart_item_checkout_upsells_path(product_id: versions.external_id), headers: accept_json

        expect(response).to have_http_status(:ok)
        expect(response.parsed_body["option_id"]).to be_present
      end

      it "answers the first tier of a membership with its price and recurrence", parity: true do
        membership = create(:membership_product_with_preset_tiered_pricing, user: seller, name: "Club", created_at: Time.utc(2025, 1, 1))

        get cart_item_checkout_upsells_path(product_id: membership.external_id), headers: accept_json

        expect(response).to have_http_status(:ok)
        expect(response.parsed_body).to include("price" => 300, "recurrence" => "monthly", "option_id" => membership.alive_variants.first.external_id)
        expect(response.parsed_body["product"]).to include("is_tiered_membership" => true, "has_tipping_enabled" => false)
      end

      it "prices a membership at its default recurrence", parity: true do
        membership = create(:membership_product_with_preset_tiered_pricing, user: seller, name: "Club", subscription_duration: :yearly, created_at: Time.utc(2025, 1, 1),
                                                                            recurrence_price_values: [
                                                                              { monthly: { enabled: true, price: 3 }, yearly: { enabled: true, price: 30 } },
                                                                              { monthly: { enabled: true, price: 5 }, yearly: { enabled: true, price: 50 } },
                                                                            ])

        get cart_item_checkout_upsells_path(product_id: membership.external_id), headers: accept_json

        expect(response.parsed_body).to include("price" => 3000, "recurrence" => "yearly")
        expect(response.parsed_body["product"]["recurrences"]["enabled"].map { _1["recurrence"] }).to eq(%w[monthly yearly])
      end

      it "falls back to the shortest recurrence when the default one is not priced", parity: true do
        membership = create(:membership_product_with_preset_tiered_pricing, user: seller, name: "Club", created_at: Time.utc(2025, 1, 1),
                                                                            recurrence_price_values: [
                                                                              { monthly: { enabled: true, price: 3 }, yearly: { enabled: true, price: 30 }, quarterly: { enabled: true, price: 9 } },
                                                                              { monthly: { enabled: true, price: 5 }, yearly: { enabled: true, price: 50 }, quarterly: { enabled: true, price: 15 } },
                                                                            ])
        membership.alive_variants.first.prices.where(recurrence: "monthly").update_all(deleted_at: Time.utc(2025, 1, 2))

        get cart_item_checkout_upsells_path(product_id: membership.external_id), headers: accept_json

        expect(response.parsed_body).to include("recurrence" => "quarterly", "price" => 900)
      end

      it "skips a first tier that is closed to new buyers", parity: true do
        Feature.activate_user(:close_membership_tier_to_new_buyers, seller)
        membership = create(:membership_product_with_preset_tiered_pricing, user: seller, name: "Club", created_at: Time.utc(2025, 1, 1))
        first, second = membership.alive_variants.to_a
        first.update!(closed_to_new_purchases: true)

        get cart_item_checkout_upsells_path(product_id: membership.external_id), headers: accept_json

        expect(response.parsed_body).to include("option_id" => second.external_id, "price" => 500)
        expect(response.parsed_body["product"]["options"].first["quantity_left"]).to eq(0)
      end

      it "answers a membership with a free trial", parity: true do
        membership = create(:membership_product_with_preset_tiered_pricing, :with_free_trial_enabled, user: seller, name: "Trial club", created_at: Time.utc(2025, 1, 1))

        get cart_item_checkout_upsells_path(product_id: membership.external_id), headers: accept_json

        expect(response.parsed_body["product"]["free_trial"]).to eq("duration" => { "unit" => "week", "amount" => 1 })
      end

      it "answers a legacy subscription at its default recurrence", parity: true do
        subscription = create(:subscription_product, user: seller, name: "Legacy", price_cents: 700, created_at: Time.utc(2025, 1, 1))

        get cart_item_checkout_upsells_path(product_id: subscription.external_id), headers: accept_json

        expect(response.parsed_body).to include("price" => 700, "recurrence" => "monthly")
        expect(response.parsed_body["product"]).to include("is_legacy_subscription" => true, "has_tipping_enabled" => false)
      end

      it "answers a legacy subscription with versions on its first available one", parity: true do
        subscription = create(:subscription_product_with_versions, user: seller, name: "Legacy versions", price_cents: 700, created_at: Time.utc(2025, 1, 1))

        get cart_item_checkout_upsells_path(product_id: subscription.external_id), headers: accept_json

        expect(response.parsed_body["option_id"]).to eq(subscription.alive_variants.first.external_id)
      end

      it "hands a physical product cart item to Rails", parity: true do
        poster = create(:physical_product, user: seller, name: "Poster", created_at: Time.utc(2025, 1, 1))

        get cart_item_checkout_upsells_path(product_id: poster.external_id), headers: accept_json

        expect(response).to have_http_status(:ok)
      end

      it "answers the upsell of a product", parity: true do
        create(:upsell, seller:, product:, name: "Pro", text: "Go Pro", description: "Get <b>more</b> at https://example.com/pro <script>alert(1)</script>")

        get cart_item_checkout_upsells_path(product_id: product.external_id), headers: accept_json

        expect(response).to have_http_status(:ok)
        expect(response.parsed_body["product"]["upsell"]).to include("text" => "Go Pro")
      end

      it "answers the upsell of a product with no text or description", parity: true do
        create(:upsell, seller:, product:, name: "Pro", text: nil, description: nil)

        get cart_item_checkout_upsells_path(product_id: product.external_id), headers: accept_json

        expect(response.parsed_body["product"]["upsell"]).to include("text" => "", "description" => "")
      end

      it "leaves out a paused upsell", parity: true do
        create(:upsell, seller:, product:, name: "Pro", paused: true)

        get cart_item_checkout_upsells_path(product_id: product.external_id), headers: accept_json

        expect(response.parsed_body["product"]["upsell"]).to be_nil
      end

      it "offers the upgraded version of each option of an upsell", parity: true do
        versions = create(:product_with_digital_versions, user: seller, name: "Versions", created_at: Time.utc(2025, 1, 1))
        first, second = versions.alive_variants.to_a
        sold_out = create(:variant, variant_category: versions.variant_categories_alive.first, name: "Sold out", max_purchase_count: 1)
        sold_out.update_columns(sales_count_for_inventory_cache: 1)
        upsell = create(:upsell, seller:, product: versions, name: "Upgrade")
        create(:upsell_variant, upsell:, selected_variant: first, offered_variant: second)
        create(:upsell_variant, upsell:, selected_variant: second, offered_variant: sold_out)

        get cart_item_checkout_upsells_path(product_id: versions.external_id), headers: accept_json

        options = response.parsed_body["product"]["options"]
        expect(options.map { _1["upsell_offered_variant_id"] }).to eq([second.external_id, nil, nil])
      end

      it "ignores a deleted upsell variant", parity: true do
        versions = create(:product_with_digital_versions, user: seller, name: "Versions", created_at: Time.utc(2025, 1, 1))
        first, second = versions.alive_variants.to_a
        upsell = create(:upsell, seller:, product: versions, name: "Upgrade")
        create(:upsell_variant, upsell:, selected_variant: first, offered_variant: second, deleted_at: Time.utc(2025, 1, 2))

        get cart_item_checkout_upsells_path(product_id: versions.external_id), headers: accept_json

        expect(response.parsed_body["product"]["options"].map { _1["upsell_offered_variant_id"] }).to eq([nil, nil])
      end

      it "lists the cross-sells of a product with their offered product and discount", parity: true do
        extra = create(:product, user: seller, name: "Extra", price_cents: 500, created_at: Time.utc(2025, 1, 3))
        code = create(:offer_code, user: seller, products: [extra], amount_cents: nil, amount_percentage: 20, code: "XSELL")
        create(:upsell, seller:, product: extra, name: "Add", cross_sell: true, selected_products: [product], replace_selected_products: true, offer_code: code,
                        text: "Add the extra", description: "A <i>great</i> companion")

        get cart_item_checkout_upsells_path(product_id: product.external_id), headers: accept_json

        cross_sell = response.parsed_body["product"]["cross_sells"].sole
        expect(cross_sell).to include("replace_selected_products" => true, "text" => "Add the extra", "ratings" => { "count" => 0, "average" => 0.0 })
        expect(cross_sell["offered_product"]["product"]["name"]).to eq("Extra")
        expect(cross_sell["discount"]).to include("type" => "percent", "percents" => 20)
      end

      it "leaves out the discount of an existing-customers cross-sell code", parity: true do
        extra = create(:product, user: seller, name: "Extra", price_cents: 500, created_at: Time.utc(2025, 1, 3))
        code = create(:offer_code, user: seller, products: [extra], amount_cents: nil, amount_percentage: 20, code: "LOYAL", existing_customers_only: true, ownership_products: [product])
        create(:upsell, seller:, product: extra, name: "Add", cross_sell: true, universal: true, offer_code: code)

        get cart_item_checkout_upsells_path(product_id: product.external_id), headers: accept_json

        expect(response.parsed_body["product"]["cross_sells"].sole["discount"]).to be_nil
      end

      it "shows ratings on a cross-sell whose product displays reviews", parity: true do
        extra = create(:product, user: seller, name: "Extra", created_at: Time.utc(2025, 1, 3), display_product_reviews: true)
        create(:product_review_stat, link: extra, reviews_count: 2, ratings_of_four_count: 1, ratings_of_five_count: 1, average_rating: 4.5)
        create(:upsell, seller:, product: extra, name: "Add", cross_sell: true, universal: true)

        get cart_item_checkout_upsells_path(product_id: product.external_id), headers: accept_json

        expect(response.parsed_body["product"]["cross_sells"].sole["ratings"]).to eq("count" => 2, "average" => 4.5)
      end

      it "lists a universal cross-sell and one selecting the product, in order", parity: true do
        one = create(:product, user: seller, name: "One", created_at: Time.utc(2025, 1, 3))
        two = create(:product, user: seller, name: "Two", created_at: Time.utc(2025, 1, 4))
        create(:upsell, seller:, product: one, name: "First", cross_sell: true, universal: true)
        create(:upsell, seller:, product: two, name: "Second", cross_sell: true, selected_products: [product])
        create(:upsell, seller:, product: two, name: "Elsewhere", cross_sell: true, selected_products: [one])

        get cart_item_checkout_upsells_path(product_id: product.external_id), headers: accept_json

        expect(response.parsed_body["product"]["cross_sells"].map { _1["offered_product"]["product"]["name"] }).to eq(%w[One Two])
      end

      it "leaves out cross-sells that are paused, deleted, or whose product is gone or sold out", parity: true do
        paused = create(:product, user: seller, name: "Paused", created_at: Time.utc(2025, 1, 3))
        gone = create(:product, user: seller, name: "Gone", created_at: Time.utc(2025, 1, 4))
        sold_out = create(:product, user: seller, name: "Sold out", created_at: Time.utc(2025, 1, 5), max_purchase_count: 1)
        sold_out.update_columns(sales_count_for_inventory_cache: 1)
        shown = create(:product, user: seller, name: "Shown", created_at: Time.utc(2025, 1, 6))
        create(:upsell, seller:, product: paused, name: "Paused", cross_sell: true, universal: true, paused: true)
        create(:upsell, seller:, product: gone, name: "Gone", cross_sell: true, universal: true)
        create(:upsell, seller:, product: sold_out, name: "Sold out", cross_sell: true, universal: true)
        create(:upsell, seller:, product: shown, name: "Shown", cross_sell: true, universal: true)
        create(:upsell, seller:, product: shown, name: "Deleted", cross_sell: true, universal: true, deleted_at: Time.utc(2025, 1, 7))
        gone.update_columns(deleted_at: Time.utc(2025, 1, 8))

        get cart_item_checkout_upsells_path(product_id: product.external_id), headers: accept_json

        expect(response.parsed_body["product"]["cross_sells"].map { _1["offered_product"]["product"]["name"] }).to eq(%w[Shown])
      end

      it "skips a cross-sell whose fixed version is sold out", parity: true do
        versions = create(:product_with_digital_versions, user: seller, name: "Versions", created_at: Time.utc(2025, 1, 3))
        first, second = versions.alive_variants.to_a
        second.update_columns(max_purchase_count: 1, sales_count_for_inventory_cache: 1)
        create(:upsell, seller:, product: versions, name: "First", cross_sell: true, universal: true, variant: first)
        create(:upsell, seller:, product: versions, name: "Second", cross_sell: true, universal: true, variant: second)

        get cart_item_checkout_upsells_path(product_id: product.external_id), headers: accept_json

        offered = response.parsed_body["product"]["cross_sells"].sole["offered_product"]
        expect(offered["option_id"]).to eq(first.external_id)
      end

      it "matches the offered version to the selected one by name", parity: true do
        selected = create(:product, user: seller, name: "Selected", created_at: Time.utc(2025, 1, 2))
        category = create(:variant_category, title: "Size", link: selected)
        create(:variant, variant_category: category, name: "Large")
        offered = create(:product, user: seller, name: "Offered", created_at: Time.utc(2025, 1, 3))
        offered_category = create(:variant_category, title: "Size", link: offered)
        create(:variant, variant_category: offered_category, name: "Small")
        large = create(:variant, variant_category: offered_category, name: "Large")
        create(:upsell, seller:, product: offered, name: "Match", cross_sell: true, universal: true, variant: offered.alive_variants.first, offer_matching_version: true)

        get cart_item_checkout_upsells_path(product_id: selected.external_id), headers: accept_json

        expect(response.parsed_body["product"]["cross_sells"].sole["offered_product"]["option_id"]).to eq(large.external_id)
      end

      it "answers the products of a bundle", parity: true do
        bundle = create(:product, :bundle, user: seller, price_cents: 1500, created_at: Time.utc(2025, 1, 1))
        bundle.bundle_products.first.update!(quantity: 3, position: 2)
        bundle.bundle_products.last.update!(position: 1)
        create(:custom_field, seller:, name: "Phone", products: [bundle.bundle_products.first.product])

        get cart_item_checkout_upsells_path(product_id: bundle.external_id), headers: accept_json

        expect(response).to have_http_status(:ok)
        listed = response.parsed_body["product"]["bundle_products"]
        expect(listed.map { _1["name"] }).to eq(["Bundle Product 2", "Bundle Product 1"])
        expect(listed.last).to include("quantity" => 3)
        expect(listed.last["custom_fields"].map { _1["name"] }).to eq(["Phone"])
      end

      it "answers a bundle with a versioned product and without a deleted one", parity: true do
        bundle = create(:product, :bundle, user: seller, created_at: Time.utc(2025, 1, 1))
        versioned = create(:product_with_digital_versions, user: seller, name: "Versioned")
        removed = create(:product, user: seller, name: "Removed")
        create(:bundle_product, bundle:, product: versioned, variant: versioned.alive_variants.first)
        create(:bundle_product, bundle:, product: removed, deleted_at: Time.utc(2025, 1, 5))

        get cart_item_checkout_upsells_path(product_id: bundle.external_id), headers: accept_json

        listed = response.parsed_body["product"]["bundle_products"]
        expect(listed.map { _1["name"] }).to include("Versioned")
        expect(listed.map { _1["name"] }).not_to include("Removed")
        expect(listed.find { _1["name"] == "Versioned" }["variant"]).to include("name" => "Untitled 1")
      end

      it "asks for shipping when a bundled product ships", parity: true do
        bundle = create(:product, :bundle, user: seller, created_at: Time.utc(2025, 1, 1))
        create(:bundle_product, bundle:, product: create(:physical_product, user: seller, name: "Poster"))

        get cart_item_checkout_upsells_path(product_id: bundle.external_id), headers: accept_json

        expect(response.parsed_body["product"]["require_shipping"]).to eq(true)
      end

      it "answers a buy-and-rent product at its buy price with the rental price beside it", parity: true do
        product.update!(purchase_type: :buy_and_rent, rental_price_cents: 300)

        get cart_item_checkout_upsells_path(product_id: product.external_id), headers: accept_json

        expect(response.parsed_body).to include("price" => 1000, "rent" => false)
        expect(response.parsed_body["product"]["rental"]).to eq("price_cents" => 300, "rent_only" => false)
      end

      it "answers a rent-only product at its rental price", parity: true do
        product.update!(purchase_type: :rent_only, rental_price_cents: 300)

        get cart_item_checkout_upsells_path(product_id: product.external_id), headers: accept_json

        expect(response.parsed_body).to include("price" => 300, "rent" => false)
        expect(response.parsed_body["product"]).to include("price_cents" => 300, "rental" => { "price_cents" => 300, "rent_only" => true })
      end

      it "answers not found for another seller's product", parity: true do
        get cart_item_checkout_upsells_path(product_id: create(:product).external_id), headers: accept_json

        expect(response).to have_http_status(:not_found)
      end
    end

    describe "destroy" do
      it "deletes an upsell and its versions and answers the list", parity: true do
        upsell = make_upsell("Doomed")
        variant = create(:upsell_variant, upsell:)
        make_upsell("Kept")

        delete_json checkout_upsell_path(upsell.external_id)

        expect(response).to have_http_status(:ok)
        expect(response.parsed_body).to include("success" => true)
        expect(response.parsed_body["upsells"].map { _1["name"] }).to eq(["Kept"])
        expect(upsell.reload.deleted_at).to be_present
        expect(variant.reload.deleted_at).to be_present
      end

      it "deletes an upsell that was already deleted", parity: true do
        upsell = make_upsell("Twice", deleted_at: Time.utc(2025, 2, 2))

        delete_json checkout_upsell_path(upsell.external_id)

        expect(response.parsed_body).to include("success" => true)
      end

      it "hands an upsell with an offer code to Rails", parity: true do
        upsell = make_upsell("Discounted", product:, cross_sell: true, offer_code: create(:offer_code, user: seller, products: [product], amount_cents: 100))

        delete_json checkout_upsell_path(upsell.external_id)

        expect(response).to have_http_status(:ok)
        expect(upsell.reload.deleted_at).to be_present
      end

      it "answers not found for another seller's upsell", parity: true do
        upsell = create(:upsell)

        delete_json checkout_upsell_path(upsell.external_id)

        expect(response).to have_http_status(:not_found)
      end
    end
  end

  context "when signed in as a team member" do
    it "lets a support member read the list", parity: true do
      make_upsell("Visible")
      team_member("support")

      get paged_checkout_upsells_path, headers: accept_json

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body["upsells"].size).to eq(1)
    end

    it "lets an accountant read statistics", parity: true do
      upsell = make_upsell("Audited")
      team_member("accountant")

      get statistics_checkout_upsell_path(upsell.external_id), headers: accept_json

      expect(response).to have_http_status(:ok)
    end

    it "refuses a support member the delete", parity: true do
      upsell = make_upsell("Protected")
      team_member("support")

      delete_json checkout_upsell_path(upsell.external_id)

      expect(response).to have_http_status(:unauthorized)
      expect(upsell.reload.deleted_at).to be_nil
    end

    it "lets a marketing member delete", parity: true do
      upsell = make_upsell("Marketed")
      team_member("marketing")

      delete_json checkout_upsell_path(upsell.external_id)

      expect(response.parsed_body).to include("success" => true)
    end

    it "refuses an accountant the delete", parity: true do
      upsell = make_upsell("Audited too")
      team_member("accountant")

      delete_json checkout_upsell_path(upsell.external_id)

      expect(response).to have_http_status(:unauthorized)
    end
  end
end
