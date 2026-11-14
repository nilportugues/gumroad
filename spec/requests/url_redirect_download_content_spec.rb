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

  describe "versions" do
    let(:category) { create(:variant_category, link: product, title: "Tier") }
    let!(:basic) { create(:variant, variant_category: category, name: "Basic") }
    let!(:premium) { create(:variant, variant_category: category, name: "Premium", price_difference_cents: 500) }

    def buy(version)
      purchase.variant_attributes << version
    end

    def version_file(version, name, position:)
      document(name, position:).tap { |file| version.product_files << file }
    end

    def version_page(version, title, description, position:)
      create(:rich_content, entity: version, title:, description:, position:)
    end

    def file_names(response)
      inertia_props_of(response).dig("content", "content_items").map { |item| item["file_name"] }
    end

    it "lists only the files of the version the purchase bought", parity: true do
      version_file(basic, "Basic guide", position: 1)
      version_file(premium, "Premium extras", position: 2)
      version_file(premium, "Premium guide", position: 1)
      buy(premium)
      log_in(buyer)

      get url_redirect_download_page_path(token)

      expect(response).to be_successful
      expect(file_names(response)).to eq(["Premium guide", "Premium extras"])
      expect(inertia_props_of(response).dig("purchase", "variant_id")).to eq(premium.external_id)
      expect(inertia_props_of(response).dig("content", "rich_content_pages")).to be_nil
      expect(url_redirect.reload).to have_attributes(uses: 1, has_been_seen: true)
    end

    it "lists no files for a version that has none, whatever its sibling has", parity: true do
      version_file(basic, "Basic guide", position: 1)
      buy(premium)
      log_in(buyer)

      get url_redirect_download_page_path(token)

      expect(response).to be_successful
      expect(file_names(response)).to eq([])
    end

    it "leaves out a deleted file of the version", parity: true do
      version_file(premium, "Premium guide", position: 1)
      version_file(premium, "Retired guide", position: 2).update_columns(deleted_at: Time.current)
      buy(premium)
      log_in(buyer)

      get url_redirect_download_page_path(token)

      expect(file_names(response)).to eq(["Premium guide"])
    end

    it "lists the pages of the version and the files they embed", parity: true do
      version_file(basic, "Basic guide", position: 1)
      guide = version_file(premium, "Premium guide", position: 1)
      version_file(premium, "Not embedded", position: 2)
      extras = version_file(premium, "Premium extras", position: 3)
      version_page(basic, "Basic page", [page("For basic buyers")], position: 1)
      version_page(premium, "Second", [embed(guide)], position: 2)
      version_page(premium, "Welcome", [embed(extras), page("Hello")], position: 1)
      buy(premium)
      log_in(buyer)

      get url_redirect_download_page_path(token)

      expect(response).to be_successful
      pages = inertia_props_of(response).dig("content", "rich_content_pages")
      expect(pages.map { |entry| entry["title"] }).to eq(%w[Welcome Second])
      expect(pages.map { |entry| entry["variant_id"] }.uniq).to eq([premium.external_id])
      # alive_rich_contents has no order: the files follow the pages as created, not by position.
      expect(file_names(response)).to eq(["Premium guide", "Premium extras"])
    end

    it "lists every file of the version when its pages embed none", parity: true do
      version_file(premium, "Premium guide", position: 1)
      version_page(premium, "Welcome", [page("Hello")], position: 1)
      buy(premium)
      log_in(buyer)

      get url_redirect_download_page_path(token)

      expect(file_names(response)).to eq(["Premium guide"])
    end

    it "lists a post shown only on the profile for the version the purchase bought", parity: true do
      create(:installment, link: product, seller:, installment_type: "variant", base_variant_id: premium.id, name: "Premium news", send_emails: false, shown_on_profile: true, published_at: 2.days.ago)
      create(:installment, link: product, seller:, installment_type: "variant", base_variant_id: basic.id, name: "Basic news", send_emails: false, shown_on_profile: true, published_at: 1.day.ago)
      buy(premium)
      log_in(buyer)

      get url_redirect_download_page_path(token)

      expect(inertia_props_of(response).dig("content", "posts").map { |entry| entry["name"] }).to eq(["Premium news"])
    end

    it "lists a post emailed to the purchase of a version", parity: true do
      news = create(:installment, link: product, seller:, installment_type: "variant", base_variant_id: premium.id, name: "Emailed news", published_at: 3.days.ago)
      create(:creator_contacting_customers_email_info_sent, installment: news, purchase:, sent_at: 2.days.ago)
      buy(premium)
      log_in(buyer)

      get url_redirect_download_page_path(token)

      expect(inertia_props_of(response).dig("content", "posts").map { |entry| entry["name"] }).to eq(["Emailed news"])
    end

    it "answers the durations of the audio files of the version", parity: true do
      theme = create(:listenable_audio, link: product, display_name: "Theme", position: 1).tap { |file| file.update_columns(duration: 31, size: 4_000) }
      create(:listenable_audio, link: product, display_name: "Other", position: 2).update_columns(duration: 40, size: 4_000)
      premium.product_files << theme
      buy(premium)
      log_in(buyer)

      get url_redirect_download_page_path(token), headers: {
        "X-Inertia" => "true",
        "X-Inertia-Partial-Component" => "UrlRedirects/DownloadPage",
        "X-Inertia-Partial-Data" => "audio_durations,latest_media_locations",
      }

      expect(response.parsed_body.dig("props", "audio_durations")).to eq(theme.external_id => 31)
    end

    it "hands a purchase of a SKU to Rails", parity: true do
      purchase.variant_attributes << create(:sku, link: product)
      log_in(buyer)

      get url_redirect_download_page_path(token)

      expect(response).to be_successful
    end

    it "hands a purchase of several versions to Rails", parity: true do
      version_file(basic, "Basic guide", position: 1)
      buy(basic)
      buy(premium)
      log_in(buyer)

      get url_redirect_download_page_path(token)

      expect(response).to be_successful
    end

    it "hands a purchase of a deleted version to Rails", parity: true do
      version_file(premium, "Premium guide", position: 1)
      buy(premium)
      premium.update_columns(deleted_at: Time.current)
      log_in(buyer)

      get url_redirect_download_page_path(token)

      expect(response).to be_successful
    end

    it "hands versions that share one set of pages to Rails", parity: true do
      product.update_columns(flags: product.flags | Link.flag_mapping["flags"][:has_same_rich_content_for_all_variants])
      add_page("Shared", [page("For everyone")], position: 1)
      buy(premium)
      log_in(buyer)

      get url_redirect_download_page_path(token)

      expect(response).to be_successful
    end

    it "shows the license key of a version with no pages", parity: true do
      product.update_columns(flags: product.flags | Link.flag_mapping["flags"][:is_licensed])
      create(:license, link: product, purchase:, serial: "VERSION-KEY-0000-1111")
      buy(premium)
      log_in(buyer)

      get url_redirect_download_page_path(token)

      expect(inertia_props_of(response).dig("content", "license", "license_key")).to eq("VERSION-KEY-0000-1111")
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

    def epub_with_location(location, unit, pagelength: 20)
      epub = create(:readable_document, link: product, display_name: "Book", position: 1, url: "#{S3_BASE_URL}specs/player-book.epub")
      epub.update_columns(filetype: "epub", pagelength:)
      create(:media_location, product_id: product.id, product_file_id: epub.id, purchase_id: purchase.id, url_redirect_id: url_redirect.id, location:, consumed_at: 1.day.ago).update_columns(unit:)
      epub
    end

    it "answers the percentage location of an EPUB as saved", parity: true do
      epub = epub_with_location(50, "percentage")
      log_in(buyer)

      get url_redirect_download_page_path(token), headers: poll_headers

      expect(response.parsed_body.dig("props", "latest_media_locations", epub.external_id)).to include("location" => 50, "unit" => "percentage")
    end

    it "answers the page number location of an EPUB as a percentage of its pages", parity: true do
      epub = epub_with_location(7, "page_number", pagelength: 21)
      log_in(buyer)

      get url_redirect_download_page_path(token), headers: poll_headers

      expect(response.parsed_body.dig("props", "latest_media_locations", epub.external_id)).to include("location" => 33, "unit" => "percentage")
      expect(response.parsed_body.dig("props", "latest_media_locations", epub.external_id)).not_to have_key("cfi")
    end

    it "rounds an EPUB page number down the way a float division does", parity: true do
      epub = epub_with_location(29, "page_number", pagelength: 100)
      log_in(buyer)

      get url_redirect_download_page_path(token), headers: poll_headers

      expect(response.parsed_body.dig("props", "latest_media_locations", epub.external_id)).to include("location" => 28, "unit" => "percentage")
    end

    it "keeps an EPUB page number below 100 percent", parity: true do
      epub = epub_with_location(20, "page_number")
      log_in(buyer)

      get url_redirect_download_page_path(token), headers: poll_headers

      expect(response.parsed_body.dig("props", "latest_media_locations", epub.external_id)).to include("location" => 99, "unit" => "percentage")
    end

    it "answers nothing for the page number of an EPUB without pages", parity: true do
      epub = epub_with_location(3, "page_number", pagelength: nil)
      log_in(buyer)

      get url_redirect_download_page_path(token), headers: poll_headers

      expect(response.parsed_body.dig("props", "latest_media_locations")).to eq(epub.external_id => nil)
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

    it "lists a post whose email info has no time last", parity: true do
      untimed = post_for("Untimed")
      sent_to(untimed).update_columns(sent_at: nil, delivered_at: nil, opened_at: nil)
      sent_to(post_for("Timed"), sent_at: 4.days.ago)
      log_in(buyer)

      get url_redirect_download_page_path(token)

      posts = inertia_props_of(response).dig("content", "posts")
      expect(posts.map { |entry| entry["name"] }).to eq(["Timed", "Untimed"])
      expect(Time.zone.parse(posts.last["action_at"])).to be_within(1.minute).of(Time.current)
    end

    it "lists a post once for each email info of the purchase", parity: true do
      repeated = post_for("Repeated")
      sent_to(repeated, sent_at: 5.days.ago)
      sent_to(repeated, sent_at: 3.days.ago)
      sent_to(post_for("Between"), sent_at: 4.days.ago)
      log_in(buyer)

      get url_redirect_download_page_path(token)

      expect(inertia_props_of(response).dig("content", "posts").map { |entry| entry["name"] }).to eq(["Repeated", "Between", "Repeated"])
    end

    it "lists two posts that share a sort time", parity: true do
      shared = 3.days.ago.change(usec: 0)
      sent_to(post_for("Emailed"), sent_at: shared)
      post_for("Profile", send_emails: false, shown_on_profile: true, published_at: shared)
      log_in(buyer)

      get url_redirect_download_page_path(token)

      expect(inertia_props_of(response).dig("content", "posts").map { |entry| entry["name"] }).to eq(["Profile", "Emailed"])
    end

    it "lists the posts of a seller without a username", parity: true do
      seller.update_columns(username: nil)
      sent_to(post_for("Update"))
      log_in(buyer)

      get url_redirect_download_page_path(token)

      expect(response).to be_successful
      expect(inertia_props_of(response).dig("content", "posts").map { |entry| entry["name"] }).to eq(["Update"])
    end

    it "hands three posts that share a sort time to Rails", parity: true do
      shared = 3.days.ago.change(usec: 0)
      sent_to(post_for("Emailed"), sent_at: shared)
      post_for("Profile", send_emails: false, shown_on_profile: true, published_at: shared)
      post_for("Other profile", send_emails: false, shown_on_profile: true, published_at: shared)
      log_in(buyer)

      get url_redirect_download_page_path(token)

      expect(response).to be_successful
    end

    it "hands a seller post with several email infos to Rails", parity: true do
      news = create(:seller_installment, seller:, installment_type: "seller", name: "Seller news", published_at: 6.days.ago)
      sent_to(news, sent_at: 6.days.ago)
      sent_to(news, sent_at: 5.days.ago)
      log_in(buyer)

      get url_redirect_download_page_path(token)

      expect(response).to be_successful
    end

    describe "custom domains" do
      def listed_urls
        get url_redirect_download_page_path(token)
        inertia_props_of(response).dig("content", "posts").map { |entry| entry["view_url"] }
      end

      before do
        sent_to(post_for("Update"))
        log_in(buyer)
      end

      it "links the posts to the seller's custom domain while it is verified with a certificate", parity: true do
        create(:custom_domain, :verified_with_certificate, user: seller, domain: "content.example.com")

        expect(listed_urls.first).to match(%r{\Ahttps?://content\.example\.com/p/})
        expect(listed_urls.first).to include("username=contentseller")
      end

      it "links the posts to the subdomain while the custom domain is unverified", parity: true do
        create(:custom_domain, :verified_with_certificate, user: seller, domain: "content.example.com").update_columns(state: "unverified")

        expect(listed_urls.first).to match(%r{\Ahttps?://contentseller\.})
      end

      it "links the posts to the subdomain once the certificate has expired", parity: true do
        create(:custom_domain, :verified_with_certificate, user: seller, domain: "content.example.com").update_columns(ssl_certificate_issued_at: 100.days.ago)

        expect(listed_urls.first).to match(%r{\Ahttps?://contentseller\.})
      end

      it "ignores a deleted custom domain", parity: true do
        create(:custom_domain, :verified_with_certificate, user: seller, domain: "content.example.com").update_columns(deleted_at: Time.current)

        expect(listed_urls.first).to match(%r{\Ahttps?://contentseller\.})
      end
    end

    describe "an address that bought the product twice" do
      # The free_purchase factory refuses a second purchase of the address, so both rows are built; the viewed one is created last.
      let(:purchase) do
        build(:purchase, link: product, purchaser: buyer, email: "buyer@example.com", ip_address: "203.0.113.9", purchase_state: "successful", price_cents: 500, total_transaction_cents: 500).tap { _1.save!(validate: false) }
      end

      def second_purchase(price_cents: 500)
        build(:purchase, link: product, email: "buyer@example.com", ip_address: "203.0.113.9", purchase_state: "successful", price_cents:, total_transaction_cents: price_cents).tap { _1.save!(validate: false) }
      end

      it "lists the posts emailed to either purchase, linked to the earlier one", parity: true do
        earlier = second_purchase
        first_post = post_for("Emailed to the first", published_at: 6.days.ago)
        second_post = post_for("Emailed to both", published_at: 5.days.ago)
        sent_to(first_post, earlier, sent_at: 5.days.ago)
        sent_to(second_post, earlier, sent_at: 4.days.ago)
        sent_to(second_post, purchase, sent_at: 3.days.ago)
        post_for("Profile update", send_emails: false, shown_on_profile: true, published_at: 2.days.ago)
        log_in(buyer)

        get url_redirect_download_page_path(token)

        posts = inertia_props_of(response).dig("content", "posts")
        expect(posts.map { |entry| entry["name"] }).to eq(["Profile update", "Emailed to both", "Emailed to both", "Emailed to the first"])
        expect(posts.map { |entry| entry["view_url"][/purchase_id=([^&]+)/, 1] }.uniq).to eq([CGI.escape(earlier.external_id)])
      end

      it "lists a seller post when only the other purchase passes its filters", parity: true do
        earlier = second_purchase(price_cents: 1_000)
        purchase.update_columns(price_cents: 300)
        news = create(:seller_installment, seller:, installment_type: "seller", name: "Big spenders", published_at: 6.days.ago, paid_more_than_cents: 800)
        sent_to(news, purchase, sent_at: 5.days.ago)
        log_in(buyer)

        get url_redirect_download_page_path(token)

        posts = inertia_props_of(response).dig("content", "posts")
        expect(posts.map { |entry| entry["name"] }).to eq(["Big spenders"])
        expect(posts.first["view_url"]).to include("purchase_id=#{CGI.escape(purchase.external_id)}")
        expect(earlier.id).to be < purchase.id
      end

      it "lists a seller post when only the viewed purchase passes its filters", parity: true do
        earlier = second_purchase(price_cents: 300)
        purchase.update_columns(price_cents: 1_000)
        news = create(:seller_installment, seller:, installment_type: "seller", name: "Big spenders again", published_at: 6.days.ago, paid_more_than_cents: 800)
        sent_to(news, purchase, sent_at: 5.days.ago)
        log_in(buyer)

        get url_redirect_download_page_path(token)

        posts = inertia_props_of(response).dig("content", "posts")
        expect(posts.map { |entry| entry["name"] }).to eq(["Big spenders again"])
        expect(posts.first["view_url"]).to include("purchase_id=#{CGI.escape(purchase.external_id)}")
        expect(earlier.id).to be < purchase.id
      end
    end

    describe "of a membership" do
      let(:membership_product) { create(:membership_product, user: seller, name: "Club", unique_permalink: "club") }
      let(:membership) { create(:membership_purchase, link: membership_product, purchaser: buyer, email: "buyer@example.com", ip_address: "203.0.113.9") }
      let(:membership_redirect) { create(:url_redirect, link: membership_product, purchase: membership) }

      def membership_post(name, published_at: 3.days.ago, **attributes)
        create(:installment, link: membership_product, seller:, installment_type: "product", name:, published_at:, **attributes)
      end

      it "lists the posts emailed to the membership", parity: true do
        older = membership_post("Older member update", published_at: 5.days.ago)
        newer = membership_post("Newer member update", published_at: 4.days.ago)
        create(:creator_contacting_customers_email_info_sent, installment: older, purchase: membership, sent_at: 5.days.ago)
        create(:creator_contacting_customers_email_info_sent, installment: newer, purchase: membership, sent_at: 3.days.ago)
        log_in(buyer)

        get url_redirect_download_page_path(membership_redirect.token)

        expect(response).to be_successful
        expect(inertia_props_of(response).dig("content", "posts").map { |entry| entry["name"] }).to eq(["Newer member update", "Older member update"])
        expect(inertia_props_of(response).dig("purchase", "membership")).to include("has_active_subscription" => true)
      end

      it "lists the posts of a deactivated membership while the product lets it keep its content", parity: true do
        membership_post("Member update", send_emails: false, shown_on_profile: true)
        membership.subscription.update_columns(deactivated_at: 1.day.ago, cancelled_at: 1.day.ago)
        log_in(buyer)

        get url_redirect_download_page_path(membership_redirect.token)

        expect(response).to be_successful
        expect(inertia_props_of(response).dig("content", "posts").map { |entry| entry["name"] }).to eq(["Member update"])
      end

      it "leaves out the posts emailed to another membership of the address that lost its content", parity: true do
        membership_product.update_columns(flags: membership_product.flags | Link.flag_mapping["flags"][:block_access_after_membership_cancellation])
        lapsed = create(:membership_purchase, link: membership_product, purchaser: buyer, email: "buyer@example.com")
        lapsed.subscription.update_columns(deactivated_at: 1.day.ago, cancelled_at: 1.day.ago)
        kept = membership_post("Kept update", published_at: 5.days.ago)
        lost = membership_post("Lost update", published_at: 4.days.ago)
        create(:creator_contacting_customers_email_info_sent, installment: kept, purchase: membership, sent_at: 5.days.ago)
        create(:creator_contacting_customers_email_info_sent, installment: lost, purchase: lapsed, sent_at: 3.days.ago)
        log_in(buyer)

        get url_redirect_download_page_path(membership_redirect.token)

        expect(response).to be_successful
        expect(inertia_props_of(response).dig("content", "posts").map { |entry| entry["name"] }).to eq(["Kept update"])
      end
    end

    it "hands a product that shows every past post to Rails", parity: true do
      product.update_columns(flags: product.flags | Link.flag_mapping["flags"][:should_show_all_posts])
      post_for("Update").tap { |update| sent_to(update) }
      log_in(buyer)

      get url_redirect_download_page_path(token)

      expect(response).to be_successful
    end
  end
end
