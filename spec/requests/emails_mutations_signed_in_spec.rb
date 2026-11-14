# frozen_string_literal: true

require "spec_helper"

# Creating, updating and deleting emails the way the Inertia form does (JSON body, X-Inertia, the CSRF token in a header),
# recorded for the Next.js port (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/emails-mutations.replay.test.ts,
# which sends the last request of each example and compares the redirect, the flash and every row it wrote.
describe "Emails mutations when signed in", type: :request, elasticsearch_wait_for_refresh: true do
  include Parity::AudienceSignedIn

  let(:seller) { create(:user, name: "Emailing Seller", is_team_member: true) }
  let(:product) { create(:product, user: seller, name: "Emailed product", unique_permalink: "emprod", created_at: Time.utc(2025, 1, 1)) }
  # What @inertiajs/core sends: a JSON body, XMLHttpRequest, and an Accept that is not JSON, so Pundit redirects instead of answering 401.
  let(:inertia_headers) do
    { "X-Inertia" => "true", "X-Requested-With" => "XMLHttpRequest", "Accept" => "text/html, application/xhtml+xml", "Content-Type" => "application/json", "Referer" => "http://#{DOMAIN}/emails/drafts" }
  end

  before { host! DOMAIN }

  def form(**installment)
    { installment: { name: "Launch notes", message: "<p>We shipped</p>", files: [], link_id: nil, published_at: nil, shown_in_profile_sections: [], installment_type: "audience",
                     paid_more_than_cents: nil, paid_less_than_cents: nil, bought_from: nil, active_customers_only: false, minimum_license_uses: nil,
                     created_after: "", created_before: "", bought_products: nil, bought_variants: nil, not_bought_products: [], not_bought_variants: [],
                     affiliate_products: nil, waitlisted_products: nil, not_clicked_post_id: nil, send_emails: false, shown_on_profile: true, allow_comments: true }.merge(installment),
      variant_external_id: nil, send_preview_email: false, to_be_published_at: nil, publish: false, save_action_name: "save" }
  end

  def send_form(method, path, body)
    token = csrf_token
    public_send(method, path, params: body.to_json, headers: inertia_headers.merge("X-CSRF-Token" => token))
  end

  def post_for(name, **attributes)
    create(:audience_installment, seller:, name:, message: "<p>#{name} body</p>", send_emails: false, shown_on_profile: true, **attributes)
  end

  it "creates a draft shown on the profile", parity: true do
    log_in(seller)

    send_form(:post, emails_path, form)

    expect(response).to have_http_status(:see_other)
    expect(Installment.last).to have_attributes(name: "Launch notes", installment_type: "audience", slug: "launch-notes")
    expect(flash[:notice]).to eq("Email created!")
  end

  it "creates a product email and reindexes the product", parity: true do
    log_in(seller)

    send_form(:post, emails_path, form(installment_type: "product", link_id: product.unique_permalink, bought_products: [product.unique_permalink], send_emails: false, shown_on_profile: true))

    expect(response).to have_http_status(:see_other)
    expect(Installment.last.link).to eq(product)
  end

  it "adds a numeric suffix when the name is taken", parity: true do
    post_for("Launch notes", slug: "launch-notes")
    log_in(seller)

    send_form(:post, emails_path, form)

    expect(response).to have_http_status(:see_other)
    expect(Installment.last.slug).to start_with("launch-notes-")
  end

  it "hands a post for the profile sections the seller picked to Rails", parity: true do
    section = create(:seller_profile_posts_section, seller:, shown_posts: [])
    log_in(seller)

    send_form(:post, emails_path, form(shown_in_profile_sections: [section.external_id]))

    expect(response).to have_http_status(:see_other)
    expect(section.reload.shown_posts).to eq([Installment.last.id])
  end

  it "creates a seller email with audience filters", parity: true do
    log_in(seller)

    send_form(:post, emails_path, form(installment_type: "seller", paid_more_than_cents: 500, paid_less_than_cents: 9000, bought_from: "Canada", active_customers_only: true,
                                         minimum_license_uses: 2, created_after: "2025-01-02", created_before: "2025-02-03", bought_products: [product.unique_permalink]))

    expect(response).to have_http_status(:see_other)
    expect(Installment.last.paid_more_than_cents).to eq(500)
  end

  it "creates a variant email that follows the buyers of one option", parity: true do
    variant = create(:variant, variant_category: create(:variant_category, link: product), name: "Gold")
    log_in(seller)

    send_form(:post, emails_path, form(installment_type: "variant", link_id: product.unique_permalink).merge(variant_external_id: variant.external_id))

    expect(response).to have_http_status(:see_other)
    expect(Installment.last).to have_attributes(installment_type: "variant", base_variant: variant, link: product)
  end

  it "leaves a variant email without an option when the option id is unknown", parity: true do
    log_in(seller)

    send_form(:post, emails_path, form(installment_type: "variant", link_id: product.unique_permalink).merge(variant_external_id: "unknown"))

    expect(response).to have_http_status(:see_other)
    expect(Installment.last).to have_attributes(installment_type: "variant", base_variant: nil, link: product)
  end

  it "points a draft at another option", parity: true do
    gold = create(:variant, variant_category: create(:variant_category, link: product), name: "Gold")
    silver = create(:variant, variant_category: gold.variant_category, name: "Silver")
    installment = create(:variant_post, seller:, link: product, base_variant: gold, name: "Launch notes", message: "<p>Launch notes body</p>", send_emails: false, shown_on_profile: true)
    log_in(seller)

    send_form(:put, email_path(installment.external_id), form(installment_type: "variant", link_id: product.unique_permalink).merge(variant_external_id: silver.external_id))

    expect(response).to have_http_status(:see_other)
    expect(installment.reload.base_variant).to eq(silver)
  end

  it "schedules an email", parity: true do
    log_in(seller)

    send_form(:post, emails_path, form(shown_on_profile: true).merge(save_action_name: "save_and_schedule", to_be_published_at: "2099-06-15T09:30:00"))

    expect(response).to redirect_to(scheduled_emails_path)
    expect(Installment.last.installment_rule).to be_present
  end

  it "publishes a post shown on the profile", parity: true do
    log_in(seller)

    send_form(:post, emails_path, form.merge(save_action_name: "save_and_publish", publish: true))

    expect(response).to redirect_to(published_emails_path)
    expect(Installment.last).to be_published
  end

  it "answers with the validation error when the message is empty", parity: true do
    log_in(seller)

    send_form(:post, emails_path, form(message: "<p><br></p>"))

    expect(response).to redirect_to(new_email_path)
    expect(flash[:alert]).to eq("Please include a message as part of the update.")
    expect(Installment.count).to eq(0)
  end

  it "answers with an error when the product is not the seller's", parity: true do
    log_in(seller)

    send_form(:post, emails_path, form(installment_type: "product", link_id: "nope"))

    expect(response).to redirect_to(new_email_path)
    expect(flash[:alert]).to eq("Product not found")
  end

  it "updates a draft", parity: true do
    installment = post_for("Old name", slug: "old-name")
    log_in(seller)

    send_form(:put, email_path(installment.external_id), form(name: "New name", message: "<p>Edited body</p>"))

    expect(response).to redirect_to(edit_email_path(installment.external_id))
    expect(installment.reload).to have_attributes(name: "New name", slug: "old-name")
  end

  it "changes the audience of a draft", parity: true do
    installment = post_for("Audience change", slug: "audience-change")
    log_in(seller)

    send_form(:put, email_path(installment.external_id), form(name: "Audience change", installment_type: "seller", bought_products: [product.unique_permalink], paid_more_than_cents: 100))

    expect(response).to have_http_status(:see_other)
    expect(installment.reload.bought_products).to eq([product.unique_permalink])
  end

  it "hands a draft's removal from the profile sections to Rails", parity: true do
    installment = post_for("Sectioned", slug: "sectioned")
    section = create(:seller_profile_posts_section, seller:, shown_posts: [installment.id])
    log_in(seller)

    send_form(:put, email_path(installment.external_id), form(name: "Sectioned", shown_in_profile_sections: []))

    expect(response).to have_http_status(:see_other)
    expect(section.reload.shown_posts).to eq([])
  end

  it "edits a published post", parity: true do
    installment = post_for("Live post", slug: "live-post", published_at: Time.utc(2025, 2, 1))
    log_in(seller)

    send_form(:put, email_path(installment.external_id), form(name: "Live post edited", message: "<p>Fixed a typo</p>", allow_comments: false))

    expect(response).to have_http_status(:see_other)
    expect(installment.reload).to have_attributes(name: "Live post edited", allow_comments: false)
  end

  it "answers with the validation error when a draft is saved without a message", parity: true do
    installment = post_for("Blank soon", slug: "blank-soon")
    log_in(seller)

    send_form(:put, email_path(installment.external_id), form(name: "Blank soon", message: ""))

    expect(response).to redirect_to(edit_email_path(installment.external_id))
    expect(flash[:alert]).to eq("Please include a message as part of the update.")
  end

  it "keeps the call to action of a draft whose link and text are valid", parity: true do
    installment = post_for("Call to action", slug: "call-to-action", call_to_action_text: "Buy now", call_to_action_url: "https://example.com/offer?a=1")
    log_in(seller)

    send_form(:put, email_path(installment.external_id), form(name: "Call to action", message: "<p>Edited body</p>"))

    expect(response).to redirect_to(edit_email_path(installment.external_id))
    expect(installment.reload).to have_attributes(message: "<p>Edited body</p>", call_to_action_text: "Buy now", call_to_action_url: "https://example.com/offer?a=1")
  end

  it "answers with the validation error when a draft has a call to action link and no text", parity: true do
    installment = post_for("Call to action", slug: "call-to-action")
    installment.update_columns(call_to_action_url: "https://example.com/offer", call_to_action_text: "  ")
    log_in(seller)

    send_form(:put, email_path(installment.external_id), form(name: "Call to action"))

    expect(response).to redirect_to(edit_email_path(installment.external_id))
    expect(flash[:alert]).to eq("Please enter text for your call to action.")
  end

  it "answers with the validation error when a draft has a call to action link that is not a web address", parity: true do
    installment = post_for("Call to action", slug: "call-to-action")
    installment.update_columns(call_to_action_url: "ftp://example.com/offer", call_to_action_text: "Buy now")
    log_in(seller)

    send_form(:put, email_path(installment.external_id), form(name: "Call to action"))

    expect(response).to redirect_to(edit_email_path(installment.external_id))
    expect(flash[:alert]).to eq("Please provide a valid URL for your call to action.")
  end

  it "answers 404 when updating someone else's email", parity: true do
    other = create(:audience_installment)
    log_in(seller)

    send_form(:put, email_path(other.external_id), form)

    expect(response).to have_http_status(:not_found)
  end

  it "deletes a draft and goes back to the page it came from", parity: true do
    installment = post_for("Doomed", slug: "doomed")
    log_in(seller)

    send_form(:delete, email_path(installment.external_id), {})

    expect(response).to redirect_to(drafts_emails_url)
    expect(installment.reload).to be_deleted
    expect(flash[:notice]).to eq("Email deleted!")
  end

  it "lets a marketing team member create an email", parity: true do
    member = create(:user, name: "Marketing Member")
    membership = create(:team_membership, user: member, seller:, role: TeamMembership::ROLE_MARKETING)
    log_in(member)
    switch_to(membership)

    send_form(:post, emails_path, form)

    expect(response).to have_http_status(:see_other)
    expect(Installment.last.seller).to eq(seller)
  end

  it "sends a support team member away from creating an email", parity: true do
    member = create(:user, name: "Support Member")
    membership = create(:team_membership, user: member, seller:, role: TeamMembership::ROLE_SUPPORT)
    log_in(member)
    switch_to(membership)

    send_form(:post, emails_path, form)

    expect(response).to redirect_to(dashboard_url)
    expect(flash[:alert]).to eq("Your current role as Support cannot perform this action.")
    expect(Installment.count).to eq(0)
  end

  it "does not let an accountant delete an email", parity: true do
    installment = post_for("Kept", slug: "kept")
    member = create(:user, name: "Accountant Member")
    membership = create(:team_membership, user: member, seller:, role: TeamMembership::ROLE_ACCOUNTANT)
    log_in(member)
    switch_to(membership)

    send_form(:delete, email_path(installment.external_id), {})

    expect(response).to have_http_status(:see_other)
    expect(installment.reload).not_to be_deleted
  end

  it "hands a post with files back to Rails", parity: true do
    log_in(seller)

    send_form(:post, emails_path, form(files: [{ external_id: "f1", position: 0, url: "#{AWS_S3_ENDPOINT}/gumroad-specs/attachments/a/b/original/f.pdf", stream_only: false, subtitle_files: [] }]))

    expect(response).to have_http_status(:see_other)
    expect(Installment.last.product_files).to be_present
  end
end
