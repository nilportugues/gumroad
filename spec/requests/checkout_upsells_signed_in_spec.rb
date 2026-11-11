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

      it "hands a membership cart item to Rails", parity: true do
        membership = create(:membership_product_with_preset_tiered_pricing, user: seller, name: "Club", created_at: Time.utc(2025, 1, 1))

        get cart_item_checkout_upsells_path(product_id: membership.external_id), headers: accept_json

        expect(response).to have_http_status(:ok)
      end

      it "hands a physical product cart item to Rails", parity: true do
        poster = create(:physical_product, user: seller, name: "Poster", created_at: Time.utc(2025, 1, 1))

        get cart_item_checkout_upsells_path(product_id: poster.external_id), headers: accept_json

        expect(response).to have_http_status(:ok)
      end

      it "hands an upsell product cart item to Rails", parity: true do
        create(:upsell, seller:, product:, name: "Pro")

        get cart_item_checkout_upsells_path(product_id: product.external_id), headers: accept_json

        expect(response).to have_http_status(:ok)
      end

      it "hands a cross-sell product cart item to Rails", parity: true do
        create(:upsell, seller:, product: create(:product, user: seller, name: "Extra"), name: "Add", cross_sell: true, selected_products: [product])

        get cart_item_checkout_upsells_path(product_id: product.external_id), headers: accept_json

        expect(response).to have_http_status(:ok)
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
