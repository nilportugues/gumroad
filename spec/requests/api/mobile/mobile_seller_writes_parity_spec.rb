# frozen_string_literal: true

require "spec_helper"

# The Api::Mobile writes and reads the Next.js port answers up to their first write (nextjs/src/server/controllers/mobile-seller-writes.ts):
# the 404s, the comma refusal of a refund amount and an already confirmed address.
# The examples that end in `hands a ...` are the cases it leaves to Rails whole; the replay asserts Node forwards each one and writes nothing.
describe "Mobile API seller writes and the Agent tab", type: :request do
  include Parity::MobileApi

  let(:seller) { create(:user) }
  let(:other_seller) { create(:user) }

  describe "refunds" do
    let(:sale) { purchase_row(link: create(:product, user: seller, price_cents: 500), seller:, email: "customer@example.com", purchase_state: "successful") }

    it "refuses a refund amount with a comma", parity: true do
      patch "/mobile/sales/#{sale.external_id}/refund", params: auth(seller).merge(amount: "1,00")

      expect(response.parsed_body).to eq("success" => false, "message" => "Commas not supported in refund amount.")
    end

    it "answers 404 for a sale that does not exist", parity: true do
      patch "/mobile/sales/xxx/refund", params: auth(seller).merge(amount: "1.00")

      expect(response).to have_http_status(:not_found)
      expect(response.parsed_body).to eq("success" => false, "error" => "Not found")
    end

    it "answers 404 for another seller's sale", parity: true do
      other = purchase_row(link: create(:product, user: other_seller, price_cents: 500), seller: other_seller, email: "customer@example.com", purchase_state: "successful")

      patch "/mobile/sales/#{other.external_id}/refund", params: auth(seller)

      expect(response).to have_http_status(:not_found)
    end

    it "answers 404 for a free sale", parity: true do
      free = purchase_row(link: create(:product, user: seller, price_cents: 0), seller:, email: "customer@example.com", purchase_state: "successful", price_cents: 0)

      patch "/mobile/sales/#{free.external_id}/refund", params: auth(seller)

      expect(response).to have_http_status(:not_found)
    end

    it "answers 404 for a sale that is not successful", parity: true do
      failed = purchase_row(link: create(:product, user: seller, price_cents: 500), seller:, email: "customer@example.com", purchase_state: "failed")

      patch "/mobile/sales/#{failed.external_id}/refund", params: auth(seller)

      expect(response).to have_http_status(:not_found)
    end

    it "refuses a token without the mobile_api scope", parity: true do
      patch "/mobile/sales/#{sale.external_id}/refund", params: auth(seller, scopes: "creator_api")

      expect(response).to have_http_status(:forbidden)
    end

    it "hands a refund of a paid PayPal sale past the refund window to Rails", parity: true do
      sale.update_columns(card_type: CardType::PAYPAL, created_at: 7.months.ago)

      patch "/mobile/sales/#{sale.external_id}/refund", params: auth(seller).merge(amount: "1.00")

      expect(response).to have_http_status(:not_found)
    end

    it "hands a list of refund amounts to Rails", parity: true do
      patch "/mobile/sales/xxx/refund", params: auth(seller).merge(amount: ["1.00"])

      expect(response).to have_http_status(:not_found)
    end
  end

  describe "commissions" do
    def commission_of(owner)
      deposit = purchase_row(link: create(:product, user: owner), seller: owner, email: "customer@example.com", purchase_state: "successful")
      Commission.new(deposit_purchase: deposit).tap { |commission| commission.save!(validate: false) }
    end

    it "answers 404 for a commission that does not exist", parity: true do
      post "/mobile/commissions/xxx/complete", params: auth(seller)

      expect(response).to have_http_status(:not_found)
      expect(response.parsed_body).to eq("success" => false, "message" => "Could not find commission")
    end

    it "answers 404 for another seller's commission", parity: true do
      post "/mobile/commissions/#{commission_of(other_seller).external_id}/complete", params: auth(seller)

      expect(response).to have_http_status(:not_found)
    end

    it "refuses a token without the mobile_api scope", parity: true do
      post "/mobile/commissions/#{commission_of(seller).external_id}/complete", params: auth(seller, scopes: "creator_api")

      expect(response).to have_http_status(:forbidden)
    end

    def attach_file(commission)
      commission.files.attach(io: StringIO.new("final artwork"), filename: "artwork.txt", content_type: "text/plain")
    end

    def complete(commission)
      post "/mobile/commissions/#{commission.external_id}/complete", params: auth(seller)
    end

    it "answers success for a commission that is already completed", parity: true do
      commission = commission_of(seller)
      commission.update_columns(status: Commission::STATUS_COMPLETED)

      complete(commission)

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body).to eq("success" => true)
      expect(commission.reload.status).to eq(Commission::STATUS_COMPLETED)
    end

    it "answers success when the balance was already charged", parity: true do
      commission = commission_of(seller)
      completion = purchase_row(link: commission.deposit_purchase.link, seller:, email: "customer@example.com", purchase_state: "in_progress", is_commission_deposit_purchase: false, is_commission_completion_purchase: true)
      commission.update_columns(status: Commission::STATUS_IN_PROGRESS, completion_purchase_id: completion.id)

      complete(commission)

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body).to eq("success" => true)
      expect(commission.reload.status).to eq(Commission::STATUS_IN_PROGRESS)
    end

    it "refuses a commission with no status", parity: true do
      complete(commission_of(seller))

      expect(response).to have_http_status(:unprocessable_entity)
      expect(response.parsed_body).to eq("success" => false, "message" => "This commission's deposit is no longer in a completable state, so it can no longer be completed.")
    end

    it "refuses a commission whose deposit was refunded", parity: true do
      commission = commission_of(seller)
      commission.update_columns(status: Commission::STATUS_IN_PROGRESS)
      commission.deposit_purchase.update_columns(stripe_refunded: true)
      attach_file(commission)

      complete(commission)

      expect(response).to have_http_status(:unprocessable_entity)
      expect(response.parsed_body["message"]).to eq("This commission's deposit is no longer in a completable state, so it can no longer be completed.")
    end

    it "asks for a file before completing", parity: true do
      commission = commission_of(seller)
      commission.update_columns(status: Commission::STATUS_IN_PROGRESS)

      complete(commission)

      expect(response).to have_http_status(:unprocessable_entity)
      expect(response.parsed_body).to eq("success" => false, "message" => "Attach at least one file before completing this commission.")
      expect(commission.reload.completion_purchase_id).to be_nil
    end
  end

  describe "subscription cancels" do
    let(:product) { create(:subscription_product, user: seller) }
    let(:subscription) { create(:subscription, link: product, user: create(:user)) }

    before do
      purchase_row(link: product, seller:, purchaser: subscription.user, email: subscription.user.email, subscription:, is_original_subscription_purchase: true, purchase_state: "successful")
    end

    it "answers 404 for a subscription that does not exist", parity: true do
      post "/mobile/subscriptions/xxx/cancel", params: auth(seller)

      expect(response).to have_http_status(:not_found)
      expect(response.parsed_body).to eq("success" => false, "message" => "Could not find subscription")
    end

    it "answers 404 for another seller's subscription", parity: true do
      post "/mobile/subscriptions/#{subscription.external_id}/cancel", params: auth(other_seller)

      expect(response).to have_http_status(:not_found)
    end

    it "refuses a request without the mobile token", parity: true do
      post "/mobile/subscriptions/#{subscription.external_id}/cancel", params: { access_token: token_for(seller) }

      expect(response).to have_http_status(:unauthorized)
    end
  end

  describe "product deletes" do
    it "answers 404 for a product that does not exist", parity: true do
      delete "/mobile/products/nothing", params: auth(seller)

      expect(response).to have_http_status(:not_found)
      expect(response.parsed_body).to eq("success" => false, "message" => "Product not found")
    end

    it "answers 404 for another seller's product", parity: true do
      product = create(:product, user: other_seller)

      delete "/mobile/products/#{product.unique_permalink}", params: auth(seller)

      expect(response).to have_http_status(:not_found)
      expect(product.reload.deleted?).to eq(false)
    end

    it "answers 404 for a product that is already deleted", parity: true do
      product = create(:product, user: seller)
      product.mark_deleted!

      delete "/mobile/products/#{product.unique_permalink}", params: auth(seller)

      expect(response).to have_http_status(:not_found)
    end

    it "refuses a token without the mobile_api scope", parity: true do
      product = create(:product, user: seller)

      delete "/mobile/products/#{product.unique_permalink}", params: auth(seller, scopes: "creator_api")

      expect(response).to have_http_status(:forbidden)
      expect(product.reload.deleted?).to eq(false)
    end
  end

  describe "url redirect attributes" do
    it "answers 404 for a url redirect that does not exist", parity: true do
      get "/mobile/url_redirects/get_url_redirect_attributes/xxx", params: { mobile_token: }

      expect(response).to have_http_status(:not_found)
      expect(response.parsed_body).to eq("success" => false, "message" => "Could not find url redirect")
    end

    it "refuses a request without the mobile token", parity: true do
      get "/mobile/url_redirects/get_url_redirect_attributes/xxx"

      expect(response).to have_http_status(:unauthorized)
    end

    it "hands a url redirect with its attributes to Rails", parity: true do
      buyer = create(:user)
      product = create(:product, user: seller)
      purchase = create(:free_purchase, link: product, purchaser: buyer, email: buyer.email)
      url_redirect = purchase.create_url_redirect!

      get "/mobile/url_redirects/get_url_redirect_attributes/#{url_redirect.external_id}", params: { mobile_token: }

      expect(response.parsed_body).to include("success" => true)
    end
  end

  describe "sessions" do
    it "refuses a sign-in without a bearer token", parity: true do
      post "/mobile/sessions", params: { mobile_token: }

      expect(response).to have_http_status(:unauthorized)
    end

    it "refuses a sign-in with a token that lacks the mobile_api scope", parity: true do
      post "/mobile/sessions", params: auth(seller, scopes: "creator_api")

      expect(response).to have_http_status(:forbidden)
    end

    it "hands a sign-in to Rails", parity: true do
      post "/mobile/sessions", params: auth(seller)

      expect(response.parsed_body).to eq("success" => true, "user" => { "email" => seller.form_email })
    end

    it "answers that a confirmed address needs no email", parity: true do
      post "/mobile/sessions/resend_confirmation_email", params: auth(seller)

      expect(response.parsed_body).to eq("success" => true, "status" => "already_confirmed")
    end

    it "hands a pending address change to Rails", parity: true do
      seller.update_columns(unconfirmed_email: "new@example.com")

      post "/mobile/sessions/resend_confirmation_email", params: auth(seller)

      expect(response.parsed_body).to include("success" => true)
    end

    it "hands an unconfirmed account to Rails", parity: true do
      seller.update_columns(confirmed_at: nil)

      post "/mobile/sessions/resend_confirmation_email", params: auth(seller)

      expect(response.parsed_body).to include("success" => true)
    end

    it "refuses a resend with a token that lacks the mobile_api scope", parity: true do
      post "/mobile/sessions/resend_confirmation_email", params: auth(seller, scopes: "creator_api")

      expect(response).to have_http_status(:forbidden)
    end
  end
end
