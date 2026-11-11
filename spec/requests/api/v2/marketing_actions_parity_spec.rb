# frozen_string_literal: true

require "spec_helper"

# Api::V2::MarketingActionsController through the full Rack stack, recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/api-v2-ws17c.replay.test.ts. The recommendations, the creation of an action and the execution of a live channel
# write UTM links and email drafts, post to X or send mail, so those examples record what Node hands back.
describe "API v2 marketing actions", type: :request do
  let(:seller) { create(:user, name: "Marketing Seller", twitter_handle: "marketer") }
  let(:application) { create(:oauth_application, owner: create(:user)) }
  let!(:product) { create(:product, user: seller, name: "Launch product", unique_permalink: "launchme", price_cents: 500) }
  let(:holdout) { false }

  before do
    host! API_DOMAIN
    create(:marketing_holdout_assignment, user: seller, marketing_holdout: holdout)
    Feature.activate_user(:auto_marketing, seller)
  end

  def token_for(scopes) = create("doorkeeper/access_token", application:, resource_owner_id: seller.id, scopes:).token
  def auth(scopes = "edit_emails") = { "Authorization" => "Bearer #{token_for(scopes)}" }

  def create_action(**attributes)
    create(:marketing_action, { user: seller, link: product, copy: "Launch product: a fresh start." }.merge(attributes))
  end

  def confirm(action, **extra) = { idempotency_key: action.api_idempotency_key, confirmation_token: action.confirmation_token }.merge(extra)

  describe "GET /v2/products/:product_id/marketing/recommendations" do
    it "hands a published product's recommendations to Rails", parity: true do
      get "/v2/products/#{product.unique_permalink}/marketing/recommendations", headers: auth

      expect(response).to have_http_status(:ok)
      expect(Marketing::Action.count).to eq(2)
    end

    it "hands a product found by external id to Rails", parity: true do
      get "/v2/products/#{product.external_id}/marketing/recommendations", headers: auth

      expect(response).to have_http_status(:ok)
    end

    it "answers 404 for a draft product", parity: true do
      product.update!(draft: true)

      get "/v2/products/#{product.unique_permalink}/marketing/recommendations", headers: auth

      expect(response).to have_http_status(:not_found)
      expect(Marketing::Action.count).to eq(0)
    end

    it "answers 404 for an unpublished product", parity: true do
      product.update_column(:purchase_disabled_at, Time.current)

      get "/v2/products/#{product.unique_permalink}/marketing/recommendations", headers: auth

      expect(response).to have_http_status(:not_found)
    end

    it "answers 404 for a deleted product", parity: true do
      product.update_column(:deleted_at, Time.current)

      get "/v2/products/#{product.unique_permalink}/marketing/recommendations", headers: auth

      expect(response).to have_http_status(:not_found)
    end

    it "answers 404 for another seller's product", parity: true do
      other = create(:product, unique_permalink: "otherprod")

      get "/v2/products/#{other.unique_permalink}/marketing/recommendations", headers: auth

      expect(response).to have_http_status(:not_found)
    end

    it "answers 404 when the flag is off", parity: true do
      Feature.deactivate_user(:auto_marketing, seller)

      get "/v2/products/#{product.unique_permalink}/marketing/recommendations", headers: auth

      expect(response).to have_http_status(:not_found)
    end

    context "when the seller is held out" do
      let(:holdout) { true }

      it "answers 404", parity: true do
        get "/v2/products/#{product.unique_permalink}/marketing/recommendations", headers: auth

        expect(response).to have_http_status(:not_found)
      end
    end

    it "hands an /api/v2 recommendations request on the main domain to Rails", parity: true do
      host! DOMAIN

      get "/api/v2/products/#{product.unique_permalink}/marketing/recommendations", headers: auth

      expect(response).to have_http_status(:ok)
    end

    it "refuses a token without the edit_emails scope", parity: true do
      get "/v2/products/#{product.unique_permalink}/marketing/recommendations", headers: auth("view_public")

      expect(response).to have_http_status(:forbidden)
    end

    it "refuses a request without a token", parity: true do
      get "/v2/products/#{product.unique_permalink}/marketing/recommendations"

      expect(response).to have_http_status(:unauthorized)
    end
  end

  describe "POST /v2/products/:product_id/marketing_actions" do
    it "says an unknown channel is unknown", parity: true do
      post "/v2/products/#{product.unique_permalink}/marketing_actions", params: { channel: "myspace" }, headers: auth

      expect(response).to have_http_status(:unprocessable_entity)
      expect(response.parsed_body).to eq("success" => false, "message" => "Unknown marketing channel.")
    end

    it "says a missing channel is unknown", parity: true do
      post "/v2/products/#{product.unique_permalink}/marketing_actions", headers: auth

      expect(response.parsed_body["message"]).to eq("Unknown marketing channel.")
    end

    it "says the abandoned cart channel is unknown", parity: true do
      post "/v2/products/#{product.unique_permalink}/marketing_actions", params: { channel: "abandoned_cart" }, headers: auth

      expect(response.parsed_body["message"]).to eq("Unknown marketing channel.")
    end

    it "says a list of channels is unknown", parity: true do
      post "/v2/products/#{product.unique_permalink}/marketing_actions", params: { channel: %w[x email] }, headers: auth

      expect(response.parsed_body["message"]).to eq("Unknown marketing channel.")
    end

    %w[instagram youtube tiktok].each do |channel|
      it "says the #{channel} channel is coming soon", parity: true do
        post "/v2/products/#{product.unique_permalink}/marketing_actions", params: { channel: }, headers: auth

        expect(response).to have_http_status(:unprocessable_entity)
        expect(response.parsed_body).to eq("success" => false, "message" => "This channel is coming soon.")
        expect(Marketing::Action.count).to eq(0)
      end
    end

    it "hands a new X action to Rails", parity: true do
      post "/v2/products/#{product.unique_permalink}/marketing_actions", params: { channel: "x" }, headers: auth

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body["marketing_action"]).to include("channel" => "x", "status" => "recommended")
      expect(Marketing::Action.count).to eq(2)
    end

    it "hands a new email action to Rails", parity: true do
      post "/v2/products/#{product.unique_permalink}/marketing_actions", params: { channel: "email" }, headers: auth

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body["marketing_action"]).to include("channel" => "email")
    end

    it "answers 404 for a draft product before reading the channel", parity: true do
      product.update!(draft: true)

      post "/v2/products/#{product.unique_permalink}/marketing_actions", params: { channel: "myspace" }, headers: auth

      expect(response).to have_http_status(:not_found)
    end

    it "answers 404 when the flag is off", parity: true do
      Feature.deactivate_user(:auto_marketing, seller)

      post "/v2/products/#{product.unique_permalink}/marketing_actions", params: { channel: "x" }, headers: auth

      expect(response).to have_http_status(:not_found)
    end

    it "refuses a token without the edit_emails scope", parity: true do
      post "/v2/products/#{product.unique_permalink}/marketing_actions", params: { channel: "x" }, headers: auth("edit_products")

      expect(response).to have_http_status(:forbidden)
    end
  end

  describe "GET /v2/marketing_actions/:id" do
    it "renders an action with its post text, tokens and the seller's handle", parity: true do
      utm_link = create(:utm_link, seller:, target_resource_type: "product_page", target_resource_id: product.id, utm_source: "x", utm_medium: "social", utm_campaign: "launch", permalink: "launch01", title: "Launch")
      action = create_action(utm_link:)

      get "/v2/marketing_actions/#{action.external_id}", params: { idempotency_key: action.api_idempotency_key }, headers: auth

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body).to include("success" => true, "handle" => "marketer")
      expect(response.parsed_body["marketing_action"]).to include("status" => "recommended", "link_url" => utm_link.short_url)
    end

    it "renders an approved action without a link", parity: true do
      action = create_action(channel: "instagram", status: "approved", approved_at: Time.utc(2025, 3, 1, 12))

      get "/v2/marketing_actions/#{action.external_id}", params: { idempotency_key: action.api_idempotency_key }, headers: auth

      expect(response.parsed_body["marketing_action"]).to include("link_url" => nil, "approved_at" => "2025-03-01T12:00:00Z")
    end

    it "renders a posted action with its external url and escaped copy", parity: true do
      action = create_action(status: "posted", approved_at: Time.utc(2025, 3, 1), posted_at: Time.utc(2025, 3, 2), external_url: "https://x.example.com/posts/1", copy: "Fish & <chips> é")

      get "/v2/marketing_actions/#{action.external_id}", params: { idempotency_key: action.api_idempotency_key }, headers: auth

      expect(response.parsed_body["marketing_action"]).to include("status" => "posted", "external_url" => "https://x.example.com/posts/1")
    end

    it "renders an action without an idempotency key", parity: true do
      get "/v2/marketing_actions/#{create_action.external_id}", headers: auth

      expect(response).to have_http_status(:ok)
    end

    it "answers 404 for an unknown action", parity: true do
      get "/v2/marketing_actions/zzzzzzzzzzzzzzzzzzzzzz", headers: auth

      expect(response).to have_http_status(:not_found)
    end

    it "answers 404 for another seller's action", parity: true do
      action = create(:marketing_action)

      get "/v2/marketing_actions/#{action.external_id}", params: { idempotency_key: action.api_idempotency_key }, headers: auth

      expect(response).to have_http_status(:not_found)
    end

    it "answers 404 when the flag is off", parity: true do
      Feature.deactivate_user(:auto_marketing, seller)
      action = create_action

      get "/v2/marketing_actions/#{action.external_id}", params: { idempotency_key: action.api_idempotency_key }, headers: auth

      expect(response).to have_http_status(:not_found)
    end

    it "refuses a request without a token", parity: true do
      get "/v2/marketing_actions/#{create_action.external_id}"

      expect(response).to have_http_status(:unauthorized)
    end
  end

  describe "POST /v2/marketing_actions/:id/approve" do
    it "approves a recommended action", parity: true do
      action = create_action

      post "/v2/marketing_actions/#{action.external_id}/approve", params: confirm(action), headers: auth

      expect(response).to have_http_status(:ok)
      expect(action.reload).to be_approved
      expect(response.parsed_body["marketing_action"]).to include("status" => "approved", "approved_at" => be_present)
    end

    it "approves with edited copy from a JSON body", parity: true do
      action = create_action

      post "/v2/marketing_actions/#{action.external_id}/approve", params: confirm(action, copy: "Edited copy").to_json, headers: auth.merge("Content-Type" => "application/json")

      expect(action.reload).to have_attributes(status: "approved", copy: "Edited copy")
    end

    it "approves again an approved action with new copy", parity: true do
      action = create_action(status: "approved", approved_at: Time.utc(2025, 3, 1))

      post "/v2/marketing_actions/#{action.external_id}/approve", params: confirm(action, copy: "Second pass"), headers: auth

      expect(action.reload).to have_attributes(status: "approved", copy: "Second pass")
    end

    it "keeps a queued action's copy frozen", parity: true do
      action = create_action(status: "queued", queued_at: Time.utc(2025, 3, 1))

      post "/v2/marketing_actions/#{action.external_id}/approve", params: confirm(action, copy: "Edited"), headers: auth

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body["marketing_action"]).to include("status" => "queued", "copy" => "Launch product: a fresh start.")
    end

    it "rejects over-length copy", parity: true do
      action = create_action

      post "/v2/marketing_actions/#{action.external_id}/approve", params: confirm(action, copy: "a" * 300), headers: auth

      expect(response).to have_http_status(:unprocessable_entity)
      expect(response.parsed_body).to eq("success" => false, "message" => "Copy is too long (maximum is 255 characters)")
      expect(action.reload).to be_recommended
    end

    it "rejects blank copy", parity: true do
      action = create_action

      post "/v2/marketing_actions/#{action.external_id}/approve", params: confirm(action, copy: "  "), headers: auth

      expect(response.parsed_body["message"]).to eq("Copy can't be blank")
    end

    it "counts copy in characters, not bytes", parity: true do
      action = create_action

      post "/v2/marketing_actions/#{action.external_id}/approve", params: confirm(action, copy: "é" * 255), headers: auth

      expect(response).to have_http_status(:ok)
    end

    %w[cancelled failed blocked].each do |status|
      it "refuses to approve a #{status} action", parity: true do
        action = create_action(status:)

        post "/v2/marketing_actions/#{action.external_id}/approve", params: confirm(action, copy: "Edited"), headers: auth

        expect(response).to have_http_status(:unprocessable_entity)
        expect(response.parsed_body).to eq("success" => false, "message" => "This post can no longer be changed.")
        expect(action.reload.status).to eq(status)
      end
    end

    it "points an abandoned cart receipt to workflows", parity: true do
      action = create_action(channel: "abandoned_cart", status: "approved", approved_at: Time.utc(2025, 3, 1))

      post "/v2/marketing_actions/#{action.external_id}/approve", params: confirm(action, copy: "Different"), headers: auth

      expect(response).to have_http_status(:unprocessable_entity)
      expect(response.parsed_body["message"]).to include("Workflows")
    end

    it "asks for a confirmation token when it is missing", parity: true do
      action = create_action

      post "/v2/marketing_actions/#{action.external_id}/approve", params: { idempotency_key: action.api_idempotency_key }, headers: auth

      expect(response).to have_http_status(:unprocessable_entity)
      expect(response.parsed_body).to eq("success" => false, "message" => "Review the action and supply its confirmation_token.")
      expect(action.reload).to be_recommended
    end

    it "asks for a confirmation token when it is not text", parity: true do
      action = create_action

      post "/v2/marketing_actions/#{action.external_id}/approve", params: { idempotency_key: action.api_idempotency_key, confirmation_token: %w[a] }, headers: auth

      expect(response.parsed_body["message"]).to eq("Review the action and supply its confirmation_token.")
    end

    it "asks for the idempotency key when it is missing", parity: true do
      action = create_action

      post "/v2/marketing_actions/#{action.external_id}/approve", params: { confirmation_token: action.confirmation_token }, headers: auth

      expect(response.parsed_body["message"]).to eq("Use the idempotency_key returned with this action.")
    end

    it "asks to review again when the confirmation token is stale", parity: true do
      action = create_action

      post "/v2/marketing_actions/#{action.external_id}/approve", params: confirm(action, confirmation_token: "0" * 64), headers: auth

      expect(response).to have_http_status(:unprocessable_entity)
      expect(response.parsed_body).to eq("success" => false, "message" => "The post changed. Review it and confirm again.")
      expect(action.reload).to be_recommended
    end

    it "asks to review again when the seller's handle changed", parity: true do
      action = create_action
      params = confirm(action)
      seller.update_column(:twitter_handle, "renamed")

      post "/v2/marketing_actions/#{action.external_id}/approve", params:, headers: auth

      expect(response.parsed_body["message"]).to eq("The post changed. Review it and confirm again.")
    end

    it "hands a copy that is not text to Rails", parity: true do
      action = create_action

      post "/v2/marketing_actions/#{action.external_id}/approve", params: confirm(action, copy: 12_345).to_json, headers: auth.merge("Content-Type" => "application/json")

      expect(response).to have_http_status(:ok)
      expect(action.reload.copy).to eq("12345")
    end

    it "answers 404 when the flag is off", parity: true do
      Feature.deactivate_user(:auto_marketing, seller)
      action = create_action

      post "/v2/marketing_actions/#{action.external_id}/approve", params: confirm(action), headers: auth

      expect(response).to have_http_status(:not_found)
      expect(action.reload).to be_recommended
    end

    it "answers 404 for another seller's action", parity: true do
      action = create(:marketing_action)

      post "/v2/marketing_actions/#{action.external_id}/approve", params: confirm(action), headers: auth

      expect(response).to have_http_status(:not_found)
    end

    it "refuses a token without the edit_emails scope", parity: true do
      action = create_action

      post "/v2/marketing_actions/#{action.external_id}/approve", params: confirm(action), headers: auth("view_public")

      expect(response).to have_http_status(:forbidden)
    end
  end

  describe "POST /v2/marketing_actions/:id/cancel" do
    %w[recommended approved].each do |status|
      it "cancels a #{status} action", parity: true do
        action = create_action(status:, approved_at: (status == "approved" ? Time.utc(2025, 3, 1) : nil))

        post "/v2/marketing_actions/#{action.external_id}/cancel", params: { idempotency_key: action.api_idempotency_key }, headers: auth

        expect(response).to have_http_status(:ok)
        expect(action.reload).to be_cancelled
        expect(response.parsed_body["marketing_action"]["status"]).to eq("cancelled")
      end
    end

    it "answers again for an action that is already cancelled", parity: true do
      action = create_action(status: "cancelled")

      post "/v2/marketing_actions/#{action.external_id}/cancel", params: { idempotency_key: action.api_idempotency_key }, headers: auth

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body["marketing_action"]["status"]).to eq("cancelled")
    end

    %w[queued posted failed blocked].each do |status|
      it "refuses to cancel a #{status} action", parity: true do
        action = create_action(status:, queued_at: (status == "queued" ? Time.utc(2025, 3, 1) : nil))

        post "/v2/marketing_actions/#{action.external_id}/cancel", params: { idempotency_key: action.api_idempotency_key }, headers: auth

        expect(response).to have_http_status(:unprocessable_entity)
        expect(response.parsed_body).to eq("success" => false, "message" => "This post can no longer be cancelled.")
        expect(action.reload.status).to eq(status)
      end
    end

    it "points an abandoned cart receipt to workflows", parity: true do
      action = create_action(channel: "abandoned_cart", status: "approved", approved_at: Time.utc(2025, 3, 1))

      post "/v2/marketing_actions/#{action.external_id}/cancel", params: { idempotency_key: action.api_idempotency_key }, headers: auth

      expect(response).to have_http_status(:unprocessable_entity)
      expect(action.reload).to be_approved
    end

    it "asks for the idempotency key when it is wrong", parity: true do
      action = create_action

      post "/v2/marketing_actions/#{action.external_id}/cancel", params: { idempotency_key: "nope" }, headers: auth

      expect(response.parsed_body["message"]).to eq("Use the idempotency_key returned with this action.")
      expect(action.reload).to be_recommended
    end

    it "answers 404 when the flag is off", parity: true do
      Feature.deactivate_user(:auto_marketing, seller)
      action = create_action

      post "/v2/marketing_actions/#{action.external_id}/cancel", params: { idempotency_key: action.api_idempotency_key }, headers: auth

      expect(response).to have_http_status(:not_found)
      expect(action.reload).to be_recommended
    end

    it "answers 404 for another seller's action", parity: true do
      action = create(:marketing_action)

      post "/v2/marketing_actions/#{action.external_id}/cancel", params: { idempotency_key: action.api_idempotency_key }, headers: auth

      expect(response).to have_http_status(:not_found)
    end

    it "serves /api/v2 on the main domain", parity: true do
      host! DOMAIN
      action = create_action

      post "/api/v2/marketing_actions/#{action.external_id}/cancel", params: { idempotency_key: action.api_idempotency_key }, headers: auth

      expect(action.reload).to be_cancelled
    end
  end

  describe "POST /v2/marketing_actions/:id/execute" do
    %w[instagram youtube tiktok abandoned_cart].each do |channel|
      it "says the #{channel} channel is coming soon", parity: true do
        action = create_action(channel:, status: "approved", approved_at: Time.utc(2025, 3, 1))

        post "/v2/marketing_actions/#{action.external_id}/execute", params: confirm(action), headers: auth

        expect(response).to have_http_status(:unprocessable_entity)
        expect(response.parsed_body).to eq("success" => false, "message" => "This channel is coming soon.")
        expect(action.reload).to be_approved
      end
    end

    it "asks for a confirmation token when it is missing", parity: true do
      action = create_action(status: "approved", approved_at: Time.utc(2025, 3, 1))

      post "/v2/marketing_actions/#{action.external_id}/execute", params: { idempotency_key: action.api_idempotency_key }, headers: auth

      expect(response.parsed_body["message"]).to eq("Review the action and supply its confirmation_token.")
    end

    it "asks for the idempotency key when it is wrong", parity: true do
      action = create_action(status: "approved", approved_at: Time.utc(2025, 3, 1))

      post "/v2/marketing_actions/#{action.external_id}/execute", params: { idempotency_key: "nope", confirmation_token: action.confirmation_token }, headers: auth

      expect(response.parsed_body["message"]).to eq("Use the idempotency_key returned with this action.")
    end

    it "answers 404 when the flag is off", parity: true do
      Feature.deactivate_user(:auto_marketing, seller)
      action = create_action

      post "/v2/marketing_actions/#{action.external_id}/execute", params: confirm(action), headers: auth

      expect(response).to have_http_status(:not_found)
    end

    it "hands an X post to Rails", parity: true do
      WebMock.stub_request(:post, Marketing::XApi::TWEETS_URL).to_return(status: 403, body: "{}", headers: { "Content-Type" => "application/json" })
      action = create_action(status: "approved", approved_at: Time.utc(2025, 3, 1))

      post "/v2/marketing_actions/#{action.external_id}/execute", params: confirm(action), headers: auth

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body["marketing_action"]).to include("error_code" => "x_write_permission_missing")
    end

    it "hands a launch email to Rails", parity: true do
      create(:payment_completed, user: seller)
      allow_any_instance_of(User).to receive(:sales_cents_total).and_return(Installment::MINIMUM_SALES_CENTS_VALUE)
      action = create_action(channel: "email", status: "approved", approved_at: Time.utc(2025, 3, 1))

      post "/v2/marketing_actions/#{action.external_id}/execute", params: confirm(action), headers: auth

      expect(response).to have_http_status(:ok)
      expect(seller.installments.count).to eq(1)
    end

    it "hands a stale confirmation of a live channel to Rails", parity: true do
      action = create_action(status: "approved", approved_at: Time.utc(2025, 3, 1))

      post "/v2/marketing_actions/#{action.external_id}/execute", params: confirm(action, confirmation_token: "0" * 64), headers: auth

      expect(response).to have_http_status(:ok)
    end
  end
end
