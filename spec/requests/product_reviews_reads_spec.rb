# frozen_string_literal: true

require "spec_helper"

# GET /product_reviews and GET /product_reviews/:id, recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/ws12d.replay.test.ts. The clock is frozen at the instant that replay runs at.
describe "Product reviews", type: :request do
  include Parity::AudienceSignedIn

  let(:frozen_at) { Time.utc(2026, 3, 7, 20, 0, 0) }
  let(:seller) { create(:user, name: "Review Seller") }
  let(:product) { create(:product, user: seller, name: "Reviewed", unique_permalink: "reviewed", display_product_reviews: true) }

  before do
    travel_to(frozen_at)
    host! DOMAIN
  end

  after { travel_back }

  # The purchase factories charge a card, which a review does not need.
  def sold(buyer: nil, on: product, **attributes)
    purchase = build(:purchase, link: on, seller: on.user, purchaser: buyer, purchase_state: "successful", **attributes)
    purchase.save!(validate: false)
    purchase
  end

  def review(rating:, message: "Worth it", buyer: nil, on: product, created_at: frozen_at - 2.days, **attributes)
    create(:product_review, purchase: sold(buyer:, on:), link: on, rating:, message:, created_at:, **attributes)
  end

  def fetch_reviews(params = { product_id: product.external_id })
    get "/product_reviews", params:, headers: { "Accept" => "application/json" }
  end

  def fetch_review(review)
    get "/product_reviews/#{review.external_id}", headers: { "Accept" => "application/json" }
  end

  describe "index" do
    it "lists the reviews by rating, then newest first, with the buyer's name when they have an account", parity: true do
      rita = create(:user, name: "Rita Reviewer")
      review(rating: 4, message: "Good", buyer: rita, created_at: frozen_at - 3.days)
      review(rating: 5, message: "Older five", created_at: frozen_at - 9.days)
      review(rating: 5, message: "Newer five", created_at: frozen_at - 1.day)

      fetch_reviews

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body["pagination"]).to eq("pages" => 1, "page" => 1)
      expect(response.parsed_body["reviews"].map { _1["message"] }).to eq(["Newer five", "Older five", "Good"])
      expect(response.parsed_body["reviews"].map { _1["rater"]["name"] }).to eq(["Anonymous", "Anonymous", "Rita Reviewer"])
    end

    it "shows Anonymous for a buyer who chose it and lists a review with a seller response", parity: true do
      rita = create(:user, name: "Rita Reviewer")
      hidden = review(rating: 3, message: "Keep my name off", buyer: rita, anonymous: true)
      replied = review(rating: 2, message: "Not for me", buyer: create(:user, name: "Sam Skeptic"))
      create(:product_review_response, product_review: replied, user: seller, message: "Sorry to hear that")

      fetch_reviews

      reviews = response.parsed_body["reviews"]
      expect(reviews.map { _1["rater"]["name"] }).to eq(["Anonymous", "Sam Skeptic"])
      expect(reviews.first["id"]).to eq(hidden.external_id)
      expect(reviews.last["response"]).to eq("message" => "Sorry to hear that")
    end

    it "marks a review as new for a month and leaves out the ones without a message or removed", parity: true do
      review(rating: 5, message: "Just inside", created_at: frozen_at - 1.month + 1.hour)
      review(rating: 4, message: "Just outside", created_at: frozen_at - 1.month - 1.hour)
      review(rating: 3, message: nil)
      review(rating: 3, message: "Removed", deleted_at: frozen_at - 1.day)

      fetch_reviews

      expect(response.parsed_body["reviews"].map { [_1["message"], _1["is_new"]] }).to eq([["Just inside", true], ["Just outside", false]])
    end

    describe "pages" do
      before { 12.times { |index| review(rating: 5 - (index % 3), message: "Review #{index}", created_at: frozen_at - (index + 1).hours) } }

      it "lists ten reviews to a page", parity: true do
        fetch_reviews(product_id: product.external_id)

        expect(response.parsed_body["pagination"]).to eq("pages" => 2, "page" => 1)
        expect(response.parsed_body["reviews"].size).to eq(10)
      end

      it "lists the rest on the second page", parity: true do
        fetch_reviews(product_id: product.external_id, page: "2")

        expect(response.parsed_body["pagination"]).to eq("pages" => 2, "page" => 2)
        expect(response.parsed_body["reviews"].size).to eq(2)
      end

      it "answers an empty page past the last", parity: true do
        fetch_reviews(product_id: product.external_id, page: "9")

        expect(response.parsed_body).to eq("pagination" => { "pages" => 2, "page" => 9 }, "reviews" => [])
      end

      it "reads a page that is not a positive number as the first", parity: true do
        fetch_reviews(product_id: product.external_id, page: "-4")

        expect(response.parsed_body["pagination"]).to eq("pages" => 2, "page" => 1)
      end

      it "reads the digits a page starts with", parity: true do
        fetch_reviews(product_id: product.external_id, page: "2abc")

        expect(response.parsed_body["pagination"]).to eq("pages" => 2, "page" => 2)
      end
    end

    it "answers one empty page for a product without reviews", parity: true do
      fetch_reviews

      expect(response.parsed_body).to eq("pagination" => { "pages" => 1, "page" => 1 }, "reviews" => [])
    end

    it "gives the purchase id to the seller", parity: true do
      mine = review(rating: 5, message: "For the seller", buyer: create(:user, name: "Rita Reviewer"))
      log_in(seller)

      fetch_reviews

      expect(response.parsed_body["reviews"].first["purchase_id"]).to eq(mine.purchase.external_id)
    end

    it "gives the purchase id to the buyer of that review only", parity: true do
      rita = create(:user, name: "Rita Reviewer")
      review(rating: 5, message: "Rita's", buyer: rita)
      review(rating: 4, message: "Someone else's", buyer: create(:user, name: "Sam Skeptic"))
      log_in(rita)

      fetch_reviews

      expect(response.parsed_body["reviews"].map { _1["purchase_id"].present? }).to eq([true, false])
    end

    it "leaves the purchase id out for a signed-out visitor", parity: true do
      review(rating: 5, message: "Public")

      fetch_reviews

      expect(response.parsed_body["reviews"].first["purchase_id"]).to be_nil
    end

    it "answers 403 when the seller hides the reviews", parity: true do
      product.update!(display_product_reviews: false)
      review(rating: 5)

      fetch_reviews

      expect(response).to have_http_status(:forbidden)
    end

    it "lists hidden reviews to the seller", parity: true do
      product.update!(display_product_reviews: false)
      review(rating: 5, message: "Hidden but mine")
      log_in(seller)

      fetch_reviews

      expect(response.parsed_body["reviews"].map { _1["message"] }).to eq(["Hidden but mine"])
    end

    it "answers 404 for an unknown product", parity: true do
      fetch_reviews(product_id: "nope")

      expect(response).to have_http_status(:not_found)
    end

    it "answers 404 without a product id", parity: true do
      fetch_reviews({})

      expect(response).to have_http_status(:not_found)
    end

    it "hands a review with an approved video to Rails", parity: true do
      with_video = review(rating: 5, message: "Watch this")
      create(:product_review_video, product_review: with_video, approval_status: :approved)

      fetch_reviews

      expect(response).to have_http_status(:ok)
    end
  end

  describe "show" do
    it "answers one review", parity: true do
      mine = review(rating: 4, message: "Solid", buyer: create(:user, name: "Rita Reviewer"))

      fetch_review(mine)

      expect(response.parsed_body).to eq(
        "review" => {
          "id" => mine.external_id,
          "rating" => 4,
          "message" => "Solid",
          "rater" => { "avatar_url" => response.parsed_body.dig("review", "rater", "avatar_url"), "name" => "Rita Reviewer" },
          "purchase_id" => nil,
          "created_at" => (frozen_at - 2.days).iso8601,
          "is_new" => true,
          "response" => nil,
          "video" => nil,
        }
      )
    end

    it "gives the seller the purchase id and a reply", parity: true do
      mine = review(rating: 4, message: "Solid")
      create(:product_review_response, product_review: mine, user: seller, message: "Thanks")
      log_in(seller)

      fetch_review(mine)

      expect(response.parsed_body["review"]).to include("purchase_id" => mine.purchase.external_id, "response" => { "message" => "Thanks" })
    end

    it "answers 404 for a review without a message", parity: true do
      silent = review(rating: 4, message: nil)

      fetch_review(silent)

      expect(response).to have_http_status(:not_found)
    end

    it "answers 404 for a removed review", parity: true do
      removed = review(rating: 4, message: "Gone", deleted_at: frozen_at)

      fetch_review(removed)

      expect(response).to have_http_status(:not_found)
    end

    it "answers 404 for a review that does not exist", parity: true do
      get "/product_reviews/unknown", headers: { "Accept" => "application/json" }

      expect(response).to have_http_status(:not_found)
    end
  end
end
