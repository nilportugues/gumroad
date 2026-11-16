# frozen_string_literal: true

require "spec_helper"

# PUT /product_reviews/set (ProductReviewsController#set): the refusals and the saving of a review without video, recorded for the
# Next.js port (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/ws12n.replay.test.ts, which sends the last request of each
# example. An example named "hands a ..." records what Node passes to Rails whole.
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

  describe "saving a review", :parity_mail_jobs do
    # Aged, so that a change in the request moves `updated_at` instead of landing in the second the row was created.
    def review_of(purchase, rating: 3, message: "Fine", **attributes)
      review = ProductReview.create!(purchase:, link: product, rating:, message:, **attributes)
      aged = 10.minutes.ago
      review.update_columns(created_at: aged, updated_at: aged)
      ProductReviewStat.update_all(created_at: aged, updated_at: aged)
      review
    end

    it "saves the review of an eligible purchase, creates the product's review stat and tells the seller", parity: true do
      set_review(sold)

      expect(response.parsed_body).to include("success" => true, "review" => include("rating" => 5, "message" => "Worth it"))
    end

    it "waits before telling the seller about a review without a message", parity: true do
      set_review(sold, message: nil)

      expect(response.parsed_body["success"]).to eq(true)
    end

    it "keeps quiet when the seller turned review emails off", parity: true do
      seller.update!(disable_reviews_email: true)

      set_review(sold)

      expect(response.parsed_body["success"]).to eq(true)
    end

    it "adds the rating to the stat the product already has", parity: true do
      review_of(sold(purchaser: nil, email: "first@example.com"), rating: 4)

      set_review(sold)

      expect(response.parsed_body["success"]).to eq(true)
    end

    it "keeps the product's average rating to one decimal", parity: true do
      review_of(sold(purchaser: nil, email: "first@example.com"), rating: 4)
      review_of(sold(purchaser: nil, email: "second@example.com"), rating: 4)

      set_review(sold)

      expect(response.parsed_body["success"]).to eq(true)
    end

    it "stays silent when the message arrives after the seller was already told", parity: true do
      purchase = sold
      review_of(purchase, rating: 5, message: nil, seller_notified_at: 1.hour.ago)

      set_review(purchase, rating: 5, message: "Late thoughts")

      expect(response.parsed_body["review"]).to include("message" => "Late thoughts")
    end

    it "saves the review of a guest purchase", parity: true do
      set_review(sold(purchaser: nil))

      expect(response.parsed_body["success"]).to eq(true)
    end

    it "saves the review of a purchase older than a year when the seller left reviews open", parity: true do
      set_review(sold(created_at: 2.years.ago))

      expect(response.parsed_body["success"]).to eq(true)
    end

    it "accepts the rating as text and the identity choice as text", parity: true do
      set_review(sold, rating: "4", anonymous: "true")

      expect(response.parsed_body["review"]).to include("rating" => 4, "anonymous" => true)
    end

    it "moves the rating of an existing review in the stat and keeps the message", parity: true do
      purchase = sold
      review_of(purchase, rating: 2)

      set_review(purchase, rating: 5, message: "Fine")

      expect(response.parsed_body["review"]).to include("rating" => 5)
    end

    it "tells the seller when the message arrives after the rating", parity: true do
      purchase = sold
      review_of(purchase, rating: 5, message: nil)

      set_review(purchase, rating: 5, message: "Here is why")

      expect(response.parsed_body["review"]).to include("message" => "Here is why")
    end

    it "stays silent when the message of an existing review is edited", parity: true do
      purchase = sold
      review_of(purchase, rating: 5, message: "Before")

      set_review(purchase, rating: 5, message: "After")

      expect(response.parsed_body["review"]).to include("message" => "After")
    end

    it "keeps an existing identity choice when the request leaves it out", parity: true do
      purchase = sold
      review_of(purchase, rating: 5, message: "Worth it", anonymous: true)

      set_review(purchase)

      expect(response.parsed_body["review"]).to include("anonymous" => true)
    end

    it "lets the buyer of a refunded purchase show the review as Anonymous", parity: true do
      purchase = sold
      review_of(purchase, rating: 5, message: "Worth it")
      purchase.update_columns(stripe_refunded: true)

      set_review(purchase, anonymous: true)

      expect(response.parsed_body).to include("success" => true)
    end

    it "refuses to change a review once its purchase was refunded", parity: true do
      purchase = sold
      review_of(purchase, rating: 5, message: "Worth it")
      purchase.update_columns(stripe_refunded: true)

      set_review(purchase, rating: 1)

      expect(response.parsed_body["message"]).to eq("You can no longer change this review, but you can still show it as Anonymous.")
    end

    it "refuses a first review on a refunded purchase", parity: true do
      purchase = sold
      purchase.update_columns(stripe_refunded: true)

      set_review(purchase)

      expect(response.parsed_body["message"]).to eq("This purchase is no longer eligible for a review.")
    end

    it "answers the validation message for a rating outside one to five", parity: true do
      set_review(sold, rating: 9)

      expect(response.parsed_body["success"]).to eq(false)
    end

    it "refuses a message with adult keywords", parity: true do
      set_review(sold, message: "so NSFW stuff")

      expect(response.parsed_body["success"]).to eq(false)
    end
  end

  it "hands a review with video options to Rails", parity: true do
    set_review(sold, video_options: { destroy: { id: "unknown" } })

    expect(response.parsed_body["success"]).to eq(true)
  end

  it "hands a review that already carries a video to Rails", parity: true do
    purchase = sold
    review = ProductReview.create!(purchase:, link: product, rating: 4, message: "Fine")
    create(:product_review_video, :approved, product_review: review)

    set_review(purchase)

    expect(response.parsed_body["success"]).to eq(true)
  end
end
