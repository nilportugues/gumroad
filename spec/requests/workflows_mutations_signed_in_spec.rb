# frozen_string_literal: true

require "spec_helper"

# Creating, updating, publishing and deleting workflows the way the Inertia form does (JSON body, X-Inertia, the CSRF token in a
# header), recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/audience-mutations.replay.test.ts, which sends the last request of each example.
describe "Workflows mutations when signed in", type: :request do
  include Parity::AudienceSignedIn

  let(:seller) { create(:user, name: "Workflow Seller", is_team_member: true) }
  let(:product) { create(:product, user: seller, name: "Workflow product", unique_permalink: "wfmut", created_at: Time.utc(2025, 1, 1)) }
  let(:inertia_headers) do
    { "X-Inertia" => "true", "X-Requested-With" => "XMLHttpRequest", "Accept" => "text/html, application/xhtml+xml", "Content-Type" => "application/json", "Referer" => "http://#{DOMAIN}/workflows" }
  end

  before { host! DOMAIN }

  def form(**workflow)
    { workflow: { name: "Welcome flow", workflow_type: "audience", workflow_trigger: nil, bought_products: [], bought_variants: [], variant_external_id: nil, permalink: nil,
                  not_bought_products: [], not_bought_variants: [], paid_more_than: nil, paid_less_than: nil, created_after: "", created_before: "", bought_from: nil,
                  affiliate_products: [], send_to_past_customers: false, save_action_name: "save" }.merge(workflow) }
  end

  def send_form(method, path, body)
    token = csrf_token
    public_send(method, path, params: body.to_json, headers: inertia_headers.merge("X-CSRF-Token" => token))
  end

  def add_email(workflow, name:, delay_seconds:, published: false)
    installment = create(:workflow_installment, workflow:, seller:, link: workflow.link, name:, message: "<p>#{name}</p>", published_at: published ? Time.utc(2025, 2, 1) : nil)
    installment.installment_rule.update_columns(delayed_delivery_time: delay_seconds, time_period: delay_seconds >= 1.day ? "day" : "hour")
    installment
  end

  it "creates an audience workflow", parity: true do
    log_in(seller)

    send_form(:post, workflows_path, form)

    workflow = Workflow.last
    expect(response).to redirect_to(workflow_emails_path(workflow.external_id))
    expect(workflow).to have_attributes(name: "Welcome flow", workflow_type: "audience")
    expect(flash[:notice]).to eq("Changes saved!")
  end

  it "creates a product workflow that follows the buyers of one product", parity: true do
    log_in(seller)

    send_form(:post, workflows_path, form(workflow_type: "product", permalink: product.unique_permalink, send_to_past_customers: true, bought_products: [product.unique_permalink]))

    expect(response).to have_http_status(:see_other)
    expect(Workflow.last.link).to eq(product)
  end

  it "creates a seller workflow with filters", parity: true do
    log_in(seller)

    send_form(:post, workflows_path, form(workflow_type: "seller", paid_more_than: 10, paid_less_than: "50.5", created_after: "2025-01-02", created_before: "2025-02-03", bought_from: "Canada",
                                           bought_products: [product.unique_permalink], not_bought_products: ["other"]))

    expect(response).to have_http_status(:see_other)
    expect(Workflow.last.paid_more_than_cents).to eq(1000)
  end

  it "creates a follower workflow and an affiliate workflow", parity: true do
    log_in(seller)

    send_form(:post, workflows_path, form(name: "Followers", workflow_type: "follower"))
    send_form(:post, workflows_path, form(name: "Affiliates", workflow_type: "affiliate", affiliate_products: [product.unique_permalink]))

    expect(response).to have_http_status(:see_other)
    expect(Workflow.pluck(:workflow_type)).to match_array(%w[follower affiliate])
  end

  it "answers with the validation error when the paid filters are out of order", parity: true do
    log_in(seller)

    send_form(:post, workflows_path, form(workflow_type: "seller", paid_more_than: 500, paid_less_than: 10))

    expect(response).to redirect_to(new_workflow_path)
    expect(flash[:alert]).to eq("Please enter valid paid more than and paid less than values.")
    expect(Workflow.count).to eq(0)
  end

  it "answers 404 when the product is not the seller's", parity: true do
    log_in(seller)

    send_form(:post, workflows_path, form(workflow_type: "product", permalink: "nope"))

    expect(response).to have_http_status(:not_found)
  end

  it "renames a workflow", parity: true do
    workflow = create(:audience_workflow, seller:, name: "Before")
    log_in(seller)

    send_form(:patch, workflow_path(workflow.external_id), form(name: "After"))

    expect(response).to redirect_to(workflow_emails_path(workflow.external_id))
    expect(workflow.reload.name).to eq("After")
  end

  it "moves the emails of an unpublished workflow along with its audience", parity: true do
    workflow = create(:product_workflow, seller:, link: product, name: "Syncing")
    add_email(workflow, name: "First", delay_seconds: 1.hour.to_i)
    log_in(seller)

    send_form(:put, workflow_path(workflow.external_id), form(name: "Syncing", workflow_type: "seller", paid_more_than: 10, bought_products: [product.unique_permalink], send_to_past_customers: true))

    expect(response).to have_http_status(:see_other)
    expect(workflow.installments.first.installment_type).to eq("seller")
  end

  it "keeps the audience of a workflow that was published", parity: true do
    workflow = create(:audience_workflow, seller:, name: "Live", published_at: Time.utc(2025, 2, 1), first_published_at: Time.utc(2025, 2, 1))
    log_in(seller)

    send_form(:patch, workflow_path(workflow.external_id), form(name: "Live renamed", workflow_type: "seller", paid_more_than: 99))

    expect(response).to have_http_status(:see_other)
    expect(workflow.reload).to have_attributes(name: "Live renamed", workflow_type: "audience")
  end

  it "publishes a workflow and schedules its emails", parity: true do
    workflow = create(:product_workflow, seller:, link: product, name: "To publish")
    add_email(workflow, name: "Day one", delay_seconds: 1.day.to_i)
    add_email(workflow, name: "Week one", delay_seconds: 7.days.to_i)
    log_in(seller)

    send_form(:patch, workflow_path(workflow.external_id), form(name: "To publish", workflow_type: "product", permalink: product.unique_permalink, save_action_name: "save_and_publish"))

    expect(response).to redirect_to(workflow_emails_path(workflow.external_id))
    expect(flash[:notice]).to eq("Workflow published!")
    expect(workflow.reload).to be_published_at
  end

  it "refuses to publish for a seller who may not send emails", parity: true do
    seller.update!(is_team_member: false)
    workflow = create(:audience_workflow, seller:, name: "Early")
    add_email(workflow, name: "Hello", delay_seconds: 0).update_columns(workflow_id: workflow.id)
    log_in(seller)

    send_form(:patch, workflow_path(workflow.external_id), form(name: "Early", save_action_name: "save_and_publish"))

    expect(response).to redirect_to(edit_workflow_path(workflow.external_id))
    expect(flash[:alert]).to start_with("You cannot publish a workflow")
  end

  it "unpublishes a workflow", parity: true do
    workflow = create(:product_workflow, seller:, link: product, name: "Live", published_at: Time.utc(2025, 2, 1), first_published_at: Time.utc(2025, 2, 1))
    add_email(workflow, name: "Day one", delay_seconds: 1.day.to_i, published: true)
    log_in(seller)

    send_form(:patch, workflow_path(workflow.external_id), form(name: "Live", workflow_type: "product", permalink: product.unique_permalink, save_action_name: "save_and_unpublish"))

    expect(response).to redirect_to(workflow_emails_path(workflow.external_id))
    expect(flash[:notice]).to eq("Unpublished!")
  end

  it "deletes a workflow with its emails", parity: true do
    workflow = create(:product_workflow, seller:, link: product, name: "Doomed", published_at: Time.utc(2025, 2, 1), first_published_at: Time.utc(2025, 2, 1))
    add_email(workflow, name: "Day one", delay_seconds: 1.day.to_i, published: true)
    log_in(seller)

    send_form(:delete, workflow_path(workflow.external_id), {})

    expect(response).to redirect_to(workflows_path)
    expect(flash[:notice]).to eq("Workflow deleted!")
    expect(workflow.reload).to be_deleted
  end

  it "answers 404 when updating someone else's workflow", parity: true do
    other = create(:audience_workflow)
    log_in(seller)

    send_form(:patch, workflow_path(other.external_id), form)

    expect(response).to have_http_status(:not_found)
  end

  it "lets a marketing team member create a workflow", parity: true do
    member = create(:user, name: "Marketing Member")
    membership = create(:team_membership, user: member, seller:, role: TeamMembership::ROLE_MARKETING)
    log_in(member)
    switch_to(membership)

    send_form(:post, workflows_path, form)

    expect(response).to have_http_status(:see_other)
    expect(Workflow.last.seller).to eq(seller)
  end

  it "does not let an accountant create a workflow", parity: true do
    member = create(:user, name: "Accountant Member")
    membership = create(:team_membership, user: member, seller:, role: TeamMembership::ROLE_ACCOUNTANT)
    log_in(member)
    switch_to(membership)

    send_form(:post, workflows_path, form)

    expect(response).to redirect_to(dashboard_url)
    expect(flash[:alert]).to eq("Your current role as Accountant cannot perform this action.")
    expect(Workflow.count).to eq(0)
  end

  it "does not let a support team member delete a workflow", parity: true do
    workflow = create(:audience_workflow, seller:, name: "Kept")
    member = create(:user, name: "Support Member")
    membership = create(:team_membership, user: member, seller:, role: TeamMembership::ROLE_SUPPORT)
    log_in(member)
    switch_to(membership)

    send_form(:delete, workflow_path(workflow.external_id), {})

    expect(response).to redirect_to(dashboard_url)
    expect(workflow.reload).not_to be_deleted
  end

  it "hands a variant workflow back to Rails", parity: true do
    variant = create(:variant, variant_category: create(:variant_category, link: product), name: "Gold")
    log_in(seller)

    send_form(:post, workflows_path, form(workflow_type: "variant", permalink: product.unique_permalink, variant_external_id: variant.external_id))

    expect(response).to have_http_status(:see_other)
    expect(Workflow.last.base_variant).to eq(variant)
  end
end
