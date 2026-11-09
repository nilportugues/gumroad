# frozen_string_literal: true

require "spec_helper"

# The file delivery side of UrlRedirectsController (access checks, /r, /zip, /media_urls, the JSON and form posts) and
# ConsumptionAnalyticsController, recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/url-redirects.replay.test.ts, which sends the last request of each example.
describe "Url redirect delivery", type: :request do
  include Parity::AudienceSignedIn

  let(:seller) { create(:user, name: "Delivery Seller") }
  let(:buyer) { create(:user, name: "Delivery Buyer") }
  let(:product) { create(:product, user: seller, name: "Delivery product", unique_permalink: "delivery") }
  let(:pdf) { create(:readable_document, link: product, pagelength: 3, size: 50, display_name: "Chapter one", description: "First chapter") }
  # A charged purchase would call Stripe.
  let!(:purchase) { create(:free_purchase, link: product, purchaser: buyer, email: "buyer@example.com", ip_address: "203.0.113.9") }
  let(:url_redirect) { create(:url_redirect, link: product, purchase:, uses: 0, expires_at: nil) }
  let(:token) { url_redirect.token }
  let(:json_headers) do
    { "Accept" => "application/json", "X-Requested-With" => "XMLHttpRequest", "Content-Type" => "application/json", "Referer" => "http://#{DOMAIN}/library" }
  end

  # Objects the files of the examples point at. The replay puts the same bytes in its own storage.
  SPEC_OBJECTS = {
    "specs/billion-dollar-company-chapter-0.pdf" => "%PDF-1.4 delivery spec",
    "specs/ScreenRecording.mov" => "delivery spec video",
    "specs/magic.mp3" => "delivery spec audio",
    "specs/captions.srt" => "1\n00:00:01,000 --> 00:00:02,000\nHello\n",
    "attachments/0123456789abcdef0123456789abcdef/movie/hls/index.m3u8" => "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000,RESOLUTION=640x360\nindex_360.m3u8\n#EXT-X-ENDLIST\n",
  }.freeze

  before do
    host! DOMAIN
    bucket = Aws::S3::Resource.new.bucket(S3_BUCKET)
    bucket.create unless bucket.exists?
    SPEC_OBJECTS.each { |key, body| bucket.object(key).put(body:) }
  end

  # Flags written straight to the row: validating the purchase would charge its card.
  def set_purchase_flags(record, **flags)
    flags.each { |name, value| record.public_send(:"#{name}=", value) }
    record.update_columns(flags: record.flags)
  end

  def post_json(path, body = {})
    post path, params: body.to_json, headers: json_headers.merge("X-CSRF-Token" => csrf_token)
  end

  describe "access checks (GET /r/:id)" do
    before { pdf }

    it "sends the file of a visitor whose address bought it", parity: true do
      get url_redirect_path(token), headers: { "X-Forwarded-For" => "203.0.113.9" }

      expect(response).to have_http_status(:found)
      expect(response.location).to include("X-Amz-Signature=")
      expect(url_redirect.reload).to have_attributes(uses: 1, has_been_seen: true)
      expect(ConsumptionEvent.last).to have_attributes(event_type: "download", platform: "web")
      expect(set_cookies).to include("confirmed_redirect=")
    end

    it "answers 404 for an unknown token", parity: true do
      get url_redirect_path("nope")

      expect(response).to have_http_status(:not_found)
    end

    it "answers 404 for a refunded purchase", parity: true do
      purchase.update_columns(stripe_refunded: true)

      get url_redirect_path(token)

      expect(response).to have_http_status(:not_found)
    end

    it "answers 404 for a charged back purchase", parity: true do
      purchase.update_columns(chargeback_date: 1.day.ago)

      get url_redirect_path(token)

      expect(response).to have_http_status(:not_found)
    end

    it "serves a purchase whose chargeback was reversed", parity: true do
      purchase.update_columns(chargeback_date: 1.day.ago)
      set_purchase_flags(purchase, chargeback_reversed: true)

      get url_redirect_path(token)

      expect(response).to have_http_status(:found)
      expect(response.location).to include("X-Amz-Signature=")
    end

    it "sends a visitor signed in as someone else to the purchaser check", parity: true do
      log_in(create(:user, name: "Other Buyer"))

      get url_redirect_path(token)

      expect(response).to redirect_to(url_redirect_check_purchaser_path(token, next: url_redirect_path(token)))
    end

    it "lets a team member through a purchase of another account", parity: true do
      admin = create(:admin_user)
      log_in(admin)

      get url_redirect_path(token)

      expect(response).to have_http_status(:found)
      expect(response.location).to include("X-Amz-Signature=")
    end

    it "sends an expired rental to the rental expired page", parity: true do
      set_purchase_flags(purchase, is_rental: true)
      purchase.update_columns(rental_expired: true)
      url_redirect.update!(is_rental: true)

      get url_redirect_path(token)

      expect(response).to redirect_to(url_redirect_rental_expired_page_path(token))
    end

    it "sends a revoked purchase to the expired page", parity: true do
      set_purchase_flags(purchase, is_access_revoked: true)

      get url_redirect_path(token)

      expect(response).to redirect_to(url_redirect_expired_page_path(token))
    end

    it "sends a membership without access to the inactive page", parity: true do
      member_purchase = create(:membership_purchase, purchaser: buyer, email: "buyer@example.com")
      create(:readable_document, link: member_purchase.link)
      member_purchase.subscription.update_columns(cancelled_at: 2.days.ago, flags: member_purchase.subscription.flags | 2)
      member_purchase.link.update!(block_access_after_membership_cancellation: true)
      redirect = create(:url_redirect, link: member_purchase.link, purchase: member_purchase, uses: 0, expires_at: nil)

      get url_redirect_path(redirect.token)

      expect(response).to redirect_to(url_redirect_membership_inactive_page_path(redirect.token))
    end

    it "asks a seen redirect's visitor to confirm the email", parity: true do
      url_redirect.update!(has_been_seen: true)

      get url_redirect_path(token), headers: { "X-Forwarded-For" => "198.51.100.4" }

      expect(response).to redirect_to(confirm_page_path(id: token, destination: "show"))
    end

    it "does not ask an unseen redirect's visitor to confirm", parity: true do
      get url_redirect_path(token), headers: { "X-Forwarded-For" => "198.51.100.4" }

      expect(response).to have_http_status(:found)
      expect(response.location).to include("X-Amz-Signature=")
    end

    it "lets the purchaser in without a confirmation", parity: true do
      url_redirect.update!(has_been_seen: true)
      log_in(buyer)

      get url_redirect_path(token), headers: { "X-Forwarded-For" => "198.51.100.4" }

      expect(response).to have_http_status(:found)
      expect(response.location).to include("X-Amz-Signature=")
    end

    it "keeps a seller's test purchase to the seller", parity: true do
      test_purchase = create(:free_purchase, link: product, purchaser: seller, email: seller.email, purchase_state: "test_successful")
      redirect = create(:url_redirect, link: product, purchase: test_purchase, uses: 0, expires_at: nil)
      log_in(create(:user, name: "Curious Buyer"))

      get url_redirect_path(redirect.token)

      expect(response).to have_http_status(:not_found)
    end

    it "sends a signed out visitor of a test purchase to the login", parity: true do
      test_purchase = create(:free_purchase, link: product, purchaser: seller, email: seller.email, purchase_state: "test_successful")
      redirect = create(:url_redirect, link: product, purchase: test_purchase, uses: 0, expires_at: nil)

      get url_redirect_path(redirect.token)

      expect(response).to have_http_status(:found)
      expect(response.location).to include("/login?next=")
    end

    it "serves an imported customer without a purchase", parity: true do
      customer = create(:imported_customer, link: product)
      redirect = create(:url_redirect, link: product, purchase: nil, imported_customer: customer, uses: 0, expires_at: nil)

      get url_redirect_path(redirect.token)

      expect(response).to have_http_status(:found)
    end
  end

  describe "GET /r/:id" do
    it "sends the page to the download page when it holds several files", parity: true do
      pdf
      create(:streamable_video, link: product, display_name: "Lesson")

      get url_redirect_path(token), headers: { "X-Forwarded-For" => "203.0.113.9" }

      expect(response).to redirect_to(url_redirect.download_page_url)
    end

    it "sends a purchase of a product without files to the download page", parity: true do
      get url_redirect_path(token), headers: { "X-Forwarded-For" => "203.0.113.9" }

      expect(response).to redirect_to(url_redirect.download_page_url)
    end

    it "serves an external link file as its own address", parity: true do
      create(:external_link, link: product, url: "https://example.com/the-guide")

      get url_redirect_path(token), headers: { "X-Forwarded-For" => "203.0.113.9" }

      expect(response).to redirect_to("https://example.com/the-guide")
    end

    it "warns when the file is missing from storage", parity: true do
      create(:readable_document, link: product, url: "#{S3_BASE_URL}specs/missing-from-the-bucket.pdf")

      get url_redirect_path(token), headers: { "X-Forwarded-For" => "203.0.113.9" }

      expect(response).to redirect_to(url_redirect.download_page_url)
      expect(flash[:warning]).to eq("The file is no longer available. Please contact the seller.")
    end

    it "serves a url redirect of a preorder through the preorder link", parity: true do
      pdf
      get url_redirect_path(token), headers: { "X-Forwarded-For" => "203.0.113.9" }
      expect(response).to have_http_status(:found)
    end
  end

  describe "GET /r/:id/product_files" do
    before { pdf }

    it "redirects to the signed file", parity: true do
      get url_redirect_download_product_files_path(token, product_file_ids: [pdf.external_id]), headers: { "X-Forwarded-For" => "203.0.113.9" }

      expect(response).to have_http_status(:found)
      expect(response.location).to include("X-Amz-Signature=")
      expect(ConsumptionEvent.last).to have_attributes(event_type: "download", product_file_id: pdf.id)
    end

    it "lists signed files as JSON", parity: true do
      video = create(:streamable_video, link: product, display_name: "Lesson")

      get url_redirect_download_product_files_path(token, product_file_ids: [pdf.external_id, video.external_id], format: :json), headers: { "X-Forwarded-For" => "203.0.113.9" }

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body["files"].map { _1["filename"] }).to eq(["billion-dollar-company-chapter-0.pdf", "ScreenRecording.mov"])
    end

    it "answers 404 for a file the redirect does not hold", parity: true do
      other = create(:readable_document, link: create(:product, user: seller))

      get url_redirect_download_product_files_path(token, product_file_ids: [other.external_id]), headers: { "X-Forwarded-For" => "203.0.113.9" }

      expect(response).to have_http_status(:not_found)
    end

    it "answers 404 for a stream only file", parity: true do
      pdf.update!(stream_only: true)

      get url_redirect_download_product_files_path(token, product_file_ids: [pdf.external_id]), headers: { "X-Forwarded-For" => "203.0.113.9" }

      expect(response).to have_http_status(:not_found)
    end

    it "warns as JSON when the file is gone from storage", parity: true do
      gone = create(:readable_document, link: product, url: "#{S3_BASE_URL}specs/missing-from-the-bucket.pdf")

      get url_redirect_download_product_files_path(token, product_file_ids: [gone.external_id], format: :json), headers: { "X-Forwarded-For" => "203.0.113.9" }

      expect(response).to have_http_status(:not_found)
      expect(response.parsed_body).to eq("error" => "The file is no longer available.")
    end
  end

  describe "GET /media_urls/:id" do
    it "answers an empty hash without file ids", parity: true do
      pdf

      get url_redirect_media_urls_path(token)

      expect(response.parsed_body).to eq({})
    end

    it "lists the urls of a video and an audio file", parity: true do
      video = create(:streamable_video, link: product, display_name: "Lesson")
      audio = create(:listenable_audio, link: product, display_name: "Track")
      pdf

      get url_redirect_media_urls_path(token, file_ids: [video.external_id, audio.external_id, pdf.external_id]), headers: { "X-Forwarded-For" => "203.0.113.9" }

      expect(response.parsed_body.keys).to contain_exactly(video.external_id, audio.external_id, pdf.external_id)
      expect(response.parsed_body[pdf.external_id]).to eq([])
    end

    it "answers 404 to a visitor who has not confirmed a seen redirect", parity: true do
      pdf
      url_redirect.update!(has_been_seen: true)

      get url_redirect_media_urls_path(token, file_ids: [pdf.external_id]), headers: { "X-Forwarded-For" => "198.51.100.4" }

      expect(response).to have_http_status(:ok)
    end

    it "keeps a test purchase's urls to the seller", parity: true do
      test_purchase = create(:free_purchase, link: product, purchaser: seller, email: seller.email, purchase_state: "test_successful")
      redirect = create(:url_redirect, link: product, purchase: test_purchase, uses: 0, expires_at: nil)

      get url_redirect_media_urls_path(redirect.token, file_ids: ["x"])

      expect(response).to have_http_status(:not_found)
    end
  end

  describe "POST /r/:id/save_last_content_page" do
    before { pdf }

    it "saves the page the buyer stopped at", parity: true do
      log_in(buyer)

      post_json url_redirect_save_last_content_page_path(token), page_id: "abc123"

      expect(response.parsed_body).to eq("success" => true)
      expect(purchase.reload.last_content_page_id).to eq("abc123")
    end

    it "clears the page without a page id", parity: true do
      purchase.update!(last_content_page_id: "abc123")
      log_in(buyer)

      post_json url_redirect_save_last_content_page_path(token)

      expect(response.parsed_body).to eq("success" => true)
      expect(purchase.reload.last_content_page_id).to be_nil
    end

    it "refuses an oversized page id", parity: true do
      log_in(buyer)

      post_json url_redirect_save_last_content_page_path(token), page_id: "x" * 65

      expect(response).to have_http_status(:unprocessable_entity)
      expect(response.parsed_body).to eq("success" => false, "error" => "Invalid page")
    end

    it "refuses a page id that is not a string", parity: true do
      log_in(buyer)

      post_json url_redirect_save_last_content_page_path(token), page_id: 7

      expect(response).to have_http_status(:unprocessable_entity)
    end

    it "refuses a redirect without a purchase", parity: true do
      customer = create(:imported_customer, link: product)
      redirect = create(:url_redirect, link: product, purchase: nil, imported_customer: customer, uses: 0, expires_at: nil)

      post_json url_redirect_save_last_content_page_path(redirect.token), page_id: "abc"

      expect(response).to have_http_status(:unprocessable_entity)
      expect(response.parsed_body).to eq("success" => false, "error" => "Purchase not found")
    end

    it "does not save for another buyer", parity: true do
      log_in(create(:user, name: "Other Buyer"))

      post_json url_redirect_save_last_content_page_path(token), page_id: "abc"

      expect(response).to have_http_status(:found)
      expect(purchase.reload.last_content_page_id).to be_nil
    end
  end

  describe "POST /confirm-redirect" do
    before { pdf }

    def confirm(params)
      post "/confirm-redirect", params: { authenticity_token: csrf_token }.merge(params)
    end

    it "confirms the purchase email and opens the file", parity: true do
      confirm(id: token, email: "Buyer@Example.com ")

      expect(response).to redirect_to(url_redirect_path(token))
      expect(set_cookies).to include("confirmed_redirect=")
    end

    it "opens the download page", parity: true do
      confirm(id: token, email: "buyer@example.com", destination: "download_page", display: "mobile_app")

      expect(response).to redirect_to(url_redirect_download_page_path(token, display: "mobile_app"))
    end

    it "opens the stream page", parity: true do
      confirm(id: token, email: "buyer@example.com", destination: "stream")

      expect(response).to redirect_to(url_redirect_stream_page_path(token))
    end

    it "opens the player", parity: true do
      confirm(id: token, email: "buyer@example.com", destination: "play")

      expect(response).to redirect_to(url_redirect_play_path(token))
    end

    it "asks again after a wrong email", parity: true do
      confirm(id: token, email: "someone@example.com", destination: "download_page")

      expect(response).to redirect_to(confirm_page_path(id: token))
      expect(flash[:alert]).to eq("Wrong email. Please try again.")
    end

    it "sends a test purchase's visitor to the login", parity: true do
      test_purchase = create(:free_purchase, link: product, purchaser: seller, email: seller.email, purchase_state: "test_successful")
      redirect = create(:url_redirect, link: product, purchase: test_purchase, uses: 0, expires_at: nil)

      confirm(id: redirect.token, email: seller.email)

      expect(response).to have_http_status(:found)
      expect(response.location).to include("/login?next=")
    end

    it "answers 404 for an unknown token", parity: true do
      confirm(id: "nope", email: "buyer@example.com")

      expect(response).to have_http_status(:not_found)
    end
  end

  describe "POST /r/:id/change_purchaser" do
    before { pdf }

    def change_purchaser(params)
      post url_redirect_change_purchaser_path(token), params: { authenticity_token: csrf_token }.merge(params)
    end

    it "moves the purchase to the signed in account", parity: true do
      claimer = create(:user, name: "New Owner")
      log_in(claimer)

      change_purchaser(email: "buyer@example.com", next: url_redirect_download_page_path(token))

      expect(response).to redirect_to(url_redirect_download_page_path(token))
      expect(purchase.reload.purchaser).to eq(claimer)
    end

    it "asks for the right email", parity: true do
      log_in(create(:user, name: "New Owner"))

      change_purchaser(email: "wrong@example.com")

      expect(response).to redirect_to(url_redirect_check_purchaser_path(token))
      expect(flash[:alert]).to eq("Please enter the correct email address used to purchase this product")
    end

    it "keeps the next path on a wrong email", parity: true do
      log_in(create(:user, name: "New Owner"))

      change_purchaser(email: "", next: "/d/#{token}")

      expect(response).to redirect_to(url_redirect_check_purchaser_path(token, next: "/d/#{token}"))
    end

    it "sends a signed out visitor to the login", parity: true do
      change_purchaser(email: "buyer@example.com")

      expect(response).to have_http_status(:found)
      expect(response.location).to include("/login?next=")
      expect(purchase.reload.purchaser).to eq(buyer)
    end

    it "refuses a purchase under review", parity: true do
      set_purchase_flags(purchase, is_reassignment_locked: true)
      log_in(create(:user, name: "New Owner"))

      change_purchaser(email: "buyer@example.com")

      expect(response).to redirect_to(url_redirect_check_purchaser_path(token))
      expect(flash[:alert]).to eq("This purchase is under review and cannot be moved to another account. Please contact support for help.")
    end

    it "refuses the seller claiming a customer's purchase", parity: true do
      log_in(seller)

      change_purchaser(email: "buyer@example.com")

      expect(response).to redirect_to(url_redirect_check_purchaser_path(token))
      expect(flash[:alert]).to eq("This is your customer's purchase, so it can't be moved into your account.")
    end

    it "answers 404 for a seller's test purchase to a stranger", parity: true do
      test_purchase = create(:free_purchase, link: product, purchaser: seller, email: seller.email, purchase_state: "test_successful")
      redirect = create(:url_redirect, link: product, purchase: test_purchase, uses: 0, expires_at: nil)
      log_in(create(:user, name: "New Owner"))

      post url_redirect_change_purchaser_path(redirect.token), params: { authenticity_token: csrf_token, email: seller.email }

      expect(response).to have_http_status(:not_found)
    end
  end

  describe "POST /consumption_analytics" do
    let(:video) { create(:streamable_video, link: product, display_name: "Lesson") }
    let(:event_params) { { url_redirect_id: url_redirect.external_id, product_file_id: video.external_id, event_type: "watch", platform: "web" } }

    it "records a consumption event", parity: true do
      post_json "/consumption_analytics", event_params

      expect(response.parsed_body).to eq("success" => true)
      expect(ConsumptionEvent.last).to have_attributes(event_type: "watch", platform: "web", purchase_id: purchase.id, product_file_id: video.id)
    end

    it "takes the purchase from the params", parity: true do
      post_json "/consumption_analytics", event_params.merge(purchase_id: purchase.external_id, consumed_at: "2025-03-01T10:00:00Z")

      expect(response.parsed_body).to eq("success" => true)
      expect(ConsumptionEvent.last.consumed_at).to eq(Time.utc(2025, 3, 1, 10))
    end

    it "answers false for an unknown event type", parity: true do
      post_json "/consumption_analytics", event_params.merge(event_type: "teleport")

      expect(response.parsed_body).to eq("success" => false)
    end

    it "answers false for an unknown platform", parity: true do
      post_json "/consumption_analytics", event_params.merge(platform: "toaster")

      expect(response.parsed_body).to eq("success" => false)
    end

    it "answers false without a url redirect", parity: true do
      post_json "/consumption_analytics", event_params.except(:url_redirect_id)

      expect(response.parsed_body).to eq("success" => false)
    end

    it "answers false for a url redirect id that does not decrypt", parity: true do
      post_json "/consumption_analytics", event_params.merge(url_redirect_id: "garbage")

      expect(response.parsed_body).to eq("success" => false)
    end
  end

  describe "streaming deliveries" do
    let(:video) { create(:streamable_video, link: product, display_name: "Lesson") }
    let(:forwarded) { { "X-Forwarded-For" => "203.0.113.9" } }

    before { video }

    def transcode(file)
      create(:transcoded_video, streamable: file, key_base_path: "attachments/0123456789abcdef0123456789abcdef", original_video_key: "attachments/0123456789abcdef0123456789abcdef/movie.mp4", is_hls: true)
    end

    it "serves the SMIL of a video", parity: true do
      get url_redirect_smil_for_product_file_path(token, video.external_id), headers: forwarded

      expect(response).to have_http_status(:ok)
      expect(response.body).to start_with("<smil><body><switch><video src=")
      expect(ConsumptionEvent.last).to have_attributes(event_type: "watch", product_file_id: video.id)
    end

    it "starts a rental's viewing window with the SMIL", parity: true do
      set_purchase_flags(purchase, is_rental: true)
      url_redirect.update!(is_rental: true)

      get url_redirect_smil_for_product_file_path(token, video.external_id), headers: forwarded

      expect(url_redirect.reload.rental_first_viewed_at).to be_present
    end

    it "answers 404 for the SMIL of a file the redirect does not hold", parity: true do
      get url_redirect_smil_for_product_file_path(token, create(:streamable_video, link: create(:product, user: seller)).external_id), headers: forwarded

      expect(response).to have_http_status(:not_found)
    end

    it "keeps a test purchase's SMIL to the seller", parity: true do
      test_purchase = create(:free_purchase, link: product, purchaser: seller, email: seller.email, purchase_state: "test_successful")
      redirect = create(:url_redirect, link: product, purchase: test_purchase, uses: 0, expires_at: nil)

      get url_redirect_smil_for_product_file_path(redirect.token, video.external_id)

      expect(response).to have_http_status(:not_found)
    end

    it "serves the HLS playlist with signed lines", parity: true do
      transcode(video)

      get hls_playlist_for_product_file_path(token, video.external_id), headers: forwarded

      expect(response).to have_http_status(:ok)
      expect(response.media_type).to eq("application/x-mpegurl")
      expect(response.body).to include("Signature=")
      expect(ConsumptionEvent.last).to have_attributes(event_type: "watch")
    end

    it "serves the first file's playlist for an unknown file", parity: true do
      transcode(video)

      get hls_playlist_for_product_file_path(token, "unknown"), headers: forwarded

      expect(response).to have_http_status(:ok)
    end

    it "answers 404 for a video without a playlist", parity: true do
      get hls_playlist_for_product_file_path(token, video.external_id), headers: forwarded

      expect(response).to have_http_status(:not_found)
    end

    it "sends a confirmation to a visitor of a seen redirect asking for the playlist", parity: true do
      transcode(video)
      url_redirect.update!(has_been_seen: true)

      get hls_playlist_for_product_file_path(token, video.external_id), headers: { "X-Forwarded-For" => "198.51.100.4" }

      expect(response).to redirect_to(confirm_page_path(id: token, destination: "hls_playlist"))
    end

    it "redirects to the signed subtitle file", parity: true do
      subtitle = create(:subtitle_file, product_file: video, url: "#{AWS_S3_ENDPOINT}/#{S3_BUCKET}/specs/captions.srt")

      get url_redirect_download_subtitle_file_path(token, video.external_id, subtitle.external_id), headers: forwarded

      expect(response).to have_http_status(:found)
      expect(response.location).to include("X-Amz-Signature=")
    end

    it "answers 404 for a subtitle file of another video", parity: true do
      subtitle = create(:subtitle_file, product_file: create(:streamable_video, link: product), url: "#{AWS_S3_ENDPOINT}/#{S3_BUCKET}/specs/captions.srt")

      get url_redirect_download_subtitle_file_path(token, video.external_id, subtitle.external_id), headers: forwarded

      expect(response).to have_http_status(:not_found)
    end

    it "answers 404 for a subtitle of a rented video", parity: true do
      subtitle = create(:subtitle_file, product_file: video, url: "#{AWS_S3_ENDPOINT}/#{S3_BUCKET}/specs/captions.srt")
      set_purchase_flags(purchase, is_rental: true)
      url_redirect.update!(is_rental: true)

      get url_redirect_download_subtitle_file_path(token, video.external_id, subtitle.external_id), headers: forwarded

      expect(response).to have_http_status(:not_found)
    end
  end

  describe "POST /r/:id/send_to_kindle" do
    let(:kindle_pdf) { create(:readable_document, link: product, size: 50) }
    let(:forwarded) { { "X-Forwarded-For" => "203.0.113.9" } }

    def kindle(headers: forwarded, **params)
      post send_to_kindle_path(token), params: params.to_json, headers: json_headers.merge("X-CSRF-Token" => csrf_token).merge(headers)
    end

    before { kindle_pdf }

    it "asks for an email", parity: true do
      kindle(file_external_id: kindle_pdf.external_id)

      expect(response.parsed_body).to eq("success" => false, "error" => "Please enter a valid Kindle email address")
    end

    it "queues the file for a kindle address", parity: true do
      kindle(file_external_id: kindle_pdf.external_id, email: "dude@kindle.com")

      expect(response.parsed_body).to eq("success" => true)
      expect(ConsumptionEvent.last).to have_attributes(event_type: "read", product_file_id: kindle_pdf.id)
    end

    it "refuses an address that is not a kindle one", parity: true do
      kindle(file_external_id: kindle_pdf.external_id, email: "dude@example.com")

      expect(response.parsed_body).to eq("success" => false, "error" => "Please enter a valid Kindle email address")
    end

    it "answers 404 for a refunded purchase", parity: true do
      purchase.update_columns(stripe_refunded: true)

      kindle(file_external_id: kindle_pdf.external_id, email: "dude@kindle.com")

      expect(response).to have_http_status(:not_found)
    end

    it "answers 404 for an unknown file", parity: true do
      kindle(file_external_id: "unknown", email: "dude@kindle.com")

      expect(response).to have_http_status(:not_found)
      expect(response.parsed_body).to eq("success" => false, "error" => "File not found")
    end

    it "refuses a file that cannot be sent", parity: true do
      other = create(:non_readable_document, link: product, size: 50)

      kindle(file_external_id: other.external_id, email: "dude@kindle.com")

      expect(response).to have_http_status(:unprocessable_entity)
    end

    it "answers 404 to a visitor who has not confirmed a seen redirect", parity: true do
      url_redirect.update!(has_been_seen: true)

      kindle(file_external_id: kindle_pdf.external_id, email: "dude@kindle.com", headers: { "X-Forwarded-For" => "198.51.100.4" })

      expect(response).to have_http_status(:not_found)
    end

    it "hands a signed in buyer's address to Rails", parity: true do
      log_in(buyer)

      kindle(file_external_id: kindle_pdf.external_id, email: "dude@kindle.com")

      expect(response.parsed_body).to eq("success" => true)
    end
  end
end
