# frozen_string_literal: true

require "spec_helper"

# Saving the emails of a workflow (Workflows::EmailsController#update) the way the Inertia form does, recorded for the Next.js port
# (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/audience-next.replay.test.ts. Node answers the 404s and the policy
# refusals; the save itself (Workflow::SaveInstallmentsService) stays in Rails.
describe "Workflow emails save when signed in", type: :request do
  include Parity::AudienceSignedIn

  let(:seller) { create(:user, name: "Workflow Seller", is_team_member: true) }
  let(:workflow) { create(:audience_workflow, seller:, name: "Welcome flow", created_at: Time.utc(2025, 3, 4)) }
  let(:inertia_headers) do
    { "X-Inertia" => "true", "X-Requested-With" => "XMLHttpRequest", "Accept" => "text/html, application/xhtml+xml", "Content-Type" => "application/json", "Referer" => "http://#{DOMAIN}/workflows" }
  end
  let(:body) { { workflow: { save_action_name: "save", send_to_past_customers: false, installments: [] } } }

  before { host! DOMAIN }

  def save_emails(workflow_id, params = body)
    patch workflow_emails_path(workflow_id), params: params.to_json, headers: inertia_headers.merge("X-CSRF-Token" => csrf_token)
  end

  def as_team_member(role)
    member = create(:user, name: "#{role.to_s.capitalize} Member")
    membership = create(:team_membership, user: member, seller:, role:)
    log_in(member)
    switch_to(membership)
  end

  it "answers 404 for an unknown workflow", parity: true do
    log_in(seller)

    save_emails("unknownid")

    expect(response).to have_http_status(:not_found)
  end

  it "answers 404 for the workflow of another seller", parity: true do
    other = create(:audience_workflow, seller: create(:user, name: "Other Seller"), name: "Not yours", created_at: Time.utc(2025, 3, 4))
    log_in(seller)

    save_emails(other.external_id)

    expect(response).to have_http_status(:not_found)
  end

  it "sends a support team member to the dashboard with an alert", parity: true do
    as_team_member(:support)

    save_emails(workflow.external_id)

    expect(response).to redirect_to(dashboard_path)
    expect(flash[:alert]).to include("Support")
  end

  it "sends an accountant team member to the dashboard with an alert", parity: true do
    as_team_member(:accountant)

    save_emails(workflow.external_id)

    expect(response).to redirect_to(dashboard_path)
  end

  it "hands a save by an owner to Rails", parity: true do
    log_in(seller)

    save_emails(workflow.external_id)

    expect(response).to redirect_to(workflow_emails_path(workflow.external_id))
    expect(response).to have_http_status(:see_other)
    expect(flash[:notice]).to eq("Changes saved!")
  end

  it "hands a save by a marketing team member to Rails", parity: true do
    as_team_member(:marketing)

    save_emails(workflow.external_id)

    expect(response).to have_http_status(:see_other)
  end

  it "redirects a signed-out visitor to the login page", parity: true do
    save_emails(workflow.external_id)

    expect(response).to have_http_status(:see_other)
  end
end
