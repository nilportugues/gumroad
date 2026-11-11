# frozen_string_literal: true

require "spec_helper"

# ProductReviewVideos::{Streams,StreamingUrls,UploadContexts}Controller, recorded for the Next.js port (PARITY_RECORD=1) and
# replayed by nextjs/parity/__tests__/product-review-videos.replay.test.ts, which sends the last request of each example. An example
# named "hands a ..." records what Node passes to Rails whole.
describe "ProductReviewVideos", type: :request do
  include Parity::AudienceSignedIn

  let(:seller) { create(:named_seller, name: "Video Seller") }
  let(:product) { create(:product, user: seller, name: "Reviewed product") }
  let(:reviewer) { create(:user, name: "Video Reviewer") }
  let(:purchase) do
    build(:purchase, link: product, seller:, purchaser: reviewer, email: "reviewer@example.com", purchase_state: "successful").tap { _1.save!(validate: false) }
  end
  let(:review) { create(:product_review, purchase:, link: product, rating: 5, message: "Great") }
  let(:video) { create(:product_review_video, :approved, product_review: review) }

  before { host! DOMAIN }

  def pending_video
    create(:product_review_video, :pending_review, product_review: review)
  end

  def get_json(path)
    get path, headers: { "Accept" => "application/json" }
  end

  describe "GET /product_review_videos/:id/streaming_urls" do
    it "lists the SMIL stream and the download url of an approved video to a signed-out visitor", parity: true do
      get_json product_review_video_streaming_urls_path(video.external_id)

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body["streaming_urls"].first).to eq("/product_review_videos/#{video.external_id}/stream.smil")
    end

    it "carries the purchase email digest into the SMIL url of a pending video", parity: true do
      record = pending_video

      get_json product_review_video_streaming_urls_path(record.external_id, purchase_email_digest: purchase.email_digest)

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body["streaming_urls"].first).to include("purchase_email_digest=#{CGI.escape(purchase.email_digest)}")
    end

    it "answers 401 for a pending video to a signed-out visitor", parity: true do
      record = pending_video

      get_json product_review_video_streaming_urls_path(record.external_id)

      expect(response).to have_http_status(:unauthorized)
    end

    it "answers 401 for a pending video with a wrong digest", parity: true do
      record = pending_video

      get_json product_review_video_streaming_urls_path(record.external_id, purchase_email_digest: "wrong")

      expect(response).to have_http_status(:unauthorized)
    end

    it "lists the urls of a pending video to the reviewer", parity: true do
      record = pending_video
      log_in(reviewer)

      get_json product_review_video_streaming_urls_path(record.external_id)

      expect(response).to have_http_status(:ok)
    end

    it "lists the urls of a pending video to the seller", parity: true do
      record = pending_video
      log_in(seller)

      get_json product_review_video_streaming_urls_path(record.external_id)

      expect(response).to have_http_status(:ok)
    end

    it "answers 401 for a pending video to another signed-in user", parity: true do
      record = pending_video
      log_in(create(:user, name: "Bystander"))

      get_json product_review_video_streaming_urls_path(record.external_id)

      expect(response).to have_http_status(:unauthorized)
    end

    it "answers 404 for a video that does not exist", parity: true do
      get_json product_review_video_streaming_urls_path("nosuchvideo")

      expect(response).to have_http_status(:not_found)
    end

    it "answers 404 for a removed video", parity: true do
      video.mark_deleted!

      get_json product_review_video_streaming_urls_path(video.external_id)

      expect(response).to have_http_status(:not_found)
    end
  end

  describe "GET /product_review_videos/:id/stream.smil" do
    it "serves the SMIL of an approved video", parity: true do
      get product_review_video_stream_path(video.external_id, format: :smil)

      expect(response).to have_http_status(:ok)
      expect(response.body).to start_with("<smil><body><switch><video src=")
    end

    it "serves the SMIL of a pending video with the purchase email digest", parity: true do
      record = pending_video

      get product_review_video_stream_path(record.external_id, format: :smil, purchase_email_digest: purchase.email_digest)

      expect(response).to have_http_status(:ok)
    end

    it "answers 401 for a pending video to a signed-out visitor", parity: true do
      record = pending_video

      get product_review_video_stream_path(record.external_id, format: :smil)

      expect(response).to have_http_status(:unauthorized)
    end

    it "serves the SMIL of a pending video to the seller", parity: true do
      record = pending_video
      log_in(seller)

      get product_review_video_stream_path(record.external_id, format: :smil)

      expect(response).to have_http_status(:ok)
    end

    it "answers 401 for a pending video to another signed-in user", parity: true do
      record = pending_video
      log_in(create(:user, name: "Bystander"))

      get product_review_video_stream_path(record.external_id, format: :smil)

      expect(response).to have_http_status(:unauthorized)
    end

    it "answers 404 for a video that does not exist", parity: true do
      get product_review_video_stream_path("nosuchvideo", format: :smil)

      expect(response).to have_http_status(:not_found)
    end

    it "hands a request for another format to Rails", parity: true do
      get product_review_video_stream_path(video.external_id, format: :json)

      expect(response.status).to be_in([404, 406])
    end
  end

  describe "GET /product_review_videos/upload_context" do
    it "answers a signed-out visitor with the 404 of authenticate_user!", parity: true do
      get_json product_review_videos_upload_context_path

      expect(response).to have_http_status(:not_found)
    end

    it "answers the S3 upload context of a signed-in user", parity: true do
      log_in(reviewer)

      get_json product_review_videos_upload_context_path

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body["user_id"]).to eq(reviewer.external_id)
    end
  end
end
