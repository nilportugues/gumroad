# frozen_string_literal: true

require "spec_helper"

# The delivery actions of UrlRedirectsController that sit behind the access gate and render a player: the caption track
# (subtitle_file_vtt), the stream page, the read page and the build player. Recorded for the Next.js port (PARITY_RECORD=1)
# and replayed by nextjs/parity/__tests__/url-redirects.replay.test.ts, which sends the last request of each example.
describe "Url redirect players", type: :request do
  include Parity::AudienceSignedIn

  let(:seller) { create(:user, name: "Player Seller") }
  let(:buyer) { create(:user, name: "Player Buyer") }
  let(:product) { create(:product, user: seller, name: "Player product", unique_permalink: "player").tap { |record| record.product_files.delete_all } }
  # A charged purchase would call Stripe.
  let!(:purchase) { create(:free_purchase, link: product, purchaser: buyer, email: "buyer@example.com", ip_address: "203.0.113.9") }
  let(:url_redirect) { create(:url_redirect, link: product, purchase:, uses: 0, expires_at: nil) }
  let(:token) { url_redirect.token }
  let(:forwarded) { { "X-Forwarded-For" => "203.0.113.9" } }
  let(:video_key) { "attachments/0123456789abcdef0123456789abcdef/original/movie.mov" }
  let(:video) { create(:streamable_video, link: product, display_name: "Lesson", url: "#{S3_BASE_URL}#{video_key}") }

  # Objects the files of the examples point at. The replay puts the same bytes in its own storage.
  PLAYER_OBJECTS = {
    "attachments/0123456789abcdef0123456789abcdef/original/movie.mov" => "player spec video",
    "attachments/fedcba9876543210fedcba9876543210/original/second.mov" => "player spec second video",
    "specs/player-captions.srt" => "﻿1\r\n0:00:01,5 --> 0:00:02,000\r\nHello\r\n\r\n2\r\nnot a timing line\r\nlost\r\n\r\n3\r\n00:00:03,000 --> 00:00:04,000\r\nSecond line\r\nover two lines\r\n\r\n4\r\n00:00:05,000 --> 00:00:06,000\r\n   \r\n",
    "specs/player-captions.vtt" => "WEBVTT\n\nNOTE a note\n\nintro\n00:01.000 --> 00:02.000\nPlain cue\n\n00:03.000 --> 00:04.000 align:start\nPositioned cue\n",
    "specs/player-book.pdf" => "%PDF-1.4 player spec",
  }.freeze

  before do
    host! DOMAIN
    bucket = Aws::S3::Resource.new.bucket(S3_BUCKET)
    bucket.create unless bucket.exists?
    PLAYER_OBJECTS.each { |key, body| bucket.object(key).put(body:) }
  end

  describe "GET /r/:id/:product_file_id/:subtitle_file_id/captions.vtt" do
    def subtitle_for(file, key)
      create(:subtitle_file, product_file: file, url: "#{S3_BASE_URL}#{key}", language: "English")
    end

    it "converts a stored SRT to WebVTT with centered cues", parity: true do
      subtitle = subtitle_for(video, "specs/player-captions.srt")

      get url_redirect_subtitle_file_vtt_path(token, video.external_id, subtitle.external_id), headers: forwarded

      expect(response).to have_http_status(:ok)
      expect(response.media_type).to eq("text/vtt")
      expect(response.body).to start_with("WEBVTT\n\n00:00:01.500 --> 00:00:02.000 align:center position:50%")
    end

    it "keeps the notes, identifiers and settings of a stored WebVTT", parity: true do
      subtitle = subtitle_for(video, "specs/player-captions.vtt")

      get url_redirect_subtitle_file_vtt_path(token, video.external_id, subtitle.external_id), headers: forwarded

      expect(response).to have_http_status(:ok)
      expect(response.body).to include("NOTE a note", "intro\n00:01.000 --> 00:02.000 align:center position:50%")
    end

    it "answers 404 when the stored file is gone from storage", parity: true do
      subtitle = subtitle_for(video, "specs/player-missing.srt")

      get url_redirect_subtitle_file_vtt_path(token, video.external_id, subtitle.external_id), headers: forwarded

      expect(response).to have_http_status(:not_found)
    end

    it "answers 404 for a subtitle of another video", parity: true do
      subtitle = subtitle_for(create(:streamable_video, link: product), "specs/player-captions.srt")

      get url_redirect_subtitle_file_vtt_path(token, video.external_id, subtitle.external_id), headers: forwarded

      expect(response).to have_http_status(:not_found)
    end

    it "answers 404 for a file the redirect does not hold", parity: true do
      subtitle = subtitle_for(video, "specs/player-captions.srt")
      other = create(:streamable_video, link: create(:product, user: seller))

      get url_redirect_subtitle_file_vtt_path(token, other.external_id, subtitle.external_id), headers: forwarded

      expect(response).to have_http_status(:not_found)
    end

    it "serves a rented video's captions", parity: true do
      subtitle = subtitle_for(video, "specs/player-captions.srt")
      purchase.is_rental = true
      purchase.update_columns(flags: purchase.flags)
      url_redirect.update!(is_rental: true)

      get url_redirect_subtitle_file_vtt_path(token, video.external_id, subtitle.external_id), headers: forwarded

      expect(response).to have_http_status(:ok)
    end
  end

  describe "GET /s/:id" do
    let(:second_key) { "attachments/fedcba9876543210fedcba9876543210/original/second.mov" }
    let(:second_video) { create(:streamable_video, link: product, display_name: "Lesson two", url: "#{S3_BASE_URL}#{second_key}") }
    let(:pdf) { create(:readable_document, link: product, display_name: "Notes") }

    before { video }

    it "lists the videos and counts the visit", parity: true do
      second_video
      log_in(buyer)

      get url_redirect_stream_page_path(token)

      expect(response).to be_successful
      expect(inertia_props_of(response)).to include("index_to_play" => 0, "playlist" => have_attributes(size: 2))
      expect(url_redirect.reload).to have_attributes(uses: 1, has_been_seen: true)
    end

    it "starts at the requested video and carries the captions and the last position", parity: true do
      second_video
      create(:subtitle_file, product_file: second_video, url: "#{S3_BASE_URL}specs/player-captions.srt", language: "English")
      create(:media_location, product_file_id: second_video.id, url_redirect_id: url_redirect.id, purchase_id: purchase.id, product_id: product.id, location: 42, consumed_at: Time.current)
      log_in(buyer)

      get url_redirect_stream_page_for_product_file_path(token, second_video.external_id)

      expect(response).to be_successful
      expect(inertia_props_of(response)).to include("index_to_play" => 1)
    end

    it "points the player at the HLS playlist of a transcoded video", parity: true do
      create(:transcoded_video, streamable: video, key_base_path: "attachments/0123456789abcdef0123456789abcdef", original_video_key: video_key, is_hls: true)
      log_in(buyer)

      get url_redirect_stream_page_path(token)

      expect(inertia_props_of(response)["playlist"].first["sources"].first).to include("index.m3u8")
    end

    it "streams a guest purchase to the address that bought it", parity: true do
      purchase.update_columns(purchaser_id: nil)

      get url_redirect_stream_page_path(token), headers: forwarded

      expect(response).to be_successful
    end

    it "tells the seller about videos that are not transcoded yet", parity: true do
      purchase.update_columns(purchaser_id: seller.id)
      product.transcode_videos_on_purchase = true
      product.update_columns(flags: product.flags)
      log_in(seller)

      get url_redirect_stream_page_path(token)

      expect(inertia_props_of(response)).to include("should_show_transcoding_notice" => true, "transcode_on_first_sale" => true)
    end

    it "answers 404 for a purchase without videos", parity: true do
      video.update_columns(deleted_at: Time.current)
      pdf
      log_in(buyer)

      get url_redirect_stream_page_path(token)

      expect(response).to have_http_status(:not_found)
    end

    it "answers 404 for a requested file that is not a video", parity: true do
      log_in(buyer)

      get url_redirect_stream_page_for_product_file_path(token, pdf.external_id)

      expect(response).to have_http_status(:not_found)
    end

    it "plays the first video for a file the redirect does not hold", parity: true do
      log_in(buyer)

      get url_redirect_stream_page_for_product_file_path(token, "unknown")

      expect(response).to be_successful
    end

    it "asks a seen redirect's visitor to confirm the email", parity: true do
      url_redirect.mark_as_seen
      purchase.update_columns(purchaser_id: nil)

      get url_redirect_stream_page_path(token), headers: { "X-Forwarded-For" => "198.51.100.4" }

      expect(response).to redirect_to(confirm_page_path(id: token, destination: "stream"))
    end

    it "hands a product with rich content to Rails", parity: true do
      create(:product_rich_content, entity: product)
      log_in(buyer)

      get url_redirect_stream_page_path(token)

      expect(response).to be_successful
    end
  end
end
