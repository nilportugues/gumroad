# frozen_string_literal: true

require "spec_helper"

# The guards Node answers for the writes behind the checkout dashboard and the Customers page: discounts create/update/destroy,
# upsells create/update, and a purchase's ping and option change. Recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/checkout-write-guards.replay.test.ts, which sends the last request of each example. An example named
# "hands a ..." records what Node passes to Rails whole.
describe "Checkout and customer write guards", type: :request do
  include Parity::AudienceSignedIn

  let(:seller) { create(:user, name: "Write Guard Seller", username: "writeguard", created_at: Time.utc(2025, 1, 1)) }
  let(:other_seller) { create(:user, name: "Other Write Guard Seller", username: "otherwriteguard") }
  let(:json_headers) { { "Accept" => "application/json", "Content-Type" => "application/json" } }

  before { host! DOMAIN }

  def send_json(method, path, body = {})
    token = csrf_token
    public_send(method, path, params: body.to_json, headers: json_headers.merge("X-CSRF-Token" => token))
  end

  def as_team_member(role)
    member = create(:user, name: "#{role.capitalize} Member")
    membership = create(:team_membership, user: member, seller:, role:)
    log_in(member)
    switch_to(membership)
    member
  end

  def discount_for(owner)
    create(:offer_code, user: owner, code: "guard#{owner.id}", amount_percentage: 10, amount_cents: nil, products: [])
  end

  # A save in the same second as the factory leaves updated_at unchanged, which a replay seeded a second later would not reproduce.
  def age(record)
    record.update_columns(created_at: 5.minutes.ago, updated_at: 5.minutes.ago)
  end

  # The payload the dashboard form sends (app/javascript/data/offer_code.ts#buildDiscountPayload).
  def discount_payload(overrides = {})
    {
      name: "Guard", code: "guard10", amount_percentage: 10, amount_cents: nil, selected_product_ids: [], selected_option_ids: [],
      excluded_product_ids: [], universal: false, max_purchase_count: nil, currency_type: nil, valid_at: nil, expires_at: nil,
      minimum_quantity: nil, duration_in_billing_cycles: nil, minimum_amount_cents: nil, once_per_cart: false,
      existing_customers_only: false, new_customers_only: false, auto_apply: false, sale_label: nil, ownership_product_ids: [],
      ownership_duration_tiers: nil
    }.merge(overrides)
  end

  def product_for(owner, **attributes)
    create(:product, user: owner, price_cents: 1000, **attributes)
  end

  def product_code(owner, product, **attributes)
    create(:offer_code, user: owner, code: "code#{product.id}", amount_percentage: 10, amount_cents: nil, products: [product], **attributes)
  end

  describe "POST /checkout/discounts" do
    it "refuses a support team member", parity: true do
      as_team_member(:support)

      send_json(:post, checkout_discounts_path, name: "Guard", code: "guard10", amount_percentage: 10)

      expect(response).to have_http_status(:unauthorized)
      expect(response.parsed_body["error"]).to include("Support")
    end

    it "creates a percentage code for a product", parity: true do
      product = product_for(seller)
      log_in(seller)

      send_json(:post, checkout_discounts_path, discount_payload(selected_product_ids: [product.external_id]))

      expect(response.parsed_body["success"]).to eq(true)
      expect(seller.offer_codes.pluck(:code)).to eq(["guard10"])
    end

    it "creates a universal fixed-amount code for a marketing team member", parity: true do
      product_for(seller)
      as_team_member(:marketing)

      send_json(:post, checkout_discounts_path, discount_payload(code: "off2", name: "Two off", amount_percentage: nil, amount_cents: 200, currency_type: "usd", universal: true, selected_product_ids: nil))

      expect(response.parsed_body["success"]).to eq(true)
    end

    it "creates an auto-applied universal code with a period, a limit and a sale label", parity: true do
      product_for(seller)
      log_in(seller)

      send_json(:post, checkout_discounts_path, discount_payload(
        code: "summer", universal: true, selected_product_ids: nil, max_purchase_count: 50, minimum_amount_cents: 500,
        valid_at: "2030-01-01T10:00:00.000Z", expires_at: "2030-02-01T10:00:00.000Z", auto_apply: true, sale_label: "Summer sale"
      ))

      expect(response.parsed_body["success"]).to eq(true)
    end

    it "lists the new code with the codes the seller already has", parity: true do
      product = product_for(seller)
      older = product_code(seller, product, name: "Older")
      age(older)
      other = product_for(seller, name: "Second product")
      log_in(seller)

      send_json(:post, checkout_discounts_path, discount_payload(code: "second", selected_product_ids: [other.external_id]))

      expect(response.parsed_body["offer_codes"].map { _1["code"] }).to eq(["second", "code#{product.id}"])
    end

    it "refuses a code another code of the product already uses", parity: true do
      product = product_for(seller)
      product_code(seller, product, code: "taken")
      log_in(seller)

      send_json(:post, checkout_discounts_path, discount_payload(code: "taken", selected_product_ids: [product.external_id]))

      expect(response.parsed_body).to eq("success" => false, "error_message" => "Discount code must be unique.")
      expect(seller.offer_codes.count).to eq(1)
    end

    it "refuses a code with no characters", parity: true do
      product = product_for(seller)
      log_in(seller)

      send_json(:post, checkout_discounts_path, discount_payload(code: "  ", selected_product_ids: [product.external_id]))

      expect(response.parsed_body["error_message"]).to eq("Discount code can't be blank")
    end

    it "refuses a code with a character it cannot hold", parity: true do
      product = product_for(seller)
      log_in(seller)

      send_json(:post, checkout_discounts_path, discount_payload(code: "bad code!", selected_product_ids: [product.external_id]))

      expect(response.parsed_body["error_message"]).to include("can only contain numbers, letters, dashes, and underscores")
    end

    it "refuses a percentage above 100", parity: true do
      product = product_for(seller)
      log_in(seller)

      send_json(:post, checkout_discounts_path, discount_payload(amount_percentage: 150, selected_product_ids: [product.external_id]))

      expect(response.parsed_body["error_message"]).to eq("Please enter a discount amount that is 100% or less.")
    end

    it "refuses a price after the discount that is below the minimum", parity: true do
      product = product_for(seller)
      log_in(seller)

      send_json(:post, checkout_discounts_path, discount_payload(amount_percentage: nil, amount_cents: 995, currency_type: "usd", selected_product_ids: [product.external_id]))

      expect(response.parsed_body["error_message"]).to include("must be either $0 or at least")
    end

    it "refuses an end date before the start date", parity: true do
      product = product_for(seller)
      log_in(seller)

      send_json(:post, checkout_discounts_path, discount_payload(valid_at: "2030-02-01T10:00:00.000Z", expires_at: "2030-01-01T10:00:00.000Z", selected_product_ids: [product.external_id]))

      expect(response.parsed_body["error_message"]).to eq("The discount code's start date must be earlier than its end date.")
    end

    it "refuses an automatic discount that is not universal", parity: true do
      product = product_for(seller)
      log_in(seller)

      send_json(:post, checkout_discounts_path, discount_payload(auto_apply: true, selected_product_ids: [product.external_id]))

      expect(response.parsed_body["error_message"]).to eq("Only a discount that applies to all products can be applied automatically.")
    end

    it "refuses a second automatic discount", parity: true do
      product_for(seller)
      create(:offer_code, user: seller, code: "auto1", amount_percentage: 10, amount_cents: nil, universal: true, auto_apply: true, products: [])
      log_in(seller)

      send_json(:post, checkout_discounts_path, discount_payload(code: "auto2", universal: true, selected_product_ids: nil, auto_apply: true))

      expect(response.parsed_body["error_message"]).to eq("Another discount (auto1) is already applied automatically. Turn it off first.")
    end

    it "ignores a product of another seller", parity: true do
      foreign = product_for(other_seller)
      log_in(seller)

      send_json(:post, checkout_discounts_path, discount_payload(selected_product_ids: [foreign.external_id, "unknownid"]))

      expect(response.parsed_body["success"]).to eq(true)
    end

    it "hands a code on a membership to Rails", parity: true do
      membership = create(:membership_product, user: seller, price_cents: 1000)
      log_in(seller)

      send_json(:post, checkout_discounts_path, discount_payload(selected_product_ids: [membership.external_id]))

      expect(response.parsed_body["success"]).to eq(true)
    end

    it "hands a code on a product with options to Rails", parity: true do
      product = product_for(seller)
      category = create(:variant_category, link: product)
      create(:variant, variant_category: category, name: "Small")
      log_in(seller)

      send_json(:post, checkout_discounts_path, discount_payload(selected_product_ids: [product.external_id]))

      expect(response.parsed_body["success"]).to eq(true)
    end

    it "hands a code limited to some options to Rails", parity: true do
      product = product_for(seller)
      category = create(:variant_category, link: product)
      variant = create(:variant, variant_category: category, name: "Small")
      log_in(seller)

      send_json(:post, checkout_discounts_path, discount_payload(selected_product_ids: [product.external_id], selected_option_ids: [variant.external_id]))

      expect(response.parsed_body["success"]).to eq(true)
    end

    it "hands a code with a duration in billing cycles to Rails", parity: true do
      product = product_for(seller)
      log_in(seller)

      send_json(:post, checkout_discounts_path, discount_payload(selected_product_ids: [product.external_id], duration_in_billing_cycles: 3))

      expect(response.parsed_body).to include("success")
    end

    it "hands a universal code with an excluded product to Rails", parity: true do
      product = product_for(seller)
      log_in(seller)

      send_json(:post, checkout_discounts_path, discount_payload(universal: true, selected_product_ids: nil, excluded_product_ids: [product.external_id]))

      expect(response.parsed_body["success"]).to eq(true)
    end

    it "hands a code for existing customers to Rails", parity: true do
      product = product_for(seller)
      log_in(seller)

      send_json(:post, checkout_discounts_path, discount_payload(existing_customers_only: true, ownership_product_ids: [product.external_id], selected_product_ids: [product.external_id]))

      expect(response.parsed_body["success"]).to eq(true)
    end

    it "hands a code per cart to Rails", parity: true do
      product = product_for(seller)
      log_in(seller)

      send_json(:post, checkout_discounts_path, discount_payload(amount_percentage: nil, amount_cents: 200, currency_type: "usd", once_per_cart: true, minimum_quantity: 2, selected_product_ids: [product.external_id]))

      expect(response.parsed_body["success"]).to eq(true)
    end

    it "hands a create that carries listing parameters to Rails", parity: true do
      product = product_for(seller)
      log_in(seller)

      send_json(:post, checkout_discounts_path, discount_payload(selected_product_ids: [product.external_id], query: "guard"))

      expect(response.parsed_body["success"]).to eq(true)
    end
  end

  describe "PUT /checkout/discounts/:id" do
    it "answers 404 for a code that does not exist", parity: true do
      log_in(seller)

      send_json(:put, checkout_discount_path("unknownid"), name: "Renamed")

      expect(response).to have_http_status(:not_found)
    end

    it "refuses a seller who edits the code of another seller", parity: true do
      code = discount_for(other_seller)
      log_in(seller)

      send_json(:put, checkout_discount_path(code.external_id), name: "Renamed")

      expect(response).to have_http_status(:unauthorized)
    end

    it "refuses an accountant team member", parity: true do
      code = discount_for(seller)
      as_team_member(:accountant)

      send_json(:put, checkout_discount_path(code.external_id), name: "Renamed")

      expect(response).to have_http_status(:unauthorized)
    end

    it "renames the code of a product for the owner", parity: true do
      product = product_for(seller)
      code = product_code(seller, product, name: "Old name")
      age(code)
      log_in(seller)

      send_json(:put, checkout_discount_path(code.external_id), discount_payload(name: "Renamed", code: code.code, selected_product_ids: [product.external_id]))

      expect(response.parsed_body["success"]).to eq(true)
      expect(code.reload.name).to eq("Renamed")
    end

    it "changes the amount, limit and period of a universal code for an admin team member", parity: true do
      product_for(seller)
      code = create(:offer_code, user: seller, code: "all#{seller.id}", amount_percentage: 20, amount_cents: nil, universal: true, products: [])
      age(code)
      as_team_member(:admin)

      send_json(:put, checkout_discount_path(code.external_id), discount_payload(
        code: code.code, amount_percentage: 25, universal: true, selected_product_ids: nil, max_purchase_count: 30,
        minimum_amount_cents: 300, valid_at: "2030-01-01T10:00:00.000Z", expires_at: "2030-03-01T10:00:00.000Z"
      ))

      expect(response.parsed_body["success"]).to eq(true)
      expect(code.reload.amount_percentage).to eq(25)
    end

    it "turns a fixed-amount code into a percentage code", parity: true do
      product = product_for(seller)
      code = product_code(seller, product, amount_percentage: nil, amount_cents: 200, currency_type: "usd")
      age(code)
      log_in(seller)

      send_json(:put, checkout_discount_path(code.external_id), discount_payload(code: code.code, amount_percentage: 30, amount_cents: nil, selected_product_ids: [product.external_id]))

      expect(response.parsed_body["success"]).to eq(true)
      expect(code.reload).to have_attributes(amount_percentage: 30, amount_cents: nil, currency_type: nil)
    end

    it "turns a percentage code into a fixed-amount code", parity: true do
      product = product_for(seller)
      code = product_code(seller, product)
      age(code)
      log_in(seller)

      send_json(:put, checkout_discount_path(code.external_id), discount_payload(code: code.code, amount_percentage: nil, amount_cents: 300, currency_type: "usd", selected_product_ids: [product.external_id]))

      expect(response.parsed_body["success"]).to eq(true)
      expect(code.reload).to have_attributes(amount_percentage: nil, amount_cents: 300, currency_type: "usd")
    end

    it "drops the currency of a fixed-amount code when the request names none", parity: true do
      product = product_for(seller)
      code = product_code(seller, product, amount_percentage: nil, amount_cents: 200, currency_type: "usd")
      age(code)
      log_in(seller)

      send_json(:put, checkout_discount_path(code.external_id), name: "Renamed")

      expect(response.parsed_body["success"]).to eq(true)
      expect(code.reload).to have_attributes(name: "Renamed", amount_cents: 200, currency_type: nil)
    end

    it "keeps the products of a code when the request names none", parity: true do
      product = product_for(seller)
      code = product_code(seller, product)
      age(code)
      log_in(seller)

      send_json(:put, checkout_discount_path(code.external_id), name: "Renamed", sale_label: "Ignored")

      expect(response.parsed_body["success"]).to eq(true)
      expect(code.reload.products).to eq([product])
    end

    it "makes the code the first of the list", parity: true do
      product = product_for(seller)
      code = product_code(seller, product, name: "Older")
      age(code)
      newer = product_code(seller, product_for(seller, name: "Other"), name: "Newer")
      newer.update_columns(updated_at: 2.minutes.ago)
      log_in(seller)

      send_json(:put, checkout_discount_path(code.external_id), discount_payload(name: "Older again", code: code.code, selected_product_ids: [product.external_id]))

      expect(response.parsed_body["offer_codes"].map { _1["name"] }).to eq(["Older again", "Newer"])
    end

    it "refuses a percentage above 100", parity: true do
      product = product_for(seller)
      code = product_code(seller, product)
      age(code)
      log_in(seller)

      send_json(:put, checkout_discount_path(code.external_id), discount_payload(code: code.code, amount_percentage: 150, selected_product_ids: [product.external_id]))

      expect(response.parsed_body).to eq("success" => false, "error_message" => "Please enter a discount amount that is 100% or less.")
      expect(code.reload.amount_percentage).to eq(10)
    end

    it "refuses an end date before the start date", parity: true do
      product = product_for(seller)
      code = product_code(seller, product)
      age(code)
      log_in(seller)

      send_json(:put, checkout_discount_path(code.external_id), discount_payload(code: code.code, valid_at: "2030-02-01T10:00:00.000Z", expires_at: "2030-01-01T10:00:00.000Z", selected_product_ids: [product.external_id]))

      expect(response.parsed_body["error_message"]).to eq("The discount code's start date must be earlier than its end date.")
    end

    it "refuses a limit below the number of uses", parity: true do
      product = product_for(seller)
      code = product_code(seller, product)
      build(:purchase, link: product, offer_code: code, purchase_state: "successful").save!(validate: false)
      age(code)
      log_in(seller)

      send_json(:put, checkout_discount_path(code.external_id), discount_payload(code: code.code, max_purchase_count: 0, selected_product_ids: [product.external_id]))

      expect(response.parsed_body["error_message"]).to include("no less than 1")
    end

    it "refuses to turn on the automatic discount of a code that is not universal", parity: true do
      product = product_for(seller)
      code = product_code(seller, product)
      age(code)
      log_in(seller)

      send_json(:put, checkout_discount_path(code.external_id), discount_payload(code: code.code, auto_apply: true, selected_product_ids: [product.external_id]))

      expect(response.parsed_body["error_message"]).to eq("Only a discount that applies to all products can be applied automatically.")
    end

    it "refuses a second automatic discount", parity: true do
      product_for(seller)
      create(:offer_code, user: seller, code: "auto1", amount_percentage: 10, amount_cents: nil, universal: true, auto_apply: true, products: [])
      code = create(:offer_code, user: seller, code: "auto2", amount_percentage: 10, amount_cents: nil, universal: true, products: [])
      age(code)
      log_in(seller)

      send_json(:put, checkout_discount_path(code.external_id), discount_payload(code: code.code, universal: true, selected_product_ids: nil, auto_apply: true))

      expect(response.parsed_body["error_message"]).to eq("Another discount (auto1) is already applied automatically. Turn it off first.")
    end

    it "hands a change of products to Rails", parity: true do
      product = product_for(seller)
      code = product_code(seller, product)
      other = product_for(seller, name: "Second product")
      log_in(seller)

      send_json(:put, checkout_discount_path(code.external_id), discount_payload(code: code.code, selected_product_ids: [product.external_id, other.external_id]))

      expect(response.parsed_body["success"]).to eq(true)
    end

    it "hands a switch to all products to Rails", parity: true do
      product = product_for(seller)
      code = product_code(seller, product)
      log_in(seller)

      send_json(:put, checkout_discount_path(code.external_id), discount_payload(code: code.code, universal: true, selected_product_ids: nil))

      expect(response.parsed_body["success"]).to eq(true)
    end

    it "hands a switch of a code without products to all products to Rails", parity: true do
      product_for(seller)
      code = create(:offer_code, user: seller, code: "none#{seller.id}", amount_percentage: 10, amount_cents: nil, products: [])
      log_in(seller)

      send_json(:put, checkout_discount_path(code.external_id), discount_payload(code: code.code, universal: true, selected_product_ids: nil))

      expect(response.parsed_body["success"]).to eq(true)
    end

    it "hands the code that is the default discount of a product to Rails", parity: true do
      product = product_for(seller)
      code = product_code(seller, product)
      product.update_columns(default_offer_code_id: code.id)
      log_in(seller)

      send_json(:put, checkout_discount_path(code.external_id), discount_payload(code: code.code, selected_product_ids: [product.external_id]))

      expect(response.parsed_body["success"]).to eq(true)
    end

    it "hands a deleted code to Rails", parity: true do
      product = product_for(seller)
      code = product_code(seller, product)
      code.update_columns(deleted_at: 5.minutes.ago)
      log_in(seller)

      send_json(:put, checkout_discount_path(code.external_id), discount_payload(code: code.code, selected_product_ids: [product.external_id]))

      expect(response.parsed_body["success"]).to eq(true)
    end

    it "hands a code on a membership to Rails", parity: true do
      membership = create(:membership_product, user: seller, price_cents: 1000)
      code = product_code(seller, membership)
      log_in(seller)

      send_json(:put, checkout_discount_path(code.external_id), discount_payload(code: code.code, selected_product_ids: [membership.external_id]))

      expect(response.parsed_body).to include("success")
    end

    it "hands a universal code with an excluded product to Rails", parity: true do
      product = product_for(seller)
      code = create(:offer_code, user: seller, code: "excl#{seller.id}", amount_percentage: 20, amount_cents: nil, universal: true, products: [])
      code.excluded_products << product
      log_in(seller)

      send_json(:put, checkout_discount_path(code.external_id), discount_payload(code: code.code, universal: true, selected_product_ids: nil, excluded_product_ids: [product.external_id]))

      expect(response.parsed_body["success"]).to eq(true)
    end

    it "hands a save that would drop the excluded product of a code to Rails", parity: true do
      product = product_for(seller)
      code = create(:offer_code, user: seller, code: "drop#{seller.id}", amount_percentage: 20, amount_cents: nil, universal: true, products: [])
      code.excluded_products << product
      log_in(seller)

      send_json(:put, checkout_discount_path(code.external_id), discount_payload(code: code.code, universal: true, selected_product_ids: nil))

      expect(response.parsed_body["success"]).to eq(true)
    end

    it "hands a code for existing customers to Rails", parity: true do
      product = product_for(seller)
      code = product_code(seller, product)
      code.update_columns(existing_customers_only: true)
      log_in(seller)

      send_json(:put, checkout_discount_path(code.external_id), discount_payload(code: code.code, selected_product_ids: [product.external_id]))

      expect(response.parsed_body["success"]).to eq(true)
    end

    it "hands a code with an empty list of duration tiers to Rails", parity: true do
      product = product_for(seller)
      code = product_code(seller, product)
      code.update_columns(ownership_duration_tiers: [])
      log_in(seller)

      send_json(:put, checkout_discount_path(code.external_id), discount_payload(code: code.code, selected_product_ids: [product.external_id]))

      expect(response.parsed_body["success"]).to eq(true)
    end

    it "hands an update that sets a duration in billing cycles to Rails", parity: true do
      product = product_for(seller)
      code = product_code(seller, product)
      log_in(seller)

      send_json(:put, checkout_discount_path(code.external_id), discount_payload(code: code.code, duration_in_billing_cycles: 3, selected_product_ids: [product.external_id]))

      expect(response.parsed_body).to include("success")
    end

    it "hands an update that sets duration tiers to Rails", parity: true do
      product = product_for(seller)
      code = product_code(seller, product)
      log_in(seller)

      send_json(:put, checkout_discount_path(code.external_id), discount_payload(code: code.code, selected_product_ids: [product.external_id], ownership_duration_tiers: [{ months: 3, amount_percentage: 20 }]))

      expect(response.parsed_body).to include("success")
    end
  end

  describe "PATCH /checkout/discounts/:id" do
    it "renames a code with the same answer as PUT", parity: true do
      product = product_for(seller)
      code = product_code(seller, product)
      age(code)
      log_in(seller)

      send_json(:patch, checkout_discount_path(code.external_id), name: "Renamed")

      expect(response.parsed_body["success"]).to eq(true)
    end
  end

  describe "DELETE /checkout/discounts/:id" do
    it "answers 404 for a code that does not exist", parity: true do
      log_in(seller)

      send_json(:delete, checkout_discount_path("unknownid"))

      expect(response).to have_http_status(:not_found)
    end

    it "refuses a support team member", parity: true do
      code = discount_for(seller)
      as_team_member(:support)

      send_json(:delete, checkout_discount_path(code.external_id))

      expect(response).to have_http_status(:unauthorized)
    end

    it "deletes a code of a product for an admin team member", parity: true do
      product = create(:product, user: seller, price_cents: 1000)
      code = create(:offer_code, user: seller, code: "guard#{seller.id}", amount_percentage: 10, amount_cents: nil, products: [product])
      age(code)
      as_team_member(:admin)

      send_json(:delete, checkout_discount_path(code.external_id))

      expect(response.parsed_body).to eq("success" => true)
      expect(code.reload).to be_deleted
    end

    it "deletes a universal code of the owner", parity: true do
      create(:product, user: seller, price_cents: 1000)
      code = create(:offer_code, user: seller, code: "all#{seller.id}", amount_percentage: 20, amount_cents: nil, universal: true, products: [])
      age(code)
      log_in(seller)

      send_json(:delete, checkout_discount_path(code.external_id))

      expect(response.parsed_body).to eq("success" => true)
      expect(code.reload).to be_deleted
    end

    it "deletes a code that was already deleted", parity: true do
      code = discount_for(seller)
      code.update_columns(deleted_at: 5.minutes.ago, updated_at: 5.minutes.ago)
      log_in(seller)

      send_json(:delete, checkout_discount_path(code.external_id))

      expect(response.parsed_body).to eq("success" => true)
    end

    it "refuses to delete the default discount of a product", parity: true do
      product = create(:product, user: seller, price_cents: 1000)
      code = create(:offer_code, user: seller, code: "default#{seller.id}", amount_percentage: 10, amount_cents: nil, products: [product])
      product.update_columns(default_offer_code_id: code.id)
      log_in(seller)

      send_json(:delete, checkout_discount_path(code.external_id))

      expect(response).to have_http_status(:unprocessable_entity)
      expect(response.parsed_body["error_message"]).to include("default discount")
      expect(code.reload).not_to be_deleted
    end

    it "hands the deletion of a universal code with an excluded product to Rails", parity: true do
      product = create(:product, user: seller, price_cents: 1000)
      code = create(:offer_code, user: seller, code: "excl#{seller.id}", amount_percentage: 20, amount_cents: nil, universal: true, products: [])
      code.excluded_products << product
      log_in(seller)

      send_json(:delete, checkout_discount_path(code.external_id))

      expect(response.parsed_body).to eq("success" => true)
    end
  end

  describe "POST /checkout/upsells" do
    it "refuses an accountant team member", parity: true do
      as_team_member(:accountant)

      send_json(:post, checkout_upsells_path, name: "Guard upsell")

      expect(response).to have_http_status(:unauthorized)
    end

    it "hands an upsell from the owner to Rails", parity: true do
      product = create(:product, user: seller)
      log_in(seller)

      send_json(:post, checkout_upsells_path, name: "Guard upsell", text: "Add this", description: "More", product_id: product.external_id, cross_sell: false, universal: false)

      expect(response.parsed_body).to include("success")
    end
  end

  describe "PATCH /checkout/upsells/:id" do
    let(:upsell) { create(:upsell, seller:, product: create(:product, user: seller), name: "Guard upsell") }

    it "answers 404 for an upsell that does not exist", parity: true do
      log_in(seller)

      send_json(:patch, checkout_upsell_path("unknownid"), name: "Renamed")

      expect(response).to have_http_status(:not_found)
    end

    it "answers 404 for the upsell of another seller", parity: true do
      foreign = create(:upsell, seller: other_seller, product: create(:product, user: other_seller), name: "Foreign upsell")
      log_in(seller)

      send_json(:patch, checkout_upsell_path(foreign.external_id), name: "Renamed")

      expect(response).to have_http_status(:not_found)
    end

    it "refuses a support team member", parity: true do
      as_team_member(:support)

      send_json(:patch, checkout_upsell_path(upsell.external_id), name: "Renamed")

      expect(response).to have_http_status(:unauthorized)
    end

    it "hands a rename by the owner to Rails", parity: true do
      log_in(seller)

      send_json(:patch, checkout_upsell_path(upsell.external_id), name: "Renamed", text: "Add this", description: "More", product_id: upsell.product.external_id)

      expect(response.parsed_body).to include("success")
    end
  end

  describe "POST /purchases/:purchase_id/pings" do
    let(:purchase) { create(:free_purchase, link: create(:product, user: seller)) }

    it "answers 404 for a purchase that does not exist", parity: true do
      log_in(seller)

      send_json(:post, purchase_pings_path("unknownid"))

      expect(response).to have_http_status(:not_found)
      expect(response.parsed_body).to eq("success" => false, "error" => "Not found")
    end

    it "answers 404 for the purchase of another seller", parity: true do
      foreign = create(:free_purchase, link: create(:product, user: other_seller))
      log_in(seller)

      send_json(:post, purchase_pings_path(foreign.external_id))

      expect(response).to have_http_status(:not_found)
    end

    it "refuses a marketing team member", parity: true do
      as_team_member(:marketing)

      send_json(:post, purchase_pings_path(purchase.external_id))

      expect(response).to have_http_status(:unauthorized)
    end

    it "hands a ping by the owner to Rails", parity: true do
      allow_any_instance_of(Purchase).to receive(:send_notification_webhook_from_ui)
      log_in(seller)

      send_json(:post, purchase_pings_path(purchase.external_id))

      expect(response).to have_http_status(:no_content)
    end
  end

  describe "PATCH /purchases/:purchase_id/variants/:variant_id" do
    let(:purchase) { create(:free_purchase, link: create(:product, user: seller)) }

    it "answers 404 for a purchase that does not exist", parity: true do
      log_in(seller)

      send_json(:patch, purchase_variant_path("unknownid", "someid"), quantity: 1)

      expect(response).to have_http_status(:not_found)
    end

    it "refuses an accountant team member", parity: true do
      as_team_member(:accountant)

      send_json(:patch, purchase_variant_path(purchase.external_id, "someid"), quantity: 1)

      expect(response).to have_http_status(:unauthorized)
    end

    it "hands an option change by a support team member to Rails", parity: true do
      allow_any_instance_of(Purchase::VariantUpdaterService).to receive(:perform).and_return(true)
      as_team_member(:support)

      send_json(:patch, purchase_variant_path(purchase.external_id, "someid"), quantity: 1)

      expect(response).to have_http_status(:no_content)
    end
  end
end
