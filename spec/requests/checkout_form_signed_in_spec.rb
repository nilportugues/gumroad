# frozen_string_literal: true

require "spec_helper"

# The checkout form settings page (Checkout::FormController) when signed in, recorded for the Next.js port (PARITY_RECORD=1)
# and replayed by nextjs/parity/__tests__/checkout-form.replay.test.ts, which sends the last request of each example.
#
# The page's cart item is CheckoutPresenter output for the seller's newest product. Node serves it for a plain product; a physical
# product, a membership, an upsell or cross-sell, and a connected PayPal account (fetched live from PayPal) are "hands a ..." examples:
# the replay asserts Node passed the request to Rails untouched and wrote nothing.
describe "Checkout form settings when signed in", type: :request do
  include Parity::AudienceSignedIn

  let(:seller) { create(:user, name: "Form Seller", username: "formseller", created_at: Time.utc(2025, 1, 1)) }
  let(:inertia_headers) do
    { "X-Inertia" => "true", "X-Requested-With" => "XMLHttpRequest", "Accept" => "text/html, application/xhtml+xml", "Content-Type" => "application/json" }
  end

  before { host! DOMAIN }

  def send_form(method, body)
    public_send(method, checkout_form_path, params: body.to_json, headers: inertia_headers.merge("X-CSRF-Token" => csrf_token))
  end

  def sign_in_as_team_member(role)
    member = create(:user, name: "Team #{role}")
    membership = create(:team_membership, user: member, seller:, role:)
    log_in(member)
    switch_to(membership)
  end

  describe "GET /checkout/form" do
    it "redirects a signed-out visitor to the login page", parity: true do
      get checkout_form_path

      expect(response).to redirect_to(login_path(next: "/checkout/form"))
    end

    it "renders the defaults for a seller who has no products yet", parity: true do
      log_in(seller)

      get checkout_form_path

      expect(response).to be_successful
      props = inertia_props_of(response)
      expect(props).to include("pages" => %w[discounts form upsells], "cart_item" => nil, "card_product" => nil, "products" => [], "custom_fields" => [])
    end

    it "reports the seller's checkout settings", parity: true do
      seller.update!(display_offer_code_field: true, tipping_enabled: true, gifting_disabled: true, link_disabled: true, paypal_card_funding_disabled: true, ach_payments_enabled: true, recommendation_type: User::RecommendationType::NO_RECOMMENDATIONS)
      log_in(seller)

      get checkout_form_path

      expect(inertia_props_of(response)["user"]).to eq(
        "display_offer_code_field" => true, "recommendation_type" => "no_recommendations", "tipping_enabled" => true, "ach_payments_enabled" => true,
        "gifting_disabled" => true, "link_disabled" => true, "paypal_card_funding_disabled" => true
      )
    end

    it "lists the seller's checkout custom fields and leaves out post-purchase ones", parity: true do
      create(:custom_field, seller:, name: "Phone", global: true, required: true)
      create(:custom_field, seller:, name: "https://example.com/terms", field_type: "terms", global: true)
      create(:custom_field, seller:, name: "After the sale", is_post_purchase: true, global: true)
      log_in(seller)

      get checkout_form_path

      expect(inertia_props_of(response)["custom_fields"].map { _1.slice("name", "type", "required", "global") }).to eq(
        [
          { "name" => "Phone", "type" => "text", "required" => true, "global" => true },
          { "name" => "https://example.com/terms", "type" => "terms", "required" => false, "global" => true },
        ]
      )
    end

    it "answers an Inertia visit with the page as JSON", parity: true do
      log_in(seller)

      get checkout_form_path, headers: { "X-Inertia" => "true", "X-Requested-With" => "XMLHttpRequest" }

      expect(response).to be_successful
      expect(response.parsed_body["component"]).to eq("Checkout/Form/Show")
    end

    it "offers PayPal Connect to a seller from a supported country who has a bank account", parity: true do
      create(:ach_account, user: seller)
      create(:user_compliance_info, user: seller, country: "United States")
      log_in(seller)

      get checkout_form_path

      expect(inertia_props_of(response)["paypal_connect"]).to include("show_paypal_connect" => true, "allow_paypal_connect" => true, "charge_processor_merchant_id" => nil)
    end

    it "hides the connect section for a seller from a country PayPal Connect does not serve", parity: true do
      create(:user_compliance_info, user: seller, country: "Brazil")
      log_in(seller)

      get checkout_form_path

      expect(inertia_props_of(response)["paypal_connect"]).to include("show_paypal_connect" => false, "allow_paypal_connect" => true)
    end

    it "points a seller with a payout email to the PayPal email setup", parity: true do
      seller.update!(payment_address: "payouts@example.com")
      log_in(seller)

      get checkout_form_path

      expect(inertia_props_of(response)["paypal_connect"]).to include("allow_paypal_connect" => true, "payout_setup_method" => "paypal_email")
    end

    it "lets a support team member in", parity: true do
      sign_in_as_team_member(TeamMembership::ROLE_SUPPORT)

      get checkout_form_path

      expect(response).to be_successful
      expect(inertia_props_of(response)["paypal_connect"]).to include("show_paypal_connect" => false)
    end

    it "lets an accountant team member in", parity: true do
      sign_in_as_team_member(TeamMembership::ROLE_ACCOUNTANT)

      get checkout_form_path

      expect(response).to be_successful
    end

    it "lets an admin team member in", parity: true do
      create(:user_compliance_info, user: seller, country: "United States")
      sign_in_as_team_member(TeamMembership::ROLE_ADMIN)

      get checkout_form_path

      expect(inertia_props_of(response)["paypal_connect"]).to include("show_paypal_connect" => true)
    end

    it "previews checkout with the seller's product", parity: true do
      create(:product, user: seller, name: "Design course", price_cents: 1500, created_at: Time.utc(2025, 1, 2))
      log_in(seller)

      get checkout_form_path

      expect(response).to be_successful
      props = inertia_props_of(response)
      expect(props["cart_item"]["product"]).to include("name" => "Design course", "price_cents" => 1500, "cross_sells" => [], "upsell" => nil)
      expect(props["card_product"]).to include("name" => "Design course", "price_cents" => 1500)
    end

    it "previews the newest product and lists them all, archived ones included", parity: true do
      create(:product, user: seller, name: "Old course", archived: true, created_at: Time.utc(2025, 1, 1))
      create(:product, user: seller, name: "New course", price_cents: 700, created_at: Time.utc(2025, 3, 1))
      log_in(seller)

      get checkout_form_path

      props = inertia_props_of(response)
      expect(props["cart_item"]["product"]["name"]).to eq("New course")
      expect(props["products"].map { _1.slice("name", "archived") }).to eq([{ "name" => "New course", "archived" => false }, { "name" => "Old course", "archived" => true }])
    end

    it "previews a lone archived product", parity: true do
      create(:product, user: seller, name: "Old course", archived: true)
      log_in(seller)

      get checkout_form_path

      expect(inertia_props_of(response)["products"]).to eq([{ "id" => Link.last.external_id, "name" => "Old course", "archived" => true }])
    end

    it "carries the seller's settings, custom fields and offer codes into the cart item", parity: true do
      seller.update!(display_offer_code_field: true, tipping_enabled: true, gifting_disabled: true, link_disabled: true, paypal_card_funding_disabled: true)
      product = create(:product, user: seller, name: "Workshop", price_cents: 2500, customizable_price: true, suggested_price_cents: 3000, quantity_enabled: true, max_purchase_count: 10, created_at: Time.utc(2025, 1, 2))
      create(:custom_field, seller:, name: "Phone", global: true, required: true)
      create(:custom_field, seller:, name: "Company", products: [product], required: false)
      create(:custom_field, seller:, name: "After the sale", is_post_purchase: true, global: true)
      create(:offer_code, user: seller, products: [product], code: "SAVE")
      log_in(seller)

      get checkout_form_path

      cart_product = inertia_props_of(response)["cart_item"]["product"]
      expect(cart_product).to include("has_offer_codes" => true, "has_tipping_enabled" => true, "can_gift" => false, "link_disabled" => true, "paypal_card_funding_disabled" => true,
                                      "is_quantity_enabled" => true, "pwyw" => { "suggested_price_cents" => 3000 })
      expect(cart_product["custom_fields"].map { _1["name"] }).to eq(%w[Phone Company])
    end

    it "previews a product with options and a universal offer code", parity: true do
      seller.update!(display_offer_code_field: true)
      create(:product_with_digital_versions, user: seller, name: "Versions", created_at: Time.utc(2025, 1, 2))
      create(:universal_offer_code, user: seller)
      log_in(seller)

      get checkout_form_path

      cart_item = inertia_props_of(response)["cart_item"]
      expect(cart_item["product"]["has_offer_codes"]).to eq(true)
      expect(cart_item["option_id"]).to be_present
    end

    it "hands a seller with a physical product to Rails", parity: true do
      create(:physical_product, user: seller, name: "Poster", created_at: Time.utc(2025, 1, 2))
      log_in(seller)

      get checkout_form_path

      expect(inertia_props_of(response)["cart_item"]["product"]).to include("require_shipping" => true)
    end

    it "previews the first available tier of the seller's membership", parity: true do
      create(:membership_product_with_preset_tiered_pricing, user: seller, name: "Club", created_at: Time.utc(2025, 1, 2))
      log_in(seller)

      get checkout_form_path

      cart_item = inertia_props_of(response)["cart_item"]
      expect(cart_item["product"]["is_tiered_membership"]).to eq(true)
      expect(cart_item).to include("price" => 300, "recurrence" => "monthly")
    end

    it "previews a rental product", parity: true do
      create(:product, user: seller, name: "Film", price_cents: 1500, purchase_type: :buy_and_rent, rental_price_cents: 400, created_at: Time.utc(2025, 1, 2))
      log_in(seller)

      get checkout_form_path

      expect(inertia_props_of(response)["cart_item"]["product"]["rental"]).to eq("price_cents" => 400, "rent_only" => false)
    end

    it "previews a legacy subscription", parity: true do
      create(:subscription_product, user: seller, name: "Legacy", price_cents: 700, created_at: Time.utc(2025, 1, 2))
      log_in(seller)

      get checkout_form_path

      expect(inertia_props_of(response)["cart_item"]).to include("price" => 700, "recurrence" => "monthly")
    end

    it "previews the upsell of the seller's product", parity: true do
      product = create(:product, user: seller, name: "Base", created_at: Time.utc(2025, 1, 2))
      create(:upsell, seller:, product:, name: "Pro", text: "Go Pro", description: "See https://example.com/pro")
      log_in(seller)

      get checkout_form_path

      expect(inertia_props_of(response)["cart_item"]["product"]["upsell"]).to include("text" => "Go Pro")
    end

    it "previews the cross-sells of the seller's product", parity: true do
      product = create(:product, user: seller, name: "Base", created_at: Time.utc(2025, 1, 2))
      offered = create(:product, user: seller, name: "Extra", price_cents: 500, created_at: Time.utc(2025, 1, 1))
      code = create(:offer_code, user: seller, products: [offered], amount_cents: nil, amount_percentage: 20, code: "XSELL")
      create(:upsell, seller:, product: offered, name: "Add", cross_sell: true, selected_products: [product], offer_code: code)
      log_in(seller)

      get checkout_form_path

      cross_sell = inertia_props_of(response)["cart_item"]["product"]["cross_sells"].sole
      expect(cross_sell["offered_product"]["product"]["name"]).to eq("Extra")
      expect(cross_sell["discount"]).to include("percents" => 20)
    end

    it "previews a bundle with its products", parity: true do
      bundle = create(:product, :bundle, user: seller, price_cents: 1500, created_at: Time.utc(2025, 3, 1))
      bundle.bundle_products.each_with_index { |bundle_product, index| bundle_product.product.update_columns(created_at: Time.utc(2025, 1, 1 + index)) }
      log_in(seller)

      get checkout_form_path

      expect(inertia_props_of(response)["cart_item"]["product"]["bundle_products"].map { _1["name"] }).to eq(["Bundle Product 1", "Bundle Product 2"])
    end

    it "hands a seller whose newest products share a creation time to Rails", parity: true do
      create(:product, user: seller, name: "One", created_at: Time.utc(2025, 1, 2))
      create(:product, user: seller, name: "Two", created_at: Time.utc(2025, 1, 2))
      log_in(seller)

      get checkout_form_path

      expect(response).to be_successful
    end

    it "hands a seller with a connected PayPal account to Rails", parity: true do
      create(:merchant_account_paypal, user: seller)
      log_in(seller)

      get checkout_form_path

      expect(response).to be_successful
    end
  end

  describe "PUT /checkout/form" do
    it "redirects a signed-out visitor to the login page", parity: true do
      put checkout_form_path, params: { user: { tipping_enabled: true } }.to_json, headers: inertia_headers.merge("X-CSRF-Token" => csrf_token)

      expect(response).to have_http_status(:see_other)
      expect(response.location).to end_with(login_path(next: "/checkout/form"))
    end

    it "saves the checkout settings", parity: true do
      log_in(seller)

      send_form(:put, user: { display_offer_code_field: true, recommendation_type: "no_recommendations", tipping_enabled: true, ach_payments_enabled: true, gifting_disabled: true, link_disabled: true, paypal_card_funding_disabled: true })

      expect(response).to have_http_status(:see_other)
      expect(seller.reload).to have_attributes(display_offer_code_field: true, recommendation_type: "no_recommendations", tipping_enabled: true, ach_payments_enabled: true, gifting_disabled: true, link_disabled: true, paypal_card_funding_disabled: true)
    end

    it "clears settings that were on", parity: true do
      seller.update!(tipping_enabled: true, gifting_disabled: true, display_offer_code_field: true)
      log_in(seller)

      send_form(:put, user: { display_offer_code_field: false, tipping_enabled: false, gifting_disabled: false, recommendation_type: "own_products" })

      expect(response).to have_http_status(:see_other)
      expect(seller.reload).to have_attributes(tipping_enabled: false, gifting_disabled: false, display_offer_code_field: false)
    end

    it "answers a PATCH like a PUT", parity: true do
      log_in(seller)

      send_form(:patch, user: { tipping_enabled: true })

      expect(response).to have_http_status(:see_other)
      expect(seller.reload.tipping_enabled).to eq(true)
    end

    it "ignores user attributes the form does not permit", parity: true do
      log_in(seller)

      send_form(:put, user: { name: "Renamed", tipping_enabled: true })

      expect(response).to have_http_status(:see_other)
      expect(seller.reload).to have_attributes(name: "Form Seller", tipping_enabled: true)
    end

    it "saves nothing and still confirms when the body has no permitted keys", parity: true do
      log_in(seller)

      send_form(:put, other: "value")

      expect(response).to have_http_status(:see_other)
    end

    it "refuses an unknown recommendation type and keeps the other settings", parity: true do
      log_in(seller)

      send_form(:put, user: { tipping_enabled: true, recommendation_type: "everything" })

      expect(response).to have_http_status(:see_other)
      expect(seller.reload.tipping_enabled).to eq(false)
    end

    it "creates a global custom field", parity: true do
      log_in(seller)

      send_form(:put, custom_fields: [{ type: "text", name: "Phone number", required: true, global: true, collect_per_product: false, products: [] }])

      expect(response).to have_http_status(:see_other)
      expect(seller.custom_fields.last).to have_attributes(name: "Phone number", field_type: "text", required: true, global: true, collect_per_product: false)
    end

    it "creates custom fields for chosen products in the order sent", parity: true do
      first = create(:product, user: seller, name: "First")
      second = create(:product, user: seller, name: "Second")
      log_in(seller)

      send_form(:put, custom_fields: [
                  { type: "checkbox", name: "Subscribe me", required: false, global: false, collect_per_product: true, products: [second.external_id, first.external_id] },
                  { type: "long_text", name: "Notes", required: false, global: false, collect_per_product: false, products: [first.external_id] },
                ])

      expect(response).to have_http_status(:see_other)
      expect(seller.custom_fields.order(:id).map { [_1.name, _1.products.order(:id).pluck(:id)] }).to eq([["Subscribe me", [first.id, second.id]], ["Notes", [first.id]]])
      expect(seller.custom_fields.first.collect_per_product).to eq(true)
    end

    it "ignores products that belong to another seller", parity: true do
      mine = create(:product, user: seller)
      foreign = create(:product)
      log_in(seller)

      send_form(:put, custom_fields: [{ type: "text", name: "Company", global: false, products: [foreign.external_id, mine.external_id, "not-an-id"] }])

      expect(response).to have_http_status(:see_other)
      expect(seller.custom_fields.last.products).to eq([mine])
    end

    it "updates an existing field and replaces its products", parity: true do
      keep = create(:product, user: seller, name: "Keep")
      drop = create(:product, user: seller, name: "Drop")
      add = create(:product, user: seller, name: "Add")
      field = create(:custom_field, seller:, name: "Old label", products: [keep, drop])
      log_in(seller)

      send_form(:put, custom_fields: [{ id: field.external_id, type: "text", name: "New label", required: true, global: false, collect_per_product: false, products: [keep.external_id, add.external_id] }])

      expect(response).to have_http_status(:see_other)
      expect(field.reload).to have_attributes(name: "New label", required: true)
      expect(field.products.order(:id).pluck(:id)).to eq([keep.id, add.id])
    end

    it "drops a field's products when it becomes global", parity: true do
      product = create(:product, user: seller)
      field = create(:custom_field, seller:, name: "Scoped", products: [product])
      log_in(seller)

      send_form(:put, custom_fields: [{ id: field.external_id, type: "text", name: "Scoped", global: true, products: [product.external_id] }])

      expect(response).to have_http_status(:see_other)
      expect(field.reload).to have_attributes(global: true)
      expect(field.products).to be_empty
    end

    it "deletes the fields the form no longer sends, post-purchase ones included", parity: true do
      product = create(:product, user: seller)
      kept = create(:custom_field, seller:, name: "Kept", global: true)
      create(:custom_field, seller:, name: "Gone", products: [product])
      create(:custom_field, seller:, name: "Gone too", is_post_purchase: true, global: true)
      log_in(seller)

      send_form(:put, custom_fields: [{ id: kept.external_id, type: "text", name: "Kept", global: true }])

      expect(response).to have_http_status(:see_other)
      expect(seller.custom_fields.reload.pluck(:name)).to eq(["Kept"])
      expect(CustomField.count).to eq(1)
    end

    it "deletes every field when the form sends an empty list", parity: true do
      create(:custom_field, seller:, name: "Only one", global: true)
      log_in(seller)

      send_form(:put, custom_fields: [])

      expect(response).to have_http_status(:see_other)
      expect(CustomField.count).to eq(0)
    end

    it "leaves another seller's fields alone", parity: true do
      other = create(:custom_field, name: "Not mine", global: true)
      log_in(seller)

      send_form(:put, custom_fields: [{ type: "text", name: "Mine", global: true }])

      expect(response).to have_http_status(:see_other)
      expect(other.reload.name).to eq("Not mine")
    end

    it "treats an id that is not one of the seller's fields as a new field", parity: true do
      other = create(:custom_field, name: "Not mine", global: true)
      log_in(seller)

      send_form(:put, custom_fields: [{ id: other.external_id, type: "text", name: "Mine", global: true }])

      expect(response).to have_http_status(:see_other)
      expect(other.reload.name).to eq("Not mine")
      expect(seller.custom_fields.pluck(:name)).to eq(["Mine"])
    end

    it "names a file upload field when the label is blank", parity: true do
      log_in(seller)

      send_form(:put, custom_fields: [{ type: "file", name: "", global: true }])

      expect(response).to have_http_status(:see_other)
      expect(seller.custom_fields.last.name).to eq("File upload")
    end

    it "refuses a blank label and rolls back the settings sent with it", parity: true do
      log_in(seller)

      send_form(:put, user: { tipping_enabled: true }, custom_fields: [{ type: "text", name: "", global: true }])

      expect(response).to have_http_status(:see_other)
      expect(seller.reload.tipping_enabled).to eq(false)
      expect(CustomField.count).to eq(0)
    end

    it "refuses a field type the form does not offer", parity: true do
      log_in(seller)

      send_form(:put, custom_fields: [{ type: "date", name: "Birthday", global: true }])

      expect(response).to have_http_status(:see_other)
      expect(CustomField.count).to eq(0)
    end

    it "refuses a terms field whose label is not a link", parity: true do
      log_in(seller)

      send_form(:put, custom_fields: [{ type: "terms", name: "I agree", global: true }])

      expect(response).to have_http_status(:see_other)
      expect(CustomField.count).to eq(0)
    end

    it "refuses a boolean field that already is a post-purchase one", parity: true do
      field = create(:custom_field, seller:, name: "After", is_post_purchase: true, global: true)
      log_in(seller)

      send_form(:put, custom_fields: [{ id: field.external_id, type: "checkbox", name: "After", global: true }])

      expect(response).to have_http_status(:see_other)
      expect(field.reload.field_type).to eq("text")
    end

    it "lets a marketing team member save", parity: true do
      sign_in_as_team_member(TeamMembership::ROLE_MARKETING)

      send_form(:put, user: { tipping_enabled: true })

      expect(response).to have_http_status(:see_other)
      expect(seller.reload.tipping_enabled).to eq(true)
    end

    it "lets an admin team member save", parity: true do
      sign_in_as_team_member(TeamMembership::ROLE_ADMIN)

      send_form(:put, custom_fields: [{ type: "text", name: "Phone", global: true }])

      expect(response).to have_http_status(:see_other)
      expect(seller.custom_fields.pluck(:name)).to eq(["Phone"])
    end

    it "sends a support team member back to the dashboard", parity: true do
      sign_in_as_team_member(TeamMembership::ROLE_SUPPORT)

      send_form(:put, user: { tipping_enabled: true })

      expect(response).to have_http_status(:see_other)
      expect(seller.reload.tipping_enabled).to eq(false)
    end

    it "sends an accountant team member back to the dashboard", parity: true do
      sign_in_as_team_member(TeamMembership::ROLE_ACCOUNTANT)

      send_form(:put, custom_fields: [{ type: "text", name: "Phone", global: true }])

      expect(response).to have_http_status(:see_other)
      expect(CustomField.count).to eq(0)
    end

    it "hands a custom fields list that is not a list to Rails", parity: true do
      log_in(seller)

      send_form(:put, custom_fields: "Phone")

      expect(response).to have_http_status(:see_other)
    end

    it "hands a field with a flag sent as text to Rails", parity: true do
      log_in(seller)

      send_form(:put, custom_fields: [{ type: "text", name: "Phone", required: "yes", global: "false" }])

      expect(response).to have_http_status(:see_other)
    end

    it "hands a request whose user settings are not a hash to Rails", parity: true do
      log_in(seller)

      send_form(:put, user: "tipping_enabled")

      expect(response).to have_http_status(:see_other)
    end
  end
end
