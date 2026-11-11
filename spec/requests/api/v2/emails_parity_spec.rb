# frozen_string_literal: true

require "spec_helper"

# Api::V2::EmailsController through the full Rack stack, recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/api-v2-ws17c.replay.test.ts.
describe "API v2 emails", type: :request do
  let(:seller) { create(:user, username: "dude", name: "Dude", email: "dude@example.com") }
  let(:application) { create(:oauth_application, owner: create(:user)) }
  let(:headers) { { "Authorization" => "Bearer #{create("doorkeeper/access_token", application:, resource_owner_id: seller.id, scopes: "edit_emails").token}" } }

  before { host! API_DOMAIN }

  describe "GET /v2/emails" do
    it "lists the seller's emails newest first", parity: true do
      create(:audience_installment, seller:, name: "Draft", created_at: 3.minutes.ago)
      create(:audience_installment, :published, seller:, name: "Published", created_at: 2.minutes.ago)
      create(:scheduled_installment, seller:, link: nil, installment_type: Installment::AUDIENCE_TYPE, name: "Scheduled", created_at: 1.minute.ago)
      create(:audience_installment, seller:, deleted_at: Time.current)
      create(:workflow_installment, seller:, link: create(:product, user: seller))
      create(:audience_installment, seller: create(:user))
      get "/v2/emails", headers:
    end

    it "filters by type", parity: true do
      create(:audience_installment, seller:, name: "Draft", created_at: 3.minutes.ago)
      create(:audience_installment, :published, seller:, name: "Published", created_at: 2.minutes.ago)
      get "/v2/emails", params: { type: "published" }, headers:
    end

    it "filters scheduled emails", parity: true do
      create(:audience_installment, seller:, name: "Draft")
      create(:scheduled_installment, seller:, link: nil, installment_type: Installment::AUDIENCE_TYPE, name: "Scheduled")
      get "/v2/emails", params: { type: "scheduled" }, headers:
    end

    it "rejects an unknown type", parity: true do
      get "/v2/emails", params: { type: "sent" }, headers:
    end

    it "paginates with a page key", parity: true do
      12.times { |index| create(:audience_installment, seller:, name: "Email #{index}", created_at: (index + 1).minutes.ago) }
      get "/v2/emails", params: { type: "draft" }, headers:
    end

    it "rejects a malformed page key", parity: true do
      get "/v2/emails", params: { page_key: "garbage-0" }, headers:
    end

    it "includes emails owned through a product", parity: true do
      create(:product_installment, link: create(:product, user: seller), seller: nil, name: "Through the product")
      get "/v2/emails", headers:
    end

    it "serves /api/v2 on the main domain", parity: true do
      host! DOMAIN
      create(:audience_installment, seller:, name: "Draft")
      get "/api/v2/emails", headers:
    end

    it "forbids a token without edit_emails", parity: true do
      get "/v2/emails", headers: { "Authorization" => "Bearer #{create("doorkeeper/access_token", application:, resource_owner_id: seller.id, scopes: "view_public").token}" }
    end
  end

  describe "GET /v2/emails/:id" do
    it "returns a draft", parity: true do
      get "/v2/emails/#{create(:audience_installment, seller:, name: "Draft").external_id}", headers:
    end

    it "returns a published email with its URL", parity: true do
      get "/v2/emails/#{create(:audience_installment, :published, seller:, name: "Published", customer_count: 4).external_id}", headers:
    end

    it "returns a scheduled email with its time", parity: true do
      get "/v2/emails/#{create(:scheduled_installment, seller:, link: nil, installment_type: Installment::AUDIENCE_TYPE).external_id}", headers:
    end

    it "reports an email that does not exist", parity: true do
      get "/v2/emails/missing", headers:
    end

    it "reports another seller's email as missing", parity: true do
      get "/v2/emails/#{create(:audience_installment, seller: create(:user)).external_id}", headers:
    end
  end

  describe "DELETE /v2/emails/:id" do
    it "deletes an email", parity: true do
      delete "/v2/emails/#{create(:audience_installment, seller:).external_id}", headers:
    end

    it "reports an email that does not exist", parity: true do
      delete "/v2/emails/missing", headers:
    end
  end

  describe "POST /v2/emails" do
    let(:params) { { subject: "Hello there", body: "<p>Hello</p>" } }

    it "creates a draft for the audience", parity: true do
      post "/v2/emails", params:, headers:
    end

    it "creates a draft for customers", parity: true do
      post "/v2/emails", params: params.merge(audience: "customers"), headers:
    end

    it "creates a draft for one product", parity: true do
      product = create(:product, user: seller, unique_permalink: "sketchpk")
      post "/v2/emails", params: params.merge(audience: "product", product_id: product.external_id), headers:
    end

    it "rejects an unknown audience", parity: true do
      post "/v2/emails", params: params.merge(audience: "everyone"), headers:
    end

    it "requires a product for a product audience", parity: true do
      post "/v2/emails", params: params.merge(audience: "product"), headers:
    end

    it "reports a product that is not the seller's", parity: true do
      post "/v2/emails", params: params.merge(audience: "product", product_id: create(:product).external_id), headers:
    end

    it "hands back an email without a subject", parity: true do
      post "/v2/emails", params: { body: "<p>Hello</p>" }, headers:
    end

    it "refuses to publish for a seller who is not eligible", parity: true do
      post "/v2/emails", params: params.merge(publish: "true"), headers:
    end
  end

  describe "POST /v2/emails/:id/unschedule" do
    it "unschedules a scheduled email", parity: true do
      post "/v2/emails/#{create(:scheduled_installment, seller:, link: nil, installment_type: Installment::AUDIENCE_TYPE).external_id}/unschedule", headers:
    end

    it "refuses an email that is not scheduled", parity: true do
      post "/v2/emails/#{create(:audience_installment, seller:).external_id}/unschedule", headers:
    end

    it "reports an email that does not exist", parity: true do
      post "/v2/emails/missing/unschedule", headers:
    end
  end

  describe "sending as an eligible seller" do
    before { seller.update!(is_team_member: true) }

    it "creates and publishes an email", parity: true do
      post "/v2/emails", params: { subject: "Big news", body: "<p>News</p>", publish: "true" }, headers:
    end

    it "sends a draft", parity: true do
      post "/v2/emails/#{create(:audience_installment, seller:, name: "Draft", message: "<p>Hello</p>").external_id}/send", headers:
    end

    it "schedules a draft", parity: true do
      post "/v2/emails/#{create(:audience_installment, seller:, name: "Draft", message: "<p>Hello</p>").external_id}/schedule", params: { to_be_published_at: "2099-01-01T12:00:00Z" }, headers:
    end

    describe "scheduling with a time zone" do
      let(:draft) { create(:audience_installment, seller:, name: "Draft", message: "<p>Hello</p>") }

      def schedule(time) = post("/v2/emails/#{draft.external_id}/schedule", params: { to_be_published_at: time }, headers:)

      it "schedules at a positive UTC offset", parity: true do
        schedule "2099-06-01T12:00:00+02:00"
      end

      it "schedules at a negative UTC offset", parity: true do
        schedule "2099-06-01T12:00:00-05:00"
      end

      it "reads a time without an offset in the seller's time zone", parity: true do
        seller.update!(timezone: "Eastern Time (US & Canada)")
        schedule "2099-06-01T12:00:00"
      end

      it "rejects a month that does not exist", parity: true do
        schedule "2099-13-01T12:00:00"
      end

      it "rejects an hour that does not exist at an offset", parity: true do
        schedule "2099-06-01T25:00:00+02:00"
      end

      it "hands back text that is not an ISO 8601 time", parity: true do
        schedule "tomorrow-ish"
      end

      it "hands back an offset without a colon", parity: true do
        schedule "2099-06-01T12:00:00+0200"
      end

      it "hands back fractional seconds", parity: true do
        schedule "2099-06-01T12:00:00.500Z"
      end
    end

    it "refuses an email that was already sent", parity: true do
      email = create(:audience_installment, :published, seller:, name: "Sent")
      create(:post_email_blast, post: email, seller:)
      post "/v2/emails/#{email.external_id}/send", headers:
    end
  end

  describe "POST /v2/emails/:id/schedule" do
    it "requires the time", parity: true do
      post "/v2/emails/#{create(:audience_installment, seller:).external_id}/schedule", headers:
    end

    it "refuses an email that was already published", parity: true do
      post "/v2/emails/#{create(:audience_installment, :published, seller:).external_id}/schedule", params: { to_be_published_at: 2.days.from_now.iso8601 }, headers:
    end
  end

  describe "POST /v2/emails/:id/send" do
    it "refuses an email that is scheduled", parity: true do
      post "/v2/emails/#{create(:scheduled_installment, seller:, link: nil, installment_type: Installment::AUDIENCE_TYPE).external_id}/send", headers:
    end

    it "hands back the preview", parity: true do
      post "/v2/emails/#{create(:audience_installment, seller:).external_id}/preview", headers:
    end
  end
end
