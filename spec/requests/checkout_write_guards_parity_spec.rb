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

  describe "POST /checkout/discounts" do
    it "refuses a support team member", parity: true do
      as_team_member(:support)

      send_json(:post, checkout_discounts_path, name: "Guard", code: "guard10", amount_percentage: 10)

      expect(response).to have_http_status(:unauthorized)
      expect(response.parsed_body["error"]).to include("Support")
    end

    it "hands a discount from a marketing team member to Rails", parity: true do
      as_team_member(:marketing)

      send_json(:post, checkout_discounts_path, name: "Guard", code: "guard10", amount_percentage: 10, universal: true, selected_product_ids: [])

      expect(response.parsed_body["success"]).to eq(true)
    end
  end

  describe "PATCH /checkout/discounts/:id" do
    it "answers 404 for a code that does not exist", parity: true do
      log_in(seller)

      send_json(:patch, checkout_discount_path("unknownid"), name: "Renamed")

      expect(response).to have_http_status(:not_found)
    end

    it "refuses a seller who edits the code of another seller", parity: true do
      code = discount_for(other_seller)
      log_in(seller)

      send_json(:patch, checkout_discount_path(code.external_id), name: "Renamed")

      expect(response).to have_http_status(:unauthorized)
    end

    it "refuses an accountant team member", parity: true do
      code = discount_for(seller)
      as_team_member(:accountant)

      send_json(:patch, checkout_discount_path(code.external_id), name: "Renamed")

      expect(response).to have_http_status(:unauthorized)
    end

    it "hands a rename by the owner to Rails", parity: true do
      code = discount_for(seller)
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

    it "hands the deletion of a code by an admin team member to Rails", parity: true do
      code = discount_for(seller)
      as_team_member(:admin)

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
