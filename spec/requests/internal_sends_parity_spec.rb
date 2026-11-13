# frozen_string_literal: true

require "spec_helper"

# The sends, previews and uploads of Api::Internal that mail, enqueue a blast or attach a blob, recorded for the Next.js port
# (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/internal-api.replay.test.ts, which sends the last request of each example.
# Node answers the sign-in, lookup and policy refusals of each (nextjs/src/server/controllers/internal-api.ts, internal-agent.ts); the
# examples that start "hands a" are the requests it leaves to Rails whole.
describe "Internal API sends and previews", type: :request do
  include Parity::AudienceSignedIn

  JSON_ACCEPT_SENDS = { "Accept" => "application/json" }.freeze

  let(:seller) { create(:user, name: "Sends Seller") }
  let(:published_at) { Time.utc(2025, 1, 1) }
  let(:installment) { create(:installment, seller:, link: nil, installment_type: "seller", name: "Sent post", message: "<p>Body</p>", published_at:, send_emails: true) }

  before { host! DOMAIN }

  def post_json(path, params = {}) = post(path, params: params.to_json, headers: JSON_ACCEPT_SENDS.merge("X-CSRF-Token" => csrf_token, "Content-Type" => "application/json"))

  def get_json(path, params = {}) = get(path, params:, headers: JSON_ACCEPT_SENDS)

  def log_in_as_member(role)
    member = create(:user, name: "#{role.to_s.capitalize} Member")
    membership = create(:team_membership, user: member, seller:, role:)
    log_in(member)
    switch_to(membership)
  end

  describe "GET /internal/installments/:id/non_opener_resend" do
    it "answers 404 JSON to a visitor who is signed out", parity: true do
      get_json("/internal/installments/#{installment.external_id}/non_opener_resend")

      expect(response).to have_http_status(:not_found)
    end

    it "answers 404 JSON for a post of another seller", parity: true do
      other = create(:installment, seller: create(:user), link: nil, installment_type: "seller", published_at:, send_emails: true)
      log_in(seller)

      get_json("/internal/installments/#{other.external_id}/non_opener_resend")

      expect(response).to have_http_status(:not_found)
    end

    it "answers 404 JSON for a draft", parity: true do
      draft = create(:installment, seller:, link: nil, installment_type: "seller", send_emails: true)
      log_in(seller)

      get_json("/internal/installments/#{draft.external_id}/non_opener_resend")

      expect(response).to have_http_status(:not_found)
    end

    it "answers 401 JSON to a support team member", parity: true do
      log_in_as_member(TeamMembership::ROLE_SUPPORT)

      get_json("/internal/installments/#{installment.external_id}/non_opener_resend")

      expect(response).to have_http_status(:unauthorized)
    end

    it "hands a post that can be resent to Rails", parity: true do
      log_in(seller)

      get_json("/internal/installments/#{installment.external_id}/non_opener_resend")

      expect(response.parsed_body).to include("count" => 0, "recently_resent" => false)
    end
  end

  describe "POST /internal/installments/:id/preview_email" do
    it "answers 404 JSON to a visitor who is signed out", parity: true do
      post_json("/internal/installments/#{installment.external_id}/preview_email")

      expect(response).to have_http_status(:not_found)
    end

    it "answers 404 JSON for a post that does not exist", parity: true do
      log_in(seller)

      post_json("/internal/installments/not-an-id/preview_email")

      expect(response).to have_http_status(:not_found)
    end

    it "answers 404 JSON for a post of another seller", parity: true do
      other = create(:installment, seller: create(:user), link: nil, installment_type: "seller", published_at:, send_emails: true)
      log_in(seller)

      post_json("/internal/installments/#{other.external_id}/preview_email")

      expect(response).to have_http_status(:not_found)
    end

    it "answers 404 JSON for a deleted post", parity: true do
      installment.update_columns(deleted_at: Time.utc(2025, 2, 1))
      log_in(seller)

      post_json("/internal/installments/#{installment.external_id}/preview_email")

      expect(response).to have_http_status(:not_found)
    end

    it "hands a preview to Rails", parity: true do
      log_in(seller)

      post_json("/internal/installments/#{installment.external_id}/preview_email")

      expect(response).to have_http_status(:ok)
    end
  end

  describe "POST /internal/installments/:id/remaining_send" do
    it "answers 404 JSON to a visitor who is signed out", parity: true do
      post_json("/internal/installments/#{installment.external_id}/remaining_send")

      expect(response).to have_http_status(:not_found)
    end

    it "answers 404 JSON for a draft", parity: true do
      draft = create(:installment, seller:, link: nil, installment_type: "seller", send_emails: true)
      log_in(seller)

      post_json("/internal/installments/#{draft.external_id}/remaining_send")

      expect(response).to have_http_status(:not_found)
    end

    it "answers 404 JSON for a post of another seller", parity: true do
      other = create(:installment, seller: create(:user), link: nil, installment_type: "seller", published_at:, send_emails: true)
      log_in(seller)

      post_json("/internal/installments/#{other.external_id}/remaining_send")

      expect(response).to have_http_status(:not_found)
    end

    it "answers 401 JSON to a support team member", parity: true do
      log_in_as_member(TeamMembership::ROLE_SUPPORT)

      post_json("/internal/installments/#{installment.external_id}/remaining_send")

      expect(response).to have_http_status(:unauthorized)
    end

    it "answers 422 for a post that was never sent", parity: true do
      log_in(seller)

      post_json("/internal/installments/#{installment.external_id}/remaining_send")

      expect(response).to have_http_status(:unprocessable_entity)
      expect(response.parsed_body).to eq("success" => false, "error" => "This email is not waiting on any recipients.")
    end

    it "answers 422 for a post whose only blast is a resend to non-openers", parity: true do
      create(:post_email_blast, post: installment, seller:, recipient_filter: "unopened", requested_at: 3.days.ago, completed_at: 2.days.ago, delivery_count: 5)
      log_in(seller)

      post_json("/internal/installments/#{installment.external_id}/remaining_send")

      expect(response).to have_http_status(:unprocessable_entity)
    end
  end

  describe "POST /internal/customers/:purchase_id/single_customer_email" do
    let(:customer) { build(:purchase, link: create(:product, user: seller), seller:, email: "customer@example.com", purchase_state: "successful").tap { |row| row.save!(validate: false) } }

    it "answers 404 JSON to a visitor who is signed out", parity: true do
      post_json("/internal/customers/#{customer.external_id}/single_customer_email", name: "Hello", message: "<p>Hi</p>")

      expect(response).to have_http_status(:not_found)
    end

    it "answers 404 with a message for a customer that does not exist", parity: true do
      log_in(seller)

      post_json("/internal/customers/not-an-id/single_customer_email", name: "Hello", message: "<p>Hi</p>")

      expect(response).to have_http_status(:not_found)
      expect(response.parsed_body).to eq("success" => false, "message" => "Customer not found.")
    end

    it "answers 404 with a message for a customer of another seller", parity: true do
      other = build(:purchase, link: create(:product, user: create(:user)), email: "customer@example.com", purchase_state: "successful").tap { |row| row.save!(validate: false) }
      log_in(seller)

      post_json("/internal/customers/#{other.external_id}/single_customer_email", name: "Hello", message: "<p>Hi</p>")

      expect(response).to have_http_status(:not_found)
      expect(response.parsed_body["message"]).to eq("Customer not found.")
    end

    it "answers 401 JSON to a support team member", parity: true do
      log_in_as_member(TeamMembership::ROLE_SUPPORT)

      post_json("/internal/customers/#{customer.external_id}/single_customer_email", name: "Hello", message: "<p>Hi</p>")

      expect(response).to have_http_status(:unauthorized)
    end

    it "answers 401 JSON to a support team member asking for a customer that does not exist", parity: true do
      log_in_as_member(TeamMembership::ROLE_SUPPORT)

      post_json("/internal/customers/not-an-id/single_customer_email", name: "Hello", message: "<p>Hi</p>")

      expect(response).to have_http_status(:unauthorized)
    end

    it "hands a customer email without a title to Rails", parity: true do
      log_in(seller)

      post_json("/internal/customers/#{customer.external_id}/single_customer_email", name: "", message: "<p>Hi</p>")

      expect(response.parsed_body).to include("success" => false)
    end
  end

  describe "GET /internal/products/:product_id/receipt_preview" do
    let(:product) { create(:product, user: seller, name: "Alpha", unique_permalink: "alpha") }

    it "answers 404 JSON to a visitor who is signed out", parity: true do
      get_json("/internal/products/#{product.unique_permalink}/receipt_preview")

      expect(response).to have_http_status(:not_found)
    end

    it "answers 404 for a product that does not exist", parity: true do
      log_in(seller)

      get_json("/internal/products/nothing/receipt_preview")

      expect(response).to have_http_status(:not_found)
    end

    it "answers 404 for a product of another seller", parity: true do
      other = create(:product, user: create(:user))
      log_in(seller)

      get_json("/internal/products/#{other.unique_permalink}/receipt_preview")

      expect(response).to have_http_status(:not_found)
    end

    it "hands a receipt preview of a product to Rails", parity: true do
      log_in(seller)

      get_json("/internal/products/#{product.unique_permalink}/receipt_preview")

      expect(response.parsed_body).to include("subject", "html")
    end
  end

  describe "POST /internal/product_public_files" do
    let(:product) { create(:product, user: seller) }

    it "answers 404 JSON to a visitor who is signed out", parity: true do
      post_json("/internal/product_public_files", product_id: product.external_id, signed_blob_id: "x")

      expect(response).to have_http_status(:not_found)
    end

    it "answers 404 for a product that does not exist", parity: true do
      log_in(seller)

      post_json("/internal/product_public_files", product_id: "not-an-id", signed_blob_id: "x")

      expect(response).to have_http_status(:not_found)
    end

    it "answers 404 for a product of another seller", parity: true do
      other = create(:product, user: create(:user))
      log_in(seller)

      post_json("/internal/product_public_files", product_id: other.external_id, signed_blob_id: "x")

      expect(response).to have_http_status(:not_found)
    end

    it "answers 401 JSON to a support team member", parity: true do
      log_in_as_member(TeamMembership::ROLE_SUPPORT)

      post_json("/internal/product_public_files", product_id: product.external_id, signed_blob_id: "x")

      expect(response).to have_http_status(:unauthorized)
    end

    it "answers 400 without a signed blob id", parity: true do
      log_in(seller)

      post_json("/internal/product_public_files", product_id: product.external_id)

      expect(response).to have_http_status(:bad_request)
      expect(response.parsed_body).to eq("success" => false, "error" => "Invalid signed_blob_id.")
    end

    it "hands a signed blob id to Rails", parity: true do
      log_in(seller)

      post_json("/internal/product_public_files", product_id: product.external_id, signed_blob_id: "tampered")

      expect(response).to have_http_status(:bad_request)
    end
  end

  describe "POST /internal/agent/{messages,messages/stream,actions}" do
    it "answers 404 JSON to a visitor who is signed out", parity: true do
      post_json("/internal/agent/messages")

      expect(response).to have_http_status(:not_found)
    end

    it "answers 401 JSON to a seller who has not earned the agent", parity: true do
      log_in(seller)

      post_json("/internal/agent/messages")

      expect(response).to have_http_status(:unauthorized)
    end

    it "answers 401 JSON to a seller who has not earned the agent when streaming", parity: true do
      log_in(seller)

      post_json("/internal/agent/messages/stream")

      expect(response).to have_http_status(:unauthorized)
    end

    it "answers 401 JSON to a seller who has not earned the agent when confirming", parity: true do
      log_in(seller)

      post_json("/internal/agent/actions")

      expect(response).to have_http_status(:unauthorized)
    end
  end
end
