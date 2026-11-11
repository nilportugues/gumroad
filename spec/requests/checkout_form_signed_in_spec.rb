# frozen_string_literal: true

require "spec_helper"

# The checkout form settings page (Checkout::FormController) when signed in, recorded for the Next.js port (PARITY_RECORD=1)
# and replayed by nextjs/parity/__tests__/checkout-form.replay.test.ts, which sends the last request of each example.
#
# The page's cart item is CheckoutPresenter output for the seller's newest product, and a connected PayPal account is
# fetched live from PayPal, so those pages are "hands a ..." examples: the replay asserts Node passed the request to Rails
# untouched and wrote nothing.
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

    it "hands a seller with products to Rails", parity: true do
      create(:product, user: seller, name: "Design course")
      log_in(seller)

      get checkout_form_path

      expect(response).to be_successful
      expect(inertia_props_of(response)["cart_item"]).to be_present
    end

    it "hands a seller with an archived product to Rails", parity: true do
      create(:product, user: seller, name: "Old course", archived: true)
      log_in(seller)

      get checkout_form_path

      expect(inertia_props_of(response)["products"]).to eq([{ "id" => Link.last.external_id, "name" => "Old course", "archived" => true }])
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
