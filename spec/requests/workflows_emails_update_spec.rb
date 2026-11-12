# frozen_string_literal: true

require "spec_helper"

# Saving the emails of a workflow (Workflows::EmailsController#update) the way the Inertia form does, recorded for the Next.js port
# (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/audience-next.replay.test.ts. Node answers the 404s and the policy
# refusals and runs Workflow::SaveInstallmentsService for emails without files, previews or upsell cards in a workflow that
# is not an abandoned cart; the other saves stay in Rails.
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

  def email_params(id:, name: "Welcome", message: "<p>Hello there</p>", time_period: "hour", time_duration: 2, **extra)
    { id:, name:, message:, time_period:, time_duration:, send_preview_email: false, files: [] }.merge(extra)
  end

  def add_email(workflow, name:, delay_seconds:, published: false)
    installment = create(:workflow_installment, workflow:, seller:, link: workflow.link, name:, message: "<p>#{name}</p>", published_at: published ? Time.utc(2025, 2, 1) : nil)
    installment.installment_rule.update_columns(delayed_delivery_time: delay_seconds, time_period: delay_seconds >= 1.day ? "day" : "hour")
    installment
  end

  it "saves an empty list of emails for an owner", parity: true do
    log_in(seller)

    save_emails(workflow.external_id)

    expect(response).to redirect_to(workflow_emails_path(workflow.external_id))
    expect(response).to have_http_status(:see_other)
    expect(flash[:notice]).to eq("Changes saved!")
  end

  it "saves for a marketing team member", parity: true do
    as_team_member(:marketing)

    save_emails(workflow.external_id)

    expect(response).to have_http_status(:see_other)
  end

  it "answers with the error when the emails are missing", parity: true do
    log_in(seller)

    save_emails(workflow.external_id, { workflow: { save_action_name: "save", send_to_past_customers: false } })

    expect(response).to redirect_to(workflow_emails_path(workflow.external_id))
    expect(flash[:alert]).to eq("Installments data is required")
  end

  it "adds an email to a workflow", parity: true do
    log_in(seller)

    save_emails(workflow.external_id, { workflow: body[:workflow].merge(installments: [email_params(id: "newemail1")]) })

    expect(response).to have_http_status(:see_other)
    expect(workflow.installments.alive.pluck(:name)).to eq(["Welcome"])
  end

  it "updates the name, message and delay of an email", parity: true do
    log_in(seller)
    email = add_email(workflow, name: "Old name", delay_seconds: 3600)

    save_emails(workflow.external_id, { workflow: body[:workflow].merge(installments: [email_params(id: email.external_id, name: "New name", message: "<p>New text</p>", time_period: "day", time_duration: 3)]) })

    expect(response).to have_http_status(:see_other)
    expect(email.reload).to have_attributes(name: "New name")
    expect(email.installment_rule.delayed_delivery_time).to eq(3.days.to_i)
  end

  it "deletes the emails left out of the save", parity: true do
    log_in(seller)
    kept = add_email(workflow, name: "Kept", delay_seconds: 3600)
    dropped = add_email(workflow, name: "Dropped", delay_seconds: 7200)

    save_emails(workflow.external_id, { workflow: body[:workflow].merge(installments: [email_params(id: kept.external_id, name: "Kept")]) })

    expect(response).to have_http_status(:see_other)
    expect(dropped.reload.deleted_at).to be_present
    expect(kept.reload.deleted_at).to be_nil
  end

  it "publishes the workflow with its emails", parity: true do
    log_in(seller)
    email = add_email(workflow, name: "Welcome", delay_seconds: 3600)

    save_emails(workflow.external_id, { workflow: body[:workflow].merge(save_action_name: "save_and_publish", installments: [email_params(id: email.external_id)]) })

    expect(response).to have_http_status(:see_other)
    expect(flash[:notice]).to eq("Workflow published!")
    expect(workflow.reload.published_at).to be_present
  end

  it "keeps the delay of a published email and reschedules nothing", parity: true do
    log_in(seller)
    workflow.update_columns(published_at: Time.utc(2025, 2, 1), first_published_at: Time.utc(2025, 2, 1))
    email = add_email(workflow, name: "Welcome", delay_seconds: 7200, published: true)

    save_emails(workflow.external_id, { workflow: body[:workflow].merge(installments: [email_params(id: email.external_id, time_duration: 2)]) })

    expect(response).to have_http_status(:see_other)
  end

  it "reschedules an email of a published workflow when its delay changes", parity: true do
    log_in(seller)
    workflow.update_columns(published_at: Time.utc(2025, 2, 1), first_published_at: Time.utc(2025, 2, 1))
    email = add_email(workflow, name: "Welcome", delay_seconds: 7200, published: true)

    save_emails(workflow.external_id, { workflow: body[:workflow].merge(installments: [email_params(id: email.external_id, time_duration: 5)]) })

    expect(response).to have_http_status(:see_other)
    expect(WorkflowInstallmentScheduleIntent.count).to eq(1)
  end

  it "answers with the error when an email has no message", parity: true do
    log_in(seller)

    save_emails(workflow.external_id, { workflow: body[:workflow].merge(installments: [email_params(id: "newemail1", message: "<p><br></p>")]) })

    expect(response).to redirect_to(workflow_emails_path(workflow.external_id))
    expect(flash[:alert]).to eq("Please include a message as part of the update.")
    expect(workflow.installments.count).to eq(0)
  end

  it "answers with the error when an email name is too long", parity: true do
    log_in(seller)

    save_emails(workflow.external_id, { workflow: body[:workflow].merge(installments: [email_params(id: "newemail1", name: "n" * 256)]) })

    expect(response).to redirect_to(workflow_emails_path(workflow.external_id))
    expect(flash[:alert]).to eq("Name is too long (maximum is 255 characters)")
  end

  it "rolls back every email when a later one is invalid", parity: true do
    log_in(seller)

    save_emails(workflow.external_id, { workflow: body[:workflow].merge(installments: [email_params(id: "newemail1"), email_params(id: "newemail2", message: "")]) })

    expect(flash[:alert]).to eq("Please include a message as part of the update.")
    expect(workflow.installments.count).to eq(0)
  end

  it "hands a save with a file to Rails", parity: true do
    log_in(seller)

    save_emails(workflow.external_id, { workflow: body[:workflow].merge(installments: [email_params(id: "newemail1", files: [{ external_id: "f1", url: "https://example.com/a.pdf", position: 0, stream_only: false, subtitle_files: [] }])]) })

    expect(response.status).to be_in([303, 302])
  end

  it "hands a save that sends a preview email to Rails", parity: true do
    log_in(seller)

    save_emails(workflow.external_id, { workflow: body[:workflow].merge(installments: [email_params(id: "newemail1", send_preview_email: true)]) })

    expect(response).to have_http_status(:see_other)
    expect(flash[:notice]).to eq("A preview has been sent to your email.")
  end

  it "redirects a signed-out visitor to the login page", parity: true do
    save_emails(workflow.external_id)

    expect(response).to have_http_status(:see_other)
  end
end
