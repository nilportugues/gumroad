# frozen_string_literal: true

require "spec_helper"

# Api::Mobile::SalesController#revoke_access and #undo_revoke_access, which the Next.js port serves itself
# (nextjs/src/server/controllers/mobile-sale-access.ts).
describe "Mobile API sale access", type: :request do
  include Parity::MobileApi

  let(:buyer) { create(:user) }
  let(:seller) { create(:user) }
  let(:product) { create(:product, user: seller) }
  let(:sale) { purchase_row(link: product, seller:, purchaser: buyer, email: buyer.email, purchase_state: "successful") }
  # The two examples that write run `update!`, which revalidates: a row saved with `validate: false` fails it.
  let(:valid_sale) { create(:free_purchase, link: create(:product, user: seller, price_cents: 0), purchaser: buyer, email: buyer.email) }

  describe "revoking access" do
    it "revokes access to the sale", parity: true do
      put "/mobile/sales/#{valid_sale.external_id}/revoke_access", params: auth(seller)

      expect(response.parsed_body).to eq("success" => true)
      expect(valid_sale.reload.is_access_revoked).to eq(true)
    end

    it "does not find a sale that belongs to another seller", parity: true do
      other = purchase_row(link: create(:product), seller: create(:user), purchase_state: "successful")

      put "/mobile/sales/#{other.external_id}/revoke_access", params: auth(seller)

      expect(response).to have_http_status(:not_found)
      expect(response.parsed_body).to eq("success" => false, "message" => "Could not find purchase")
    end

    it "refuses a sale whose access is already revoked", parity: true do
      sale.update_column(:flags, sale.flags | Purchase.flag_mapping["flags"][:is_access_revoked])

      put "/mobile/sales/#{sale.external_id}/revoke_access", params: auth(seller)

      expect(response).to have_http_status(:unauthorized)
      expect(response.parsed_body).to eq("success" => false, "message" => "Not authorized")
    end

    it "refuses a refunded sale", parity: true do
      sale.update_column(:stripe_refunded, true)

      put "/mobile/sales/#{sale.external_id}/revoke_access", params: auth(seller)

      expect(response).to have_http_status(:unauthorized)
      expect(sale.reload.is_access_revoked).to eq(false)
    end

    it "refuses a sale of a physical product", parity: true do
      physical = purchase_row(link: create(:physical_product, user: seller), seller:, purchase_state: "successful")

      put "/mobile/sales/#{physical.external_id}/revoke_access", params: auth(seller)

      expect(response).to have_http_status(:unauthorized)
      expect(physical.reload.is_access_revoked).to eq(false)
    end

    it "refuses a subscription sale", parity: true do
      membership = create(:membership_product, user: seller)
      recurring = purchase_row(link: membership, seller:, purchase_state: "successful", is_original_subscription_purchase: true, subscription: create(:subscription, link: membership, user: buyer))

      put "/mobile/sales/#{recurring.external_id}/revoke_access", params: auth(seller)

      expect(response).to have_http_status(:unauthorized)
      expect(recurring.reload.is_access_revoked).to eq(false)
    end
  end

  describe "undoing the revocation" do
    it "restores access to a revoked sale", parity: true do
      valid_sale.update_column(:flags, valid_sale.flags | Purchase.flag_mapping["flags"][:is_access_revoked])

      put "/mobile/sales/#{valid_sale.external_id}/undo_revoke_access", params: auth(seller)

      expect(response.parsed_body).to eq("success" => true)
      expect(valid_sale.reload.is_access_revoked).to eq(false)
    end

    it "refuses a sale whose access is not revoked", parity: true do
      put "/mobile/sales/#{sale.external_id}/undo_revoke_access", params: auth(seller)

      expect(response).to have_http_status(:unauthorized)
      expect(response.parsed_body).to eq("success" => false, "message" => "Not authorized")
    end

    it "does not find a sale that belongs to another seller", parity: true do
      other = purchase_row(link: create(:product), seller: create(:user), purchase_state: "successful")

      put "/mobile/sales/#{other.external_id}/undo_revoke_access", params: auth(seller)

      expect(response).to have_http_status(:not_found)
    end
  end
end
