# frozen_string_literal: true

require "spec_helper"

# Archiving, unarchiving and unpublishing a product the way the dashboard calls them (`request()`: a JSON body, `Accept: application/json, text/html`,
# the CSRF token in X-CSRF-Token), recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/products-mutations.replay.test.ts, which sends the last request of each example.
describe "Products mutations when signed in", type: :request do
  include Parity::AudienceSignedIn

  let(:seller) { create(:user, name: "Product Seller", is_team_member: true) }
  let(:product) { create(:product, user: seller, name: "Mutable product", unique_permalink: "mutprod", created_at: Time.utc(2025, 1, 1)) }
  let(:json_headers) do
    { "Accept" => "application/json, text/html", "Content-Type" => "application/json", "Referer" => "http://#{DOMAIN}/products" }
  end

  before { host! DOMAIN }

  def send_json(method, path, body = {})
    public_send(method, path, params: body.to_json, headers: json_headers.merge("X-CSRF-Token" => csrf_token))
  end

  def team_member(role)
    member = create(:user, name: "#{role.capitalize} Member")
    membership = create(:team_membership, user: member, seller:, role:)
    log_in(member)
    switch_to(membership)
  end

  it "archives a published product and disables its sales", parity: true do
    product
    log_in(seller)

    send_json(:post, products_archived_index_path, { id: product.unique_permalink })

    expect(response).to have_http_status(:ok)
    expect(response.parsed_body).to eq("success" => true)
    expect(product.reload).to be_archived
    expect(product.purchase_disabled_at).to be_present
  end

  it "archives an unpublished product without moving its purchase_disabled_at", parity: true do
    product.update!(purchase_disabled_at: Time.utc(2025, 2, 1))
    log_in(seller)

    send_json(:post, products_archived_index_path, { id: product.unique_permalink })

    expect(response.parsed_body).to eq("success" => true)
    expect(product.reload.purchase_disabled_at).to eq(Time.utc(2025, 2, 1))
  end

  it "answers 404 when archiving a product that is not the seller's", parity: true do
    other = create(:product, unique_permalink: "notmine")
    log_in(seller)

    send_json(:post, products_archived_index_path, { id: other.unique_permalink })

    expect(response).to have_http_status(:not_found)
    expect(other.reload).not_to be_archived
  end

  it "refuses to archive a product that is already archived", parity: true do
    product.update!(archived: true)
    log_in(seller)

    send_json(:post, products_archived_index_path, { id: product.unique_permalink })

    expect(response).to have_http_status(:unauthorized)
    expect(response.parsed_body).to eq("success" => false, "error" => "You are not allowed to perform this action.")
  end

  it "does not let a support team member archive a product", parity: true do
    product
    team_member(TeamMembership::ROLE_SUPPORT)

    send_json(:post, products_archived_index_path, { id: product.unique_permalink })

    expect(response).to have_http_status(:unauthorized)
    expect(response.parsed_body).to eq("success" => false, "error" => "Your current role as Support cannot perform this action.")
    expect(product.reload).not_to be_archived
  end

  it "lets a marketing team member archive a product", parity: true do
    product
    team_member(TeamMembership::ROLE_MARKETING)

    send_json(:post, products_archived_index_path, { id: product.unique_permalink })

    expect(response.parsed_body).to eq("success" => true)
  end

  it "unarchives a product and reports how many are left archived", parity: true do
    product.update!(archived: true)
    create(:product, user: seller, unique_permalink: "stayarch", archived: true)
    log_in(seller)

    send_json(:delete, products_archived_path(product.unique_permalink))

    expect(response.parsed_body).to eq("success" => true, "archived_products_count" => 1)
    expect(product.reload).not_to be_archived
  end

  it "refuses to unarchive a product that is not archived", parity: true do
    product
    log_in(seller)

    send_json(:delete, products_archived_path(product.unique_permalink))

    expect(response).to have_http_status(:unauthorized)
  end

  it "unpublishes a published product", parity: true do
    product
    log_in(seller)

    send_json(:post, unpublish_link_path(product.unique_permalink))

    expect(response.parsed_body).to eq("success" => true)
    expect(product.reload.purchase_disabled_at).to be_present
  end

  it "keeps the time an unpublished product was taken off sale", parity: true do
    product.update!(purchase_disabled_at: Time.utc(2025, 2, 1))
    log_in(seller)

    send_json(:post, unpublish_link_path(product.unique_permalink))

    expect(response.parsed_body).to eq("success" => true)
    expect(product.reload.purchase_disabled_at).to eq(Time.utc(2025, 2, 1))
  end

  it "answers 404 when unpublishing a product of another seller", parity: true do
    other = create(:product, unique_permalink: "notmine")
    log_in(seller)

    send_json(:post, unpublish_link_path(other.unique_permalink))

    expect(response).to have_http_status(:not_found)
  end

  it "does not let an accountant unpublish a product", parity: true do
    product
    team_member(TeamMembership::ROLE_ACCOUNTANT)

    send_json(:post, unpublish_link_path(product.unique_permalink))

    expect(response).to have_http_status(:unauthorized)
    expect(product.reload.purchase_disabled_at).to be_nil
  end

  it "deletes a product and schedules the cleanup of what it held", parity: true do
    product
    log_in(seller)

    send_json(:delete, link_path(product.unique_permalink))

    expect(response.parsed_body).to eq("success" => true)
    expect(product.reload).to be_deleted
  end

  it "cancels the subscriptions of a deleted membership later", parity: true do
    membership = create(:membership_product, user: seller, unique_permalink: "delmem")
    create(:subscription, link: membership)
    log_in(seller)

    send_json(:delete, link_path(membership.unique_permalink))

    expect(response.parsed_body).to eq("success" => true)
    expect(CancelSubscriptionsForProductWorker.jobs.size).to eq(1)
  end

  it "schedules the public files of a deleted product for deletion", parity: true do
    live = create(:public_file, resource: product, seller:)
    gone = create(:public_file, resource: product, seller:, deleted_at: Time.utc(2025, 1, 2))
    log_in(seller)

    send_json(:delete, link_path(product.unique_permalink))

    expect(response.parsed_body).to eq("success" => true)
    expect(live.reload.scheduled_for_deletion_at).to be_present
    expect(gone.reload.scheduled_for_deletion_at).to be_nil
  end

  it "answers 404 when deleting a product of another seller", parity: true do
    other = create(:product, unique_permalink: "notmine")
    log_in(seller)

    send_json(:delete, link_path(other.unique_permalink))

    expect(response).to have_http_status(:not_found)
    expect(other.reload).not_to be_deleted
  end

  it "does not let a support team member delete a product", parity: true do
    product
    team_member(TeamMembership::ROLE_SUPPORT)

    send_json(:delete, link_path(product.unique_permalink))

    expect(response).to have_http_status(:unauthorized)
    expect(product.reload).not_to be_deleted
  end

  it "removes a deleted product from the products sections that show it", parity: true do
    shown = create(:seller_profile_products_section, seller:, shown_products: [product.id, 987_654])
    unrelated = create(:seller_profile_products_section, seller:, shown_products: [987_654])
    log_in(seller)

    send_json(:delete, link_path(product.unique_permalink))

    expect(response.parsed_body).to eq("success" => true)
    expect(product.reload).to be_deleted
    expect(shown.reload.shown_products).to eq([987_654])
    expect(unrelated.reload.shown_products).to eq([987_654])
  end

  it "clears a deleted product from the featured product section", parity: true do
    featured = create(:seller_profile_featured_product_section, seller:, featured_product_id: product.id)
    other = create(:seller_profile_featured_product_section, seller:, featured_product_id: 987_654)
    log_in(seller)

    send_json(:delete, link_path(product.unique_permalink))

    expect(response.parsed_body).to eq("success" => true)
    expect(featured.reload.json_data).to eq({})
    expect(other.reload.featured_product_id).to eq(987_654)
  end

  it "deletes the custom domain of a deleted product", parity: true do
    domain = create(:custom_domain, user: nil, product:, domain: "shop.example.com", created_at: Time.utc(2025, 1, 1), updated_at: Time.utc(2025, 1, 1))
    log_in(seller)

    send_json(:delete, link_path(product.unique_permalink))

    expect(response.parsed_body).to eq("success" => true)
    expect(domain.reload).to be_deleted
  end

  it "unpublishes a tiered membership", parity: true do
    membership = create(:membership_product, user: seller, unique_permalink: "tiermem")
    log_in(seller)

    send_json(:post, unpublish_link_path(membership.unique_permalink))

    expect(response.parsed_body).to eq("success" => true)
  end
end
