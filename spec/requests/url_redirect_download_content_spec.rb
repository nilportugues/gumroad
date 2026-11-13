# frozen_string_literal: true

require "spec_helper"

# What GET /d/:id lists beyond the product's own files: rich content pages, the license key, the posts a
# buyer is shown and the background polls of the page. Recorded for the Next.js port (PARITY_RECORD=1) and
# replayed by nextjs/parity/__tests__/url-redirect-pages.replay.test.ts, which sends the last request of each
# example and compares the response and the writes. Examples named "hands a ..." are shapes Node leaves to Rails.
describe "Url redirect download page content", type: :request do
  include Parity::SignedInDashboard

  let(:seller) { create(:user, name: "Content Seller", username: "contentseller") }
  let(:buyer) { create(:user, name: "Content Buyer") }
  let(:product) { create(:product, user: seller, name: "Content course", unique_permalink: "content").tap { |record| record.product_files.delete_all } }
  let(:purchase) do
    create(:free_purchase, link: product, purchaser: buyer, email: "buyer@example.com", ip_address: "203.0.113.9").tap do |record|
      record.update_columns(price_cents: 500, total_transaction_cents: 500)
    end
  end
  let(:url_redirect) { create(:url_redirect, link: product, purchase:) }
  let(:token) { url_redirect.token }

  def page(text)
    { "type" => "paragraph", "content" => [{ "type" => "text", "text" => text }] }
  end

  def embed(file)
    { "type" => "fileEmbed", "attrs" => { "id" => ObfuscateIds.encrypt(file.id), "uid" => "embed-#{file.id}" } }
  end

  def document(name, position:)
    create(:readable_document, link: product, display_name: name, position:).tap { |file| file.update_columns(pagelength: 3, size: 50_000) }
  end

  def add_page(title, description, position:, updated_at: nil)
    create(:rich_content, entity: product, title:, description:, position:).tap do |content|
      content.update_columns(updated_at:) if updated_at
    end
  end

  describe "rich content" do
    it "lists the pages of the product in position order", parity: true do
      add_page("Second page", [page("Later")], position: 2)
      add_page("Welcome", [page("Hello there"), { "type" => "licenseKey" }], position: 1)
      log_in(buyer)

      get url_redirect_download_page_path(token)

      expect(response).to be_successful
      expect(inertia_props_of(response).dig("content", "rich_content_pages").map { |entry| entry["title"] }).to eq(["Welcome", "Second page"])
      expect(url_redirect.reload).to have_attributes(uses: 1, has_been_seen: true)
    end

    it "lists only the embedded files, in the order the pages embed them", parity: true do
      first = document("First file", position: 1)
      second = document("Second file", position: 2)
      document("Not embedded", position: 3)
      third = document("Third file", position: 4)
      add_page("Files", [embed(third), { "type" => "bulletList", "content" => [{ "type" => "listItem", "content" => [embed(first)] }] }], position: 1)
      add_page("More files", [embed(second), embed(third)], position: 2)
      log_in(buyer)

      get url_redirect_download_page_path(token)

      expect(response).to be_successful
      expect(inertia_props_of(response).dig("content", "content_items").map { |item| item["file_name"] }).to eq(["Third file", "First file", "Second file"])
    end

    it "lists every file when no page embeds one", parity: true do
      document("Alpha", position: 2)
      document("Beta", position: 1)
      add_page("Intro", [page("No embeds here")], position: 1)
      log_in(buyer)

      get url_redirect_download_page_path(token)

      expect(response).to be_successful
      expect(inertia_props_of(response).dig("content", "content_items").map { |item| item["file_name"] }).to eq(%w[Beta Alpha])
    end

    it "skips an embedded file that was deleted", parity: true do
      kept = document("Kept", position: 1)
      gone = document("Gone", position: 2)
      gone.update_columns(deleted_at: Time.current)
      add_page("Files", [embed(gone), embed(kept)], position: 1)
      log_in(buyer)

      get url_redirect_download_page_path(token)

      expect(response).to be_successful
      expect(inertia_props_of(response).dig("content", "content_items").map { |item| item["file_name"] }).to eq(["Kept"])
    end

    it "leaves out a deleted page", parity: true do
      add_page("Alive", [page("Visible")], position: 1)
      add_page("Removed", [page("Gone")], position: 2).update_columns(deleted_at: Time.current)
      log_in(buyer)

      get url_redirect_download_page_path(token)

      expect(response).to be_successful
      expect(inertia_props_of(response).dig("content", "rich_content_pages").size).to eq(1)
    end

    it "lists the pages for a guest purchase", parity: true do
      add_page("Welcome", [page("Hello")], position: 1)
      purchase.update_columns(purchaser_id: nil)

      get url_redirect_download_page_path(token), headers: { "X-Forwarded-For" => "203.0.113.9" }

      expect(response).to be_successful
      expect(inertia_props_of(response)["add_to_library_option"]).to eq("signup_form")
    end

    it "hands a page whose seller watches the transcoding to Rails", parity: true do
      document("Lesson", position: 1)
      create(:streamable_video, link: product, display_name: "Lecture", position: 2)
      add_page("Welcome", [page("Hello")], position: 1)
      log_in(seller)
      create(:url_redirect, link: product, purchase: nil).tap do |own|
        get url_redirect_download_page_path(own.token)
      end

      expect(response).to be_successful
    end

    it "hands a product with versions and pages to Rails", parity: true do
      category = create(:variant_category, link: product, title: "Tier")
      create(:variant, variant_category: category, name: "Basic")
      add_page("Welcome", [page("Hello")], position: 1)
      log_in(buyer)

      get url_redirect_download_page_path(token)

      expect(response).to be_successful
    end

    it "hands a commission's pages to Rails", parity: true do
      add_page("Welcome", [page("Hello")], position: 1)
      create(:commission, deposit_purchase: purchase)
      log_in(buyer)

      get url_redirect_download_page_path(token)

      expect(response).to be_successful
    end
  end

  describe "license" do
    before { product.update_columns(flags: product.flags | Link.flag_mapping["flags"][:is_licensed]) }

    it "shows the license key of the purchase", parity: true do
      create(:license, link: product, purchase:, serial: "LICENSE-KEY-1234-ABCD")
      log_in(buyer)

      get url_redirect_download_page_path(token)

      expect(response).to be_successful
      expect(inertia_props_of(response).dig("content", "license")).to include("license_key" => "LICENSE-KEY-1234-ABCD", "seats" => 1)
    end

    it "shows the seats of a multi-seat license", parity: true do
      purchase.is_multiseat_license = true
      purchase.update_columns(flags: purchase.flags, quantity: 3)
      create(:license, link: product, purchase:, serial: "SEATS-KEY-0000-FFFF")
      log_in(buyer)

      get url_redirect_download_page_path(token)

      expect(response).to be_successful
      expect(inertia_props_of(response).dig("content", "license")).to include("is_multiseat_license" => true, "seats" => 3)
    end

    it "shows no license while the purchase has none", parity: true do
      log_in(buyer)

      get url_redirect_download_page_path(token)

      expect(response).to be_successful
      expect(inertia_props_of(response).dig("content", "license")).to be_nil
    end

    it "shows the license next to the pages that print it", parity: true do
      create(:license, link: product, purchase:, serial: "PAGE-KEY-1111-2222")
      add_page("Your key", [{ "type" => "licenseKey" }], position: 1)
      log_in(buyer)

      get url_redirect_download_page_path(token)

      expect(response).to be_successful
    end
  end

  describe "polls" do
    let(:poll_headers) do
      {
        "X-Inertia" => "true",
        "X-Inertia-Partial-Component" => "UrlRedirects/DownloadPage",
        "X-Inertia-Partial-Data" => "audio_durations,latest_media_locations",
      }
    end

    def audio(name, position:, duration:)
      create(:listenable_audio, link: product, display_name: name, position:).tap { |file| file.update_columns(duration:, size: 4_000) }
    end

    it "answers the durations of the audio files and the latest media locations", parity: true do
      theme = audio("Theme", position: 1, duration: 31)
      document("Handbook", position: 2).tap do |pdf|
        create(:media_location, product_id: product.id, product_file_id: pdf.id, purchase_id: purchase.id, url_redirect_id: url_redirect.id, location: 2, consumed_at: 2.days.ago)
      end
      create(:media_location, product_id: product.id, product_file_id: theme.id, purchase_id: purchase.id, url_redirect_id: url_redirect.id, location: 12, platform: "web", consumed_at: 1.day.ago)
      log_in(buyer)

      get url_redirect_download_page_path(token), headers: poll_headers

      expect(response).to be_successful
      expect(response.parsed_body.dig("props", "audio_durations")).to eq(theme.external_id => 31)
      expect(url_redirect.reload.uses).to eq(0)
      expect(ConsumptionEvent.where(url_redirect_id: url_redirect.id).count).to eq(0)
    end

    it "answers only the prop the poll asks for", parity: true do
      audio("Theme", position: 1, duration: 31)
      log_in(buyer)

      get url_redirect_download_page_path(token), headers: poll_headers.merge("X-Inertia-Partial-Data" => "audio_durations")

      expect(response).to be_successful
      expect(response.parsed_body["props"]).not_to have_key("latest_media_locations")
    end

    it "answers empty maps for a redirect without files", parity: true do
      log_in(buyer)

      get url_redirect_download_page_path(token), headers: poll_headers

      expect(response.parsed_body.dig("props", "audio_durations")).to eq({})
      expect(response.parsed_body.dig("props", "latest_media_locations")).to eq({})
    end

    it "answers the locations of a rich content page's embedded files", parity: true do
      theme = audio("Theme", position: 1, duration: 31)
      audio("Other", position: 2, duration: 40)
      add_page("Listen", [embed(theme)], position: 1)
      log_in(buyer)

      get url_redirect_download_page_path(token), headers: poll_headers

      expect(response.parsed_body.dig("props", "audio_durations").keys).to eq([theme.external_id])
    end

    it "answers a redirect without a purchase with no locations", parity: true do
      audio("Theme", position: 1, duration: 31)
      link_only = create(:url_redirect, link: product, purchase: nil)
      log_in(seller)

      get url_redirect_download_page_path(link_only.token), headers: poll_headers

      expect(response.parsed_body.dig("props", "latest_media_locations")).to eq({})
    end

    it "moves the poll of a withdrawn purchase to the expired page", parity: true do
      purchase.update_attribute(:is_access_revoked, true)
      log_in(buyer)

      get url_redirect_download_page_path(token), headers: poll_headers

      expect(response).to redirect_to(url_redirect_expired_page_path(token))
    end

    def epub_with_location(location, unit)
      epub = create(:readable_document, link: product, display_name: "Book", position: 1, url: "#{S3_BASE_URL}specs/player-book.epub")
      epub.update_columns(filetype: "epub", pagelength: 20)
      create(:media_location, product_id: product.id, product_file_id: epub.id, purchase_id: purchase.id, url_redirect_id: url_redirect.id, location:, consumed_at: 1.day.ago).update_columns(unit:)
      epub
    end

    it "answers the percentage location of an EPUB as saved", parity: true do
      epub = epub_with_location(50, "percentage")
      log_in(buyer)

      get url_redirect_download_page_path(token), headers: poll_headers

      expect(response.parsed_body.dig("props", "latest_media_locations", epub.external_id)).to include("location" => 50, "unit" => "percentage")
    end

    it "hands a poll of an EPUB with a page number location to Rails", parity: true do
      epub_with_location(4, "page_number")
      log_in(buyer)

      get url_redirect_download_page_path(token), headers: poll_headers

      expect(response).to be_successful
    end
  end

  describe "posts" do
    def post_for(name, published_at: 3.days.ago, **attributes)
      create(:installment, link: product, seller:, installment_type: "product", name:, published_at:, **attributes)
    end

    def sent_to(installment, purchase_record = purchase, sent_at: 2.days.ago)
      create(:creator_contacting_customers_email_info_sent, installment:, purchase: purchase_record, sent_at:)
    end

    it "lists the product posts that were emailed to the purchase", parity: true do
      older = post_for("Older update", published_at: 5.days.ago)
      newer = post_for("Newer update", published_at: 4.days.ago)
      sent_to(older, sent_at: 5.days.ago)
      sent_to(newer, sent_at: 3.days.ago)
      log_in(buyer)

      get url_redirect_download_page_path(token)

      expect(response).to be_successful
      expect(inertia_props_of(response).dig("content", "posts").map { |entry| entry["name"] }).to eq(["Newer update", "Older update"])
    end

    it "lists a product post shown only on the profile", parity: true do
      post_for("Profile update", send_emails: false, shown_on_profile: true, published_at: 2.days.ago)
      log_in(buyer)

      get url_redirect_download_page_path(token)

      expect(inertia_props_of(response).dig("content", "posts").map { |entry| entry["name"] }).to eq(["Profile update"])
    end

    it "lists seller posts that were emailed, or are on the profile", parity: true do
      emailed = create(:seller_installment, seller:, installment_type: "seller", name: "Seller news", published_at: 6.days.ago)
      sent_to(emailed, sent_at: 6.days.ago)
      create(:seller_installment, seller:, installment_type: "seller", name: "Seller profile post", published_at: 1.day.ago, send_emails: false, shown_on_profile: true)
      log_in(buyer)

      get url_redirect_download_page_path(token)

      expect(inertia_props_of(response).dig("content", "posts").map { |entry| entry["name"] }).to eq(["Seller profile post", "Seller news"])
    end

    it "leaves out unpublished, deleted and unsent posts", parity: true do
      post_for("Draft", published_at: nil).tap { |draft| sent_to(draft) }
      post_for("Deleted").tap { |deleted| sent_to(deleted); deleted.update_columns(deleted_at: Time.current) }
      post_for("Never sent")
      post_for("Kept").tap { |kept| sent_to(kept) }
      log_in(buyer)

      get url_redirect_download_page_path(token)

      expect(inertia_props_of(response).dig("content", "posts").map { |entry| entry["name"] }).to eq(["Kept"])
    end

    it "leaves out a seller post whose filters the purchase does not pass", parity: true do
      filtered = create(:seller_installment, seller:, installment_type: "seller", name: "Only big spenders", published_at: 2.days.ago, paid_more_than_cents: 100_000)
      sent_to(filtered)
      log_in(buyer)

      get url_redirect_download_page_path(token)

      expect(inertia_props_of(response).dig("content", "posts")).to eq([])
    end

    it "names an unnamed post after its message", parity: true do
      unnamed = post_for("placeholder", message: "<p>Hello <b>buyers</b>, here is a very long announcement about what comes next in the course</p>")
      unnamed.update_columns(name: nil)
      sent_to(unnamed)
      log_in(buyer)

      get url_redirect_download_page_path(token)

      expect(inertia_props_of(response).dig("content", "posts", 0, "name")).to start_with("Hello buyers")
    end

    it "hides the posts list when the pages have no posts block", parity: true do
      post_for("Update").tap { |update| sent_to(update) }
      add_page("Welcome", [page("Hello")], position: 1)
      log_in(buyer)

      get url_redirect_download_page_path(token)

      expect(inertia_props_of(response).dig("content", "posts")).to eq([])
    end

    it "lists the posts when a page has a posts block", parity: true do
      post_for("Update").tap { |update| sent_to(update) }
      add_page("Updates", [{ "type" => "posts" }], position: 1)
      log_in(buyer)

      get url_redirect_download_page_path(token)

      expect(inertia_props_of(response).dig("content", "posts").map { |entry| entry["name"] }).to eq(["Update"])
    end

    it "lists no posts for a redirect without a purchase", parity: true do
      post_for("Update", send_emails: false, shown_on_profile: true)
      link_only = create(:url_redirect, link: product, purchase: nil)
      log_in(seller)

      get url_redirect_download_page_path(link_only.token)

      expect(response).to be_successful
    end

    it "hands a seller with a custom domain to Rails", parity: true do
      create(:custom_domain, :verified_with_certificate, user: seller, domain: "content.example.com")
      post_for("Update").tap { |update| sent_to(update) }
      log_in(buyer)

      get url_redirect_download_page_path(token)

      expect(response).to be_successful
    end

    it "hands a product that shows every past post to Rails", parity: true do
      product.update_columns(flags: product.flags | Link.flag_mapping["flags"][:should_show_all_posts])
      post_for("Update").tap { |update| sent_to(update) }
      log_in(buyer)

      get url_redirect_download_page_path(token)

      expect(response).to be_successful
    end

    it "hands a buyer with a second purchase of the product to Rails", parity: true do
      post_for("Update").tap { |update| sent_to(update) }
      build(:purchase, link: product, email: "buyer@example.com", ip_address: "203.0.113.9", purchase_state: "successful").save!(validate: false)
      log_in(buyer)

      get url_redirect_download_page_path(token)

      expect(response).to be_successful
    end
  end
end
