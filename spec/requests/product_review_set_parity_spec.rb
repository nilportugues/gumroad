# frozen_string_literal: true

require "spec_helper"

# PUT /product_reviews/set (ProductReviewsController#set): the refusals Node answers before the review is touched, recorded for the
# Next.js port (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/ws12n.replay.test.ts, which sends the last request of each
# example. An example named "hands a ..." records what Node passes to Rails whole: the review is saved.
describe "ProductReviewsController#set", type: :request do
  include Parity::AudienceSignedIn

  let(:seller) { create(:user, name: "Review Seller") }
  let(:product) { create(:product, user: seller, name: "Reviewable", unique_permalink: "reviewable") }
  let(:buyer) { create(:user, name: "Review Buyer") }

  before { host! DOMAIN }

  # The purchase factories charge a card, which a review does not need.
  def sold(purchaser: buyer, on: product, **attributes)
    purchase = build(:purchase, link: on, seller: on.user, purchaser:, email: "reviewer@example.com", purchase_state: "successful", **attributes)
    purchase.save!(validate: false)
    purchase
  end

  def set_review(purchase, link_id: product.unique_permalink, digest: purchase.email_digest, rating: 5, **extra)
    put "/product_reviews/set",
        params: { link_id:, purchase_id: purchase.external_id, purchase_email_digest: digest, rating:, message: "Worth it" }.merge(extra).to_json,
        headers: { "Accept" => "application/json", "Content-Type" => "application/json", "X-CSRF-Token" => csrf_token }
  end

  it "answers that the product was removed for an unknown permalink", parity: true do
    set_review(sold, link_id: "nosuchproduct")

    expect(response.parsed_body).to eq("success" => false, "message" => "Sorry, this product was removed by the seller.")
  end

  it "answers that the product was removed once the seller deleted it", parity: true do
    purchase = sold
    product.update_columns(deleted_at: Time.current)

    set_review(purchase)

    expect(response.parsed_body["message"]).to eq("Sorry, this product was removed by the seller.")
  end

  it "answers something went wrong for a purchase of another product", parity: true do
    other = sold(on: create(:product, user: seller, name: "Other product"))

    set_review(other)

    expect(response.parsed_body).to eq("success" => false, "message" => "Sorry, something went wrong.")
  end

  it "refuses a wrong email digest", parity: true do
    set_review(sold, digest: "not-the-digest")

    expect(response.parsed_body).to eq("success" => false, "message" => "Sorry, you are not authorized to review this product.")
  end

  it "refuses a missing email digest", parity: true do
    set_review(sold, digest: nil)

    expect(response.parsed_body["message"]).to eq("Sorry, you are not authorized to review this product.")
  end

  it "refuses a suspended purchaser", parity: true do
    buyer.update_columns(user_risk_state: "suspended_for_tos_violation")

    set_review(sold)

    expect(response.parsed_body["message"]).to eq("Sorry, you are not authorized to review this product.")
  end

  it "refuses a purchase older than a year when the seller closed reviews after one", parity: true do
    seller.update!(disable_reviews_after_year: true)
    purchase = sold(created_at: 2.years.ago)

    set_review(purchase)

    expect(response.parsed_body).to eq("success" => false, "message" => "Sorry, something went wrong.")
  end

  it "hands a review from an eligible purchase to Rails", parity: true do
    set_review(sold)

    expect(response.parsed_body["success"]).to eq(true)
  end

  it "hands a review of a purchase older than a year to Rails when the seller left reviews open", parity: true do
    set_review(sold(created_at: 2.years.ago))

    expect(response.parsed_body["success"]).to eq(true)
  end

  it "hands a review of a guest purchase to Rails", parity: true do
    set_review(sold(purchaser: nil))

    expect(response.parsed_body["success"]).to eq(true)
  end
end
