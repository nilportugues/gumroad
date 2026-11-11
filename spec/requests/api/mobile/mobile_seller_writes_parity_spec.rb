# frozen_string_literal: true

require "spec_helper"

# The Api::Mobile writes and reads the Next.js port answers up to their first write (nextjs/src/server/controllers/mobile-seller-writes.ts,
# mobile-agent.ts): the 404s, the comma refusal of a refund amount, an already confirmed address and the Agent tab's conversation reads.
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

    it "hands a completion of a commission to Rails", parity: true do
      post "/mobile/commissions/#{commission_of(seller).external_id}/complete", params: auth(seller)

      expect(response.parsed_body).to include("success")
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

  describe "the Agent tab" do
    let(:turn_id) { "3f2b7c1e-8d4a-4f6b-9a10-5c2d7e8f9a0b" }

    # User#eligible_for_store_agent?: a completed payout and $100 of sales in the purchases index.
    def earn_access(user)
      create(:payment_completed, user:)
      earner = create(:product, user:, name: "Earner", unique_permalink: "earner", created_at: Time.utc(2025, 1, 1))
      purchase_row(link: earner, seller: user, price_cents: 20_000, purchase_state: "successful")
      index_model_records(Purchase)
    end

    def conversation_with(*messages, title: "Sales questions")
      create(:ai_conversation, seller:, title:).tap do |conversation|
        messages.each { |message| create(:ai_message, ai_conversation: conversation, **message) }
      end
    end

    before do
      Purchase.__elasticsearch__.create_index!(force: true)
      $redis.flushdb
    end

    it "answers no conversation for a seller who never chatted", parity: true do
      earn_access(seller)

      get "/mobile/agent/conversations/latest", params: auth(seller)

      expect(response.parsed_body).to eq("success" => true, "conversation" => nil)
    end

    it "resumes the conversation touched last with its transcript", parity: true do
      earn_access(seller)
      conversation_with({ content: "How are my sales doing?" }, { role: "assistant", content: "You made $200.", metadata: { objects: [{ type: "product", name: "Earner" }] } })

      get "/mobile/agent/conversations/latest", params: auth(seller)

      expect(response.parsed_body["conversation"]["messages"].map { _1["role"] }).to eq(%w[user assistant])
    end

    it "keeps an applied proposal in the transcript", parity: true do
      earn_access(seller)
      conversation_with({ role: "assistant", content: "Create LAUNCH?", metadata: { proposed_action: { type: "create_offer_code" }, action_status: "applied" } })

      get "/mobile/agent/conversations/latest", params: auth(seller)

      expect(response.parsed_body["conversation"]["messages"].first).to include("action_status" => "applied")
    end

    it "hands a proposal that is claimed but unresolved to Rails", parity: true do
      earn_access(seller)
      conversation_with({ role: "assistant", content: "Create LAUNCH?", metadata: { proposed_action: { type: "create_offer_code" }, action_status: "unknown" } })

      get "/mobile/agent/conversations/latest", params: auth(seller)

      expect(response.parsed_body["conversation"]["messages"].first).not_to include("action_status")
    end

    it "refuses the latest conversation to a seller who has not earned the agent", parity: true do
      get "/mobile/agent/conversations/latest", params: auth(seller)

      expect(response).to have_http_status(:forbidden)
      expect(response.parsed_body).to eq("success" => false, "error" => "You don't have access to the store agent.")
    end

    it "returns the persisted turn", parity: true do
      earn_access(seller)
      conversation = conversation_with({ role: "assistant", content: "Done", metadata: { client_turn_id: turn_id, objects: [] } })

      get "/mobile/agent/turns/#{turn_id}", params: auth(seller)

      expect(response.parsed_body).to include("success" => true, "status" => "persisted", "conversation_id" => conversation.external_id)
    end

    it "reports a turn that is still generating", parity: true do
      earn_access(seller)
      $redis.set(RedisKey.agent_turn_status(seller.id, turn_id), "in_progress", ex: 180)

      get "/mobile/agent/turns/#{turn_id}", params: auth(seller)

      expect(response.parsed_body).to eq("success" => true, "status" => "in_progress")
    end

    it "reports a turn nobody has heard of as unknown", parity: true do
      earn_access(seller)

      get "/mobile/agent/turns/#{turn_id}", params: auth(seller)

      expect(response.parsed_body).to eq("success" => true, "status" => "unknown")
    end

    it "answers 400 for a malformed turn id", parity: true do
      earn_access(seller)

      get "/mobile/agent/turns/not-hex", params: auth(seller)

      expect(response).to have_http_status(:bad_request)
      expect(response.parsed_body).to eq("success" => false, "error" => "Invalid turn id.")
    end

    it "refuses a turn read to a seller who has not earned the agent", parity: true do
      get "/mobile/agent/turns/#{turn_id}", params: auth(seller)

      expect(response).to have_http_status(:forbidden)
    end

    it "hands a turn without messages to Rails", parity: true do
      earn_access(seller)

      post "/mobile/agent/messages", params: auth(seller)

      expect(response).to have_http_status(:bad_request)
    end

    it "hands an unsupported confirmed action to Rails", parity: true do
      earn_access(seller)

      post "/mobile/agent/actions", params: auth(seller).merge(type: "not_a_real_action")

      expect(response).to have_http_status(:bad_request)
    end

    it "hands a streamed turn without messages to Rails", parity: true do
      earn_access(seller)

      post "/mobile/agent/messages/stream", params: auth(seller)

      expect(response).to have_http_status(:ok)
    end

    it "refuses a turn to a seller who has not earned the agent", parity: true do
      post "/mobile/agent/messages", params: auth(seller)

      expect(response).to have_http_status(:forbidden)
    end
  end
end
