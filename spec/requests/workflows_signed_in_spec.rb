# frozen_string_literal: true

require "spec_helper"

# Signed-in visits to the workflows pages, recorded for the Next.js port (PARITY_RECORD=1) and
# replayed by nextjs/parity/__tests__/audience-pages.replay.test.ts, which sends the last request
# of each example.
describe "Workflows when signed in", type: :request do
  include Parity::AudienceSignedIn

  let(:seller) { create(:user, name: "Workflow Seller") }
  let(:product) { create(:product, user: seller, name: "Workflow product", unique_permalink: "wfprod", created_at: Time.utc(2025, 1, 1)) }

  before { host! DOMAIN }

  def add_installment(workflow, name:, delay_seconds:, message: "<p>Hello</p>", published: false)
    installment = create(:workflow_installment, workflow:, seller:, link: workflow.link, name:, message:, published_at: published ? Time.utc(2025, 2, 1) : nil)
    installment.installment_rule.update_columns(delayed_delivery_time: delay_seconds, time_period: delay_seconds >= 1.day ? "day" : "hour")
    installment
  end

  it "redirects a signed-out visitor to the login page", parity: true do
    get workflows_path

    expect(response).to redirect_to(login_path(next: "/workflows"))
  end

  it "lists no workflows and records the view", parity: true do
    log_in(seller)

    get workflows_path

    expect(response).to be_successful
    expect(inertia_props_of(response)["workflows"]).to eq([])
  end

  it "lists the workflows of every recipient type with their emails, newest first", parity: true do
    variant = create(:variant, variant_category: create(:variant_category, link: product), name: "Gold")
    product_workflow = create(:product_workflow, seller:, link: product, name: "Welcome", published_at: Time.utc(2025, 2, 1), first_published_at: Time.utc(2025, 2, 1), created_at: Time.utc(2025, 3, 1))
    add_installment(product_workflow, name: "Thanks", delay_seconds: 0, published: true)
    add_installment(product_workflow, name: "Tips", delay_seconds: 3.days.to_i, message: "<p>Tips for you</p>", published: true)
    variant_workflow = create(:variant_workflow, seller:, link: product, base_variant: variant, name: "Gold tier", created_at: Time.utc(2025, 3, 2))
    add_installment(variant_workflow, name: "Gold hello", delay_seconds: 7.days.to_i)
    seller_workflow = create(:seller_workflow, seller:, name: "Everyone who bought", created_at: Time.utc(2025, 3, 3), paid_more_than_cents: 1050, created_after: "2025-01-02", bought_products: ["wfprod"], not_bought_products: ["other"], bought_from: "Canada")
    add_installment(seller_workflow, name: "Customers", delay_seconds: 2.hours.to_i)
    create(:audience_workflow, seller:, name: "Audience", created_at: Time.utc(2025, 3, 4))
    create(:follower_workflow, seller:, name: "Followers", created_at: Time.utc(2025, 3, 5), send_to_past_customers: true)
    affiliate_workflow = create(:affiliate_workflow, seller:, name: "Affiliates", created_at: Time.utc(2025, 3, 6), affiliate_products: ["wfprod"])
    add_installment(affiliate_workflow, name: "Partners", delay_seconds: 30.days.to_i)
    create(:workflow, seller:, link: product, name: "Removed", deleted_at: Time.utc(2025, 3, 7), created_at: Time.utc(2025, 3, 7))
    create(:workflow, name: "Someone else's", created_at: Time.utc(2025, 3, 8))
    log_in(seller)

    get workflows_path

    expect(response).to be_successful
    expect(inertia_props_of(response)["workflows"].map { _1["name"] }).to eq(["Affiliates", "Followers", "Audience", "Everyone who bought", "Gold tier", "Welcome"])
  end

  it "renders the new workflow form with the products, variants, affiliate products and countries", parity: true do
    variant = create(:variant, variant_category: create(:variant_category, link: product), name: "Gold")
    variant.update!(name: "Gold")
    create(:product, user: seller, name: "Second product", unique_permalink: "second", created_at: Time.utc(2025, 1, 2))
    create(:product, user: seller, name: "Hidden product", unique_permalink: "hidden", deleted_at: Time.utc(2025, 1, 3))
    log_in(seller)

    get new_workflow_path

    expect(response).to be_successful
    expect(inertia_props_of(response)["context"]["products_and_variant_options"].map { _1["id"] }).to include("wfprod")
  end

  it "renders the edit form of a workflow", parity: true do
    workflow = create(:product_workflow, seller:, link: product, name: "Editable", send_to_past_customers: true)
    add_installment(workflow, name: "First", delay_seconds: 1.hour.to_i)
    log_in(seller)

    get edit_workflow_path(workflow.external_id)

    expect(response).to be_successful
    expect(inertia_props_of(response)["workflow"]).to include("name" => "Editable", "send_to_past_customers" => true)
  end

  it "renders the emails of a workflow", parity: true do
    workflow = create(:product_workflow, seller:, link: product, name: "With emails", published_at: Time.utc(2025, 2, 1), first_published_at: Time.utc(2025, 2, 1))
    add_installment(workflow, name: "Day one", delay_seconds: 1.day.to_i, published: true)
    add_installment(workflow, name: "Week one", delay_seconds: 7.days.to_i, published: true)
    log_in(seller)

    get workflow_emails_path(workflow.external_id)

    expect(response).to be_successful
    expect(inertia_props_of(response)["workflow"]["installments"].map { _1["name"] }).to eq(["Day one", "Week one"])
  end

  it "answers 404 for the emails of a workflow that belongs to someone else", parity: true do
    other = create(:workflow)
    log_in(seller)

    get workflow_emails_path(other.external_id)

    expect(response).to have_http_status(:not_found)
  end

  it "renders the edit form of a deleted workflow", parity: true do
    workflow = create(:product_workflow, seller:, link: product, deleted_at: Time.utc(2025, 1, 1))
    log_in(seller)

    get edit_workflow_path(workflow.external_id)

    expect(response).to be_successful
  end

  it "sends a support team member away from the new workflow form", parity: true do
    member = create(:user, name: "Support Member")
    membership = create(:team_membership, user: member, seller:, role: TeamMembership::ROLE_SUPPORT)
    log_in(member)
    switch_to(membership)

    get new_workflow_path

    expect(response).to redirect_to(dashboard_url)
    expect(flash[:alert]).to eq("Your current role as Support cannot perform this action.")
  end

  it "lets an accountant team member see the list and the emails", parity: true do
    member = create(:user, name: "Accountant Member")
    membership = create(:team_membership, user: member, seller:, role: TeamMembership::ROLE_ACCOUNTANT)
    workflow = create(:product_workflow, seller:, link: product, name: "Seen by accountant")
    log_in(member)
    switch_to(membership)

    get workflows_path
    expect(response).to be_successful

    get workflow_emails_path(workflow.external_id)
    expect(response).to be_successful
  end

  it "lets a signed-in user without an email address add one first", parity: true do
    log_in(seller)
    seller.update_columns(email: nil)

    get workflows_path

    expect(response).to redirect_to(settings_main_path)
  end
end
