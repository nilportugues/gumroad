# frozen_string_literal: true

require "spec_helper"

# Re-sending a post to one customer (PostsController#send_for_purchase) the way the customers page does, recorded for the Next.js port
# (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/audience-next.replay.test.ts. Node answers every refusal and the send
# of a post without files (PostEmailApi, the Rails.cache rate limit, the customer's earlier email records); a post with files
# or a single-recipient email stays in Rails.
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

  # Rails clears its cache between examples; the replayed Node process keeps its own, keyed by the post and purchase ids,
  # which restart at 1 in every example. Each example that sends takes a post id of its own so none finds another's limit.
  def spend_post_ids(count) = create_list(:installment, count, seller:)

  def email_infos_of(purchase) = CreatorContactingCustomersEmailInfo.where(purchase:, installment: post_record)

  it "sends the post to the customer and records the email", parity: true do
    create(:user, email: "customer@example.com", name: "Customer on Gumroad")
    purchase = sell
    log_in(seller)

    resend(post_record, purchase)

    expect(response).to have_http_status(:no_content)
    expect(email_infos_of(purchase).pluck(:state)).to eq(["sent"])
  end

  it "sends a re-send by a support team member", parity: true do
    spend_post_ids(1)
    purchase = sell
    as_team_member(:support)

    resend(post_record, purchase)

    expect(response).to have_http_status(:no_content)
    expect(email_infos_of(purchase).count).to eq(1)
  end

  it "replaces the email record of an earlier send", parity: true do
    spend_post_ids(2)
    purchase = sell
    earlier = CreatorContactingCustomersEmailInfo.create!(purchase:, installment: post_record, email_name: "purchase_installment", state: "sent", sent_at: Time.utc(2025, 4, 1))
    log_in(seller)

    resend(post_record, purchase)

    expect(response).to have_http_status(:no_content)
    expect(EmailInfo.exists?(earlier.id)).to eq(false)
    expect(email_infos_of(purchase).count).to eq(1)
  end

  it "keeps the email records of other customers and other posts", parity: true do
    spend_post_ids(3)
    purchase = sell
    other_purchase = sell(email: "other@example.com")
    other_post = create(:published_installment, link: product, seller:, installment_type: "product", name: "Another", published_at: Time.utc(2025, 2, 2, 12))
    kept = [
      CreatorContactingCustomersEmailInfo.create!(purchase: other_purchase, installment: post_record, email_name: "purchase_installment", state: "sent", sent_at: Time.utc(2025, 4, 1)),
      CreatorContactingCustomersEmailInfo.create!(purchase:, installment: other_post, email_name: "purchase_installment", state: "sent", sent_at: Time.utc(2025, 4, 1))
    ]
    log_in(seller)

    resend(post_record, purchase)

    expect(response).to have_http_status(:no_content)
    expect(EmailInfo.where(id: kept.map(&:id)).count).to eq(2)
  end

  it "sends nothing the second time within eight hours", parity: true do
    spend_post_ids(5)
    purchase = sell
    log_in(seller)
    resend(post_record, purchase)
    first = email_infos_of(purchase).sole

    resend(post_record, purchase)

    expect(response).to have_http_status(:no_content)
    expect(email_infos_of(purchase).sole.id).to eq(first.id)
  end

  it "sends to a member of a subscription", parity: true do
    spend_post_ids(6)
    create(:user, email: "member@example.com", name: "Member on Gumroad")
    membership = create(:membership_product, user: seller, name: "Resend membership", unique_permalink: "resendm", created_at: Time.utc(2025, 1, 1))
    subscription = create(:subscription, link: membership, created_at: Time.utc(2025, 3, 1, 12))
    purchase = build(:purchase, link: membership, seller:, email: "member@example.com", is_original_subscription_purchase: true, subscription:, created_at: Time.utc(2025, 3, 1, 12), purchase_state: "successful").tap { _1.save!(validate: false) }
    membership_post = create(:published_installment, link: membership, seller:, installment_type: "product", name: "For members", published_at: Time.utc(2025, 2, 1, 12))
    log_in(seller)

    resend(membership_post, purchase)

    expect(response).to have_http_status(:no_content)
    expect(CreatorContactingCustomersEmailInfo.where(purchase:, installment: membership_post).count).to eq(1)
  end

  it "hands a re-send of a post with files to Rails", parity: true do
    purchase = sell
    create(:product_file, installment: post_record, link: nil, url: "#{AWS_S3_ENDPOINT}/#{S3_BUCKET}/attachment/pencil.png")
    log_in(seller)

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
