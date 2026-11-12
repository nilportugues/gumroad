# frozen_string_literal: true

require "spec_helper"

# Api::Mobile::PurchasesController#archive, #unarchive and #destroy for a plain purchase (no url redirect, preorder, subscription,
# refund or review), which the Next.js port writes itself (nextjs/src/server/controllers/mobile-purchases.ts). `parity_timeline`
# records the order of the statements and jobs inside each write. The examples that end in `hands a ...` are the purchases it
# leaves to Rails whole; the replay asserts Node forwards each one and writes nothing.
describe "Mobile API library writes", type: :request, parity_timeline: true do
  include Parity::MobileApi

  let(:buyer) { create(:user) }
  let(:seller) { create(:user) }
  let(:product) { create(:product, user: seller) }
  let(:merchant_account) { create(:merchant_account, user: seller) }

  # `save!` revalidates the row, and a paid purchase is only valid with its processor details.
  def paid_purchase(**attributes)
    purchase_row(link: product, seller:, purchaser: buyer, email: buyer.email, purchase_state: "successful", stripe_transaction_id: "ch_#{SecureRandom.hex(6)}", stripe_fingerprint: "fp_library", charge_processor_id: StripeChargeProcessor.charge_processor_id, merchant_account:, **attributes)
  end

  let(:purchase) { paid_purchase }

  it "archives the buyer's purchase", parity: true do
    post "/mobile/purchases/#{purchase.external_id}/archive", params: auth(buyer)

    expect(response).to have_http_status(:ok)
    expect(response.parsed_body["product"]).to include("purchase_id" => purchase.external_id, "is_archived" => true)
    expect(purchase.reload.is_archived).to eq(true)
  end

  it "unarchives an archived purchase", parity: true do
    purchase.update_column(:flags, purchase.flags | Purchase.flag_mapping["flags"][:is_archived])

    post "/mobile/purchases/#{purchase.external_id}/unarchive", params: auth(buyer)

    expect(response.parsed_body["product"]).to include("is_archived" => false)
    expect(purchase.reload.is_archived).to eq(false)
  end

  it "archives a purchase that is already archived", parity: true do
    purchase.update_column(:flags, purchase.flags | Purchase.flag_mapping["flags"][:is_archived])

    post "/mobile/purchases/#{purchase.external_id}/archive", params: auth(buyer)

    expect(response.parsed_body["product"]).to include("is_archived" => true)
  end

  it "deletes the purchase from the library", parity: true do
    delete "/mobile/purchases/#{purchase.external_id}", params: auth(buyer)

    expect(response).to have_http_status(:ok)
    expect(response.parsed_body["product"]).to include("purchase_id" => purchase.external_id)
    expect(purchase.reload.is_deleted_by_buyer).to eq(true)
  end

  it "archives an older purchase of a seller in another time zone", parity: true do
    seller.update!(timezone: "Tokyo")
    older = paid_purchase(created_at: 3.days.ago)

    post "/mobile/purchases/#{older.external_id}/archive", params: auth(buyer)

    expect(response).to have_http_status(:ok)
    expect(older.reload.is_archived).to eq(true)
  end

  it "does not find a refunded purchase to archive", parity: true do
    refunded = paid_purchase(stripe_refunded: true)

    post "/mobile/purchases/#{refunded.external_id}/archive", params: auth(buyer)

    expect(response).to have_http_status(:not_found)
    expect(refunded.reload.is_archived).to eq(false)
  end

  it "hands an archive of a purchase whose seller has a post to Rails", parity: true do
    create(:installment, link: product, published_at: Time.current, shown_on_profile: true, send_emails: false)

    post "/mobile/purchases/#{purchase.external_id}/archive", params: auth(buyer)

    expect(response).to have_http_status(:ok)
    expect(purchase.reload.is_archived).to eq(true)
  end
end
