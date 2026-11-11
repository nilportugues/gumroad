# frozen_string_literal: true

require "spec_helper"

# Re-sending a post to one customer (PostsController#send_for_purchase) the way the customers page does, recorded for the Next.js port
# (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/audience-next.replay.test.ts. Node answers every refusal; the send itself
# (PostEmailApi, a Rails.cache rate limit) stays in Rails.
describe "Post re-send to a customer when signed in", type: :request do
  include Parity::AudienceSignedIn

  let(:seller) { create(:user, name: "Resending Seller", is_team_member: true) }
  let(:product) { create(:product, user: seller, name: "Resend product", unique_permalink: "resendp", created_at: Time.utc(2025, 1, 1)) }
  let(:post_record) { create(:published_installment, link: product, seller:, installment_type: "product", name: "Resend me", published_at: Time.utc(2025, 2, 1, 12)) }
  let(:inertia_headers) do
    { "X-Inertia" => "true", "X-Requested-With" => "XMLHttpRequest", "Accept" => "application/json", "Content-Type" => "application/json" }
  end

  before { host! DOMAIN }

  def sell(email: "customer@example.com", **attributes)
    # The purchase factory charges a card through Stripe; the re-send only reads the row.
    build(:purchase, link: product, seller:, email:, created_at: Time.utc(2025, 3, 1, 12), purchase_state: "successful", **attributes).tap { _1.save!(validate: false) }
  end

  def resend(installment, purchase, headers: inertia_headers)
    post send_for_purchase_path(installment.external_id, purchase.external_id), headers: headers.merge("X-CSRF-Token" => csrf_token)
  end

  def as_team_member(role)
    member = create(:user, name: "#{role.to_s.capitalize} Member")
    membership = create(:team_membership, user: member, seller:, role:)
    log_in(member)
    switch_to(membership)
  end

  it "answers 404 for an unknown post", parity: true do
    purchase = sell
    log_in(seller)

    post send_for_purchase_path("unknownid", purchase.external_id), headers: inertia_headers.merge("X-CSRF-Token" => csrf_token)

    expect(response).to have_http_status(:not_found)
  end

  it "answers 404 for the post of another seller", parity: true do
    other = create(:user, name: "Other Seller")
    other_post = create(:published_installment, seller: other, installment_type: "seller", name: "Not yours", published_at: Time.utc(2025, 2, 1, 12))
    purchase = sell
    log_in(seller)

    resend(other_post, purchase)

    expect(response).to have_http_status(:not_found)
  end

  it "answers 404 for a purchase of another seller", parity: true do
    other = create(:user, name: "Other Seller")
    other_product = create(:product, user: other, unique_permalink: "otherprd")
    other_purchase = build(:purchase, link: other_product, seller: other, created_at: Time.utc(2025, 3, 1, 12), purchase_state: "successful").tap { _1.save!(validate: false) }
    log_in(seller)

    resend(post_record, other_purchase)

    expect(response).to have_http_status(:not_found)
  end

  it "answers 401 when the seller is not eligible to send emails", parity: true do
    seller.update!(is_team_member: false)
    purchase = sell
    log_in(seller)

    resend(post_record, purchase)

    expect(response).to have_http_status(:unauthorized)
    expect(response.parsed_body).to eq("message" => "You are not eligible to resend this email.")
  end

  it "answers 401 for a team member whose role cannot re-send", parity: true do
    purchase = sell
    as_team_member(:accountant)

    resend(post_record, purchase)

    expect(response).to have_http_status(:unauthorized)
    expect(response.parsed_body["error"]).to include("Accountant")
  end

  it "answers 422 for a customer who unsubscribed", parity: true do
    purchase = sell(can_contact: false)
    log_in(seller)

    resend(post_record, purchase)

    expect(response).to have_http_status(:unprocessable_entity)
    expect(response.parsed_body).to eq("message" => "This customer has unsubscribed from your emails.")
  end

  it "hands a re-send to a customer to Rails", parity: true do
    purchase = sell
    allow(PostEmailApi).to receive(:process)
    log_in(seller)

    resend(post_record, purchase)

    expect(response).to have_http_status(:no_content)
    expect(PostEmailApi).to have_received(:process)
  end

  it "hands a re-send by a support team member to Rails", parity: true do
    purchase = sell
    allow(PostEmailApi).to receive(:process)
    as_team_member(:support)

    resend(post_record, purchase)

    expect(response).to have_http_status(:no_content)
  end

  it "hands a single-recipient email to Rails", parity: true do
    purchase = sell
    post_record.update!(single_recipient_email: true, single_recipient_purchase_id: purchase.id)
    allow(PostEmailApi).to receive(:process)
    log_in(seller)

    resend(post_record, purchase)

    expect(response).to have_http_status(:no_content)
  end

  it "hands a signed-out visitor to Rails", parity: true do
    purchase = sell

    resend(post_record, purchase)

    expect(response).to have_http_status(:not_found)
  end
end
