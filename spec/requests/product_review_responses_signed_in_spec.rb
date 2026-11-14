# frozen_string_literal: true

require "spec_helper"

# The seller's reply to a review (ProductReviewResponsesController#update and #destroy), sent the way the customers page does.
# Recorded for the Next.js port (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/ws12b.replay.test.ts.
describe "Review responses when signed in", type: :request do
  include Parity::AudienceSignedIn

  let(:seller) { create(:user, name: "Reviewed Seller") }
  let(:product) { create(:product, user: seller, name: "Reviewed product") }
  let(:purchase) do
    build(:purchase, link: product, seller:, purchase_state: "successful").tap { _1.save!(validate: false) }
  end
  let!(:review) { create(:product_review, purchase:, link: product, rating: 4, message: "Great") }
  let(:json_headers) { { "Accept" => "application/json, text/html", "Content-Type" => "application/json" } }

  before { host! DOMAIN }

  def send_json(method, path, body = nil)
    token = csrf_token
    public_send(method, path, params: body&.to_json, headers: json_headers.merge("X-CSRF-Token" => token))
  end

  def as_team_member(role)
    member = create(:user, name: "#{role.to_s.capitalize} Member")
    membership = create(:team_membership, user: member, seller:, role:)
    log_in(member)
    switch_to(membership)
    member
  end

  describe "updating a response" do
    let!(:existing) { create(:product_review_response, product_review: review, user: seller, message: "Thank you") }

    it "saves the new message", parity: true do
      log_in(seller)

      send_json(:put, product_review_response_path(purchase.external_id), message: "Thanks, glad you liked it")

      expect(response).to have_http_status(:no_content)
      expect(existing.reload.message).to eq("Thanks, glad you liked it")
    end

    it "records the support member who edited it", parity: true do
      member = as_team_member(TeamMembership::ROLE_SUPPORT)

      send_json(:patch, product_review_response_path(purchase.external_id), message: "Edited by support")

      expect(response).to have_http_status(:no_content)
      expect(existing.reload.user).to eq(member)
    end

    it "answers with the error when the message is blank", parity: true do
      log_in(seller)

      send_json(:put, product_review_response_path(purchase.external_id), message: "")

      expect(response).to have_http_status(:unprocessable_entity)
      expect(response.parsed_body).to eq("error" => "Message can't be blank")
      expect(existing.reload.message).to eq("Thank you")
    end

    it "does not let a marketing team member edit it", parity: true do
      as_team_member(TeamMembership::ROLE_MARKETING)

      send_json(:put, product_review_response_path(purchase.external_id), message: "Nope")

      expect(response).to have_http_status(:unauthorized)
      expect(existing.reload.message).to eq("Thank you")
    end

    it "answers 404 with JSON when the purchase has no review", parity: true do
      other = build(:purchase, link: product, seller:, purchase_state: "successful").tap { _1.save!(validate: false) }
      log_in(seller)

      send_json(:put, product_review_response_path(other.external_id), message: "Hello")

      expect(response).to have_http_status(:not_found)
    end

    it "answers 404 for an unknown purchase", parity: true do
      log_in(seller)

      send_json(:put, product_review_response_path("nope"), message: "Hello")

      expect(response).to have_http_status(:not_found)
    end

    it "does not let a seller reply to the review of another seller", parity: true do
      other_seller = create(:user)
      other_purchase = build(:purchase, link: create(:product, user: other_seller), seller: other_seller, purchase_state: "successful").tap { _1.save!(validate: false) }
      create(:product_review, purchase: other_purchase, link: other_purchase.link)
      log_in(seller)

      send_json(:put, product_review_response_path(other_purchase.external_id), message: "Hello")

      expect(response).to have_http_status(:unauthorized)
    end
  end

  describe "replying for the first time" do
    it "creates the response and queues the email to the reviewer", parity: true, parity_mail_jobs: true do
      log_in(seller)

      send_json(:put, product_review_response_path(purchase.external_id), message: "First reply")

      expect(response).to have_http_status(:no_content)
      expect(review.reload.response.message).to eq("First reply")
    end

    it "answers with the error when the message is blank", parity: true do
      log_in(seller)

      send_json(:put, product_review_response_path(purchase.external_id), message: " ")

      expect(response).to have_http_status(:unprocessable_entity)
      expect(review.reload.response).to be_nil
    end
  end

  describe "deleting a response" do
    let!(:existing) { create(:product_review_response, product_review: review, user: seller, message: "Thank you") }

    it "removes it", parity: true do
      log_in(seller)

      send_json(:delete, product_review_response_path(purchase.external_id))

      expect(response).to have_http_status(:no_content)
      expect(ProductReviewResponse.count).to eq(0)
    end

    it "does not let an accountant remove it", parity: true do
      as_team_member(TeamMembership::ROLE_ACCOUNTANT)

      send_json(:delete, product_review_response_path(purchase.external_id))

      expect(response).to have_http_status(:unauthorized)
      expect(ProductReviewResponse.count).to eq(1)
    end

    it "answers with no content when there is nothing to remove", parity: true do
      existing.destroy!
      log_in(seller)

      send_json(:delete, product_review_response_path(purchase.external_id))

      expect(response).to have_http_status(:no_content)
    end
  end
end
