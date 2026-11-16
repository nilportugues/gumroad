# frozen_string_literal: true

require "spec_helper"

# Api::V2::WorkflowsController and Api::V2::Workflows::EmailsController through the full Rack stack, recorded for the Next.js port
# (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/api-v2-ws17c.replay.test.ts.
describe "API v2 workflows", type: :request do
  let(:seller) { create(:user, username: "dude", name: "Dude", email: "dude@example.com") }
  let(:application) { create(:oauth_application, owner: create(:user)) }
  let(:headers) { { "Authorization" => "Bearer #{create("doorkeeper/access_token", application:, resource_owner_id: seller.id, scopes: "edit_emails").token}" } }

  before { host! API_DOMAIN }

  def workflow_with_emails
    workflow = create(:audience_workflow, seller:, name: "Onboarding", published_at: 3.days.ago, first_published_at: 4.days.ago, send_to_past_customers: true, paid_more_than_cents: 1500, bought_products: ["abc"])
    second = create(:workflow_installment, workflow:, seller:, name: "Week one", message: "<p>One</p>", published_at: 2.days.ago)
    first = create(:workflow_installment, workflow:, seller:, name: "Welcome", message: "<p>Welcome</p>", published_at: 2.days.ago)
    second.installment_rule.update!(delayed_delivery_time: 7.days.to_i, time_period: "day")
    first.installment_rule.update!(delayed_delivery_time: 2.hours.to_i, time_period: "hour")
    first.update_columns(customer_count: 20)
    workflow
  end

  describe "GET /v2/workflows" do
    it "lists the seller's live workflows newest first with their email counts", parity: true do
      older = create(:audience_workflow, seller:, name: "Older", created_at: 2.hours.ago)
      newer = create(:product_workflow, seller:, name: "Newer", created_at: 1.hour.ago, paid_more_than_cents: 100)
      create(:workflow_installment, workflow: newer, seller:, link: newer.link)
      create(:audience_workflow, seller:, deleted_at: Time.current)
      create(:audience_workflow, seller: create(:user))
      older.touch
      get "/v2/workflows", headers:
    end

    it "serves /api/v2 on the main domain", parity: true do
      host! DOMAIN
      create(:audience_workflow, seller:, name: "Audience")
      get "/api/v2/workflows", headers:
    end

    it "forbids a token without edit_emails", parity: true do
      get "/v2/workflows", headers: { "Authorization" => "Bearer #{create("doorkeeper/access_token", application:, resource_owner_id: seller.id, scopes: "view_public").token}" }
    end
  end

  describe "GET /v2/workflows/:id" do
    it "returns the workflow with its emails in delivery order", parity: true do
      get "/v2/workflows/#{workflow_with_emails.external_id}", headers:
    end

    it "returns a workflow without emails", parity: true do
      get "/v2/workflows/#{create(:audience_workflow, seller:).external_id}", headers:
    end

    it "reports a workflow that does not exist", parity: true do
      get "/v2/workflows/missing", headers:
    end

    it "reports another seller's workflow as missing", parity: true do
      get "/v2/workflows/#{create(:audience_workflow, seller: create(:user)).external_id}", headers:
    end
  end

  describe "POST /v2/workflows/:workflow_id/emails" do
    let(:workflow) { create(:audience_workflow, seller:, send_to_past_customers: true) }
    let(:params) { { subject: "Week four", body: "<p>Keep going.</p>", delay_amount: "4", delay_unit: "week" } }

    it "hands back a valid email", parity: true do
      post "/v2/workflows/#{workflow.external_id}/emails", params:, headers:
    end

    it "requires every field", parity: true do
      post "/v2/workflows/#{workflow.external_id}/emails", params: params.except(:body), headers:
    end

    it "refuses a workflow state parameter", parity: true do
      post "/v2/workflows/#{workflow.external_id}/emails", params: params.merge(publish: "true"), headers:
    end

    it "refuses a blank subject", parity: true do
      post "/v2/workflows/#{workflow.external_id}/emails", params: params.merge(subject: " "), headers:
    end

    it "refuses a body that is not a string", parity: true do
      post "/v2/workflows/#{workflow.external_id}/emails", params: params.merge(body: ["x"]), headers:
    end

    it "refuses a negative delay", parity: true do
      post "/v2/workflows/#{workflow.external_id}/emails", params: params.merge(delay_amount: "-1"), headers:
    end

    it "refuses an unknown delay unit", parity: true do
      post "/v2/workflows/#{workflow.external_id}/emails", params: params.merge(delay_unit: "year"), headers:
    end

    it "refuses a delay past the maximum", parity: true do
      post "/v2/workflows/#{workflow.external_id}/emails", params: params.merge(delay_amount: "5000", delay_unit: "month"), headers:
    end

    it "refuses an abandoned cart workflow", parity: true do
      post "/v2/workflows/#{create(:abandoned_cart_workflow, seller:).external_id}/emails", params:, headers:
    end

    it "reports a workflow that does not exist", parity: true do
      post "/v2/workflows/missing/emails", params:, headers:
    end
  end

  describe "PUT /v2/workflows/:workflow_id/emails/:email_id" do
    let(:workflow) { workflow_with_emails }
    let(:email) { workflow.installments.alive.first }

    it "hands back a valid edit", parity: true do
      put "/v2/workflows/#{workflow.external_id}/emails/#{email.external_id}", params: { subject: "New subject" }, headers:
    end

    it "requires at least one field", parity: true do
      put "/v2/workflows/#{workflow.external_id}/emails/#{email.external_id}", params: {}, headers:
    end

    it "requires the delay fields together", parity: true do
      put "/v2/workflows/#{workflow.external_id}/emails/#{email.external_id}", params: { delay_amount: "2" }, headers:
    end

    it "reports an email that does not exist", parity: true do
      put "/v2/workflows/#{workflow.external_id}/emails/missing", params: { subject: "x" }, headers:
    end
  end
end
