# frozen_string_literal: true

require "spec_helper"

# Api::V2::ResourceSubscriptionsController#create and #test_event through the full Rack stack, recorded for the Next.js port
# (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/api-v2-ws17c.replay.test.ts. Both resolve or call the subscriber's URL, so they
# are recorded as what Node hands back; Node answers the scope checks, the 404 of #test_event and a post URL that is not a URI or is a reserved IPv4 literal (no DNS involved).
describe "API v2 resource subscription writes", type: :request do
  include Parity::ApiV2Requests

  let(:seller) { create(:user, name: "Hook Seller", email: "hook-seller@example.com") }
  let(:token) { api_token(seller, scopes: "view_sales") }
  let!(:subscription) { create(:resource_subscription, user: seller, oauth_application: api_application, resource_name: "sale", post_url: "http://example.com/hook") }

  def call(verb, path, params = {}, options = {})
    api_call(verb, path, params:, token: options.fetch(:token) { token }, **options.slice(:as, :api_host))
  end

  describe "PUT /resource_subscriptions" do
    it "refuses a request without a token", parity: true do
      call(:put, "/resource_subscriptions", { resource_name: "sale", post_url: "http://example.com/hook" }, token: nil)

      expect(response).to have_http_status(:unauthorized)
    end

    it "refuses a token that lacks the view_sales scope", parity: true do
      call(:put, "/resource_subscriptions", { resource_name: "sale", post_url: "http://example.com/hook" }, token: api_token(seller, scopes: "edit_products"))

      expect(response).to have_http_status(:forbidden)
    end

    it "refuses a post URL that is a reserved IP address", :skip_resource_subscription_dns_stub, parity: true do
      call(:put, "/resource_subscriptions", { resource_name: "sale", post_url: "http://127.0.0.1/hook" })

      expect(response.parsed_body).to eq("success" => false, "message" => "Invalid post URL 'http://127.0.0.1/hook'")
      expect(ResourceSubscription.where(post_url: "http://127.0.0.1/hook")).to be_empty
    end

    it "refuses a post URL that is not a URL", parity: true do
      call(:put, "/resource_subscriptions", { resource_name: "sale", post_url: "not a url" })

      expect(response.parsed_body).to eq("success" => false, "message" => "Invalid post URL 'not a url'")
    end

    it "refuses a post URL that is not a URL through the /api prefix on the Gumroad domain", parity: true do
      call(:put, "/resource_subscriptions", { resource_name: "refund", post_url: "not a url" }, api_host: false)

      expect(response.parsed_body).to eq("success" => false, "message" => "Invalid post URL 'not a url'")
    end

    it "hands a subscription whose post URL needs a DNS lookup to Rails", parity: true do
      call(:put, "/resource_subscriptions", { resource_name: "sale", post_url: "http://example.com/hook2" })

      expect(response.parsed_body["resource_subscription"]).to include("resource_name" => "sale", "post_url" => "http://example.com/hook2")
    end
  end

  describe "POST /resource_subscriptions/:id/test_event" do
    it "does not find an unknown subscription", parity: true do
      call(:post, "/resource_subscriptions/unknown/test_event")

      expect(response.parsed_body).to eq("success" => false, "message" => "The resource_subscription was not found.")
    end

    it "does not find the subscription of another seller", parity: true do
      other = create(:resource_subscription, user: create(:user, email: "other-hook-seller@example.com"), oauth_application: api_application)

      call(:post, "/resource_subscriptions/#{other.external_id}/test_event")

      expect(response.parsed_body["message"]).to eq("The resource_subscription was not found.")
    end

    it "does not find a subscription of another application", parity: true do
      other = create(:resource_subscription, user: seller, oauth_application: create(:oauth_application, owner: create(:user, email: "other-app-owner@example.com")))

      call(:post, "/resource_subscriptions/#{other.external_id}/test_event")

      expect(response.parsed_body["message"]).to eq("The resource_subscription was not found.")
    end

    it "does not find a deleted subscription", parity: true do
      subscription.mark_deleted!

      call(:post, "/resource_subscriptions/#{subscription.external_id}/test_event")

      expect(response.parsed_body["message"]).to eq("The resource_subscription was not found.")
    end

    it "refuses a request without a token", parity: true do
      call(:post, "/resource_subscriptions/#{subscription.external_id}/test_event", {}, token: nil)

      expect(response).to have_http_status(:unauthorized)
    end

    it "hands a test event to Rails", parity: true do
      call(:post, "/resource_subscriptions/#{subscription.external_id}/test_event")

      expect(response).to have_http_status(:ok)
    end

    it "hands a test event through the /api prefix on the Gumroad domain to Rails", parity: true do
      call(:post, "/resource_subscriptions/#{subscription.external_id}/test_event", {}, api_host: false)

      expect(response).to have_http_status(:ok)
    end
  end
end
