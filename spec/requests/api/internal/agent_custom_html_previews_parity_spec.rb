# frozen_string_literal: true

require "spec_helper"

# The store agent's custom HTML preview (Api::Internal::AgentCustomHtmlPreviewsController), recorded for the Next.js port (PARITY_RECORD=1)
# and replayed by nextjs/parity/__tests__/agent-custom-html-previews.replay.test.ts, which sends the last request of each example.
# Node answers the gates, every proposal the controller refuses before it sanitizes anything, GET #show (a Redis read) and the previews it can
# prove byte-equal: the examples that start "renders" post a proposal, then fetch the staged document, and the replay compares the document
# Node stages with the one Rails staged. The examples that start "hands a" are the proposals that stay in Rails: a page that references
# prices, a seller with products, a page that sanitizes to nothing, markup the sanitizer port cannot prove, a guarded undo.
describe "Agent custom HTML previews", type: :request, elasticsearch_wait_for_refresh: true do
  include Parity::AudienceSignedIn

  JSON_ACCEPT_PREVIEWS = { "Accept" => "application/json" }.freeze
  PREVIEWS_PATH = "/internal/agent/custom_html_preview"

  let(:seller) { create(:user, name: "Preview Seller") }
  let(:page_html) { "<section><h1>Old headline</h1><p>Keep me</p></section>" }

  before do
    host! DOMAIN
    Purchase.__elasticsearch__.create_index!(force: true)
    $redis.flushdb
  end

  # User#eligible_for_store_agent?: a completed payout and $100 of sales in the purchases index.
  def earn_access(user)
    create(:payment_completed, user:)
    product = create(:product, user:, name: "Earner", unique_permalink: "earner", created_at: Time.utc(2025, 1, 1))
    build(:purchase, link: product, seller: user, price_cents: 20_000).tap { |row| row.save!(validate: false) }
    # The sales stay; the product no longer lists on the profile, which is the seller Node can preview (Pages::ProfileData lists live products).
    product.update_columns(deleted_at: Time.utc(2025, 2, 1))
    index_model_records(Purchase)
  end

  def ready_seller(html: nil)
    earn_access(seller)
    Feature.activate_user(:custom_html_pages, seller)
    if html
      seller.custom_html = html
      seller.save!
    end
    log_in(seller)
  end

  # The staged document, fetched the way the confirmation card's iframe does. The recording keeps it in the exchange that follows the POST.
  def fetch_staged_preview
    expect(response.parsed_body["success"]).to be(true)
    expect(response.parsed_body["preview_url"]).to match(%r{\A/internal/agent/custom_html_previews/[A-Za-z0-9_-]{32}\z})
    get response.parsed_body["preview_url"]
    expect(response).to have_http_status(:ok)
  end

  def post_preview(params) = post(PREVIEWS_PATH, params: params.to_json, headers: JSON_ACCEPT_PREVIEWS.merge("X-CSRF-Token" => csrf_token, "Content-Type" => "application/json"))

  describe "POST /internal/agent/custom_html_preview" do
    it "answers 404 JSON to a visitor who is signed out", parity: true do
      post_preview(endpoint: "update_user_custom_html", custom_html: "<p>Hi</p>")

      expect(response).to have_http_status(:not_found)
    end

    it "answers 401 JSON to a seller who has not earned the agent", parity: true do
      log_in(seller)

      post_preview(endpoint: "update_user_custom_html", custom_html: "<p>Hi</p>")

      expect(response).to have_http_status(:unauthorized)
    end

    it "answers 401 JSON to a support team member", parity: true do
      earn_access(seller)
      member = create(:user, name: "Support Member")
      membership = create(:team_membership, user: member, seller:, role: TeamMembership::ROLE_SUPPORT)
      log_in(member)
      switch_to(membership)

      post_preview(endpoint: "update_user_custom_html", custom_html: "<p>Hi</p>")

      expect(response).to have_http_status(:unauthorized)
    end

    it "renders an error when the custom_html_pages feature is off", parity: true do
      earn_access(seller)
      log_in(seller)

      post_preview(endpoint: "update_user_custom_html", custom_html: "<p>Hi</p>")

      expect(response.parsed_body).to eq("success" => false, "error" => "Custom HTML pages are not enabled on this account.")
    end

    it "renders an error for a write that has no page preview", parity: true do
      ready_seller

      post_preview(endpoint: "create_offer_code")

      expect(response.parsed_body).to eq("success" => false, "error" => "This change doesn't have a page preview.")
    end

    it "renders an error when the endpoint is missing", parity: true do
      ready_seller

      post_preview({})

      expect(response.parsed_body).to eq("success" => false, "error" => "This change doesn't have a page preview.")
    end

    describe "update_user_custom_html" do
      it "renders an error when the custom_html key is missing", parity: true do
        ready_seller

        post_preview(endpoint: "update_user_custom_html")

        expect(response.parsed_body).to eq("success" => false, "error" => "The proposed update is missing its custom_html value.")
      end

      it "renders an error when custom_html is a number", parity: true do
        ready_seller

        post_preview(endpoint: "update_user_custom_html", custom_html: 5)

        expect(response.parsed_body).to eq("success" => false, "error" => "custom_html must be a string.")
      end

      it "renders an error when custom_html is a boolean", parity: true do
        ready_seller

        post_preview(endpoint: "update_user_custom_html", custom_html: true)

        expect(response.parsed_body).to eq("success" => false, "error" => "custom_html must be a string.")
      end

      it "renders an error when custom_html is longer than a page may be", parity: true do
        ready_seller

        post_preview(endpoint: "update_user_custom_html", custom_html: "a" * (Page::MAX_CUSTOM_HTML_LENGTH + 1))

        expect(response.parsed_body).to eq("success" => false, "error" => "The edited page would be too long (maximum is 500000 characters).")
      end

      it "renders a proposed page", parity: true do
        ready_seller

        post_preview(endpoint: "update_user_custom_html", custom_html: "<section><h1>New page</h1></section>")

        fetch_staged_preview
      end

      it "renders a page with the markup the sanitizer removes", parity: true do
        ready_seller

        post_preview(endpoint: "update_user_custom_html", custom_html: <<~HTML)
          <!DOCTYPE html><html lang="en"><head><title>t</title><meta http-equiv="refresh" content="0"><style>p { color: red }</style></head>
          <body onload="x()"><iframe src="https://example.com/embed"></iframe><script src="https://evil.example.com/x.js"></script>
          <script src="https://cdn.jsdelivr.net/npm/x"></script><form action="https://evil.example.com"><input name="a" disabled></form>
          <a href="javascript:alert(1)" target="_blank">x</a><img src="data:image/png;base64,AAAA" srcset="a.png 1x, javascript:1 2x" onerror="y()" data-x="1">
          <svg viewBox="0 0 1 1"><path d="M0 0" fill="red"/><script>1</script></svg><marquee>old</marquee><!-- kept --></body></html>
        HTML

        fetch_staged_preview
      end

      it "renders a page that fills the seller's name and bio", parity: true do
        seller.update!(bio: "I make <things> & \"stuff\"")
        ready_seller

        post_preview(endpoint: "update_user_custom_html", custom_html: '<h1 data-gumroad-field="name">n</h1><p data-gumroad-field="bio">b</p><span data-gumroad-field="mystery">keep</span>')

        fetch_staged_preview
      end

      it "renders a page that loads Tailwind v3", parity: true do
        ready_seller

        post_preview(endpoint: "update_user_custom_html", custom_html: '<script src="https://cdn.tailwindcss.com"></script><div class="bg-gradient-to-r from-red-500">x</div>')

        fetch_staged_preview
      end

      it "renders a page for a seller whose profile has tabs", parity: true do
        ready_seller
        SellerProfile.new(seller:, json_data: { "tabs" => [{ "name" => "Home", "sections" => [] }, { "name" => "Q&A <b>", "sections" => [] }] }).save!(validate: false)

        post_preview(endpoint: "update_user_custom_html", custom_html: "<p>Tabs</p>")

        fetch_staged_preview
      end

      it "renders a page for a seller whose only extra product was deleted", parity: true do
        ready_seller
        create(:product, user: seller, name: "Gone", unique_permalink: "gone").update_columns(deleted_at: Time.utc(2025, 2, 1))

        post_preview(endpoint: "update_user_custom_html", custom_html: "<p>No products</p>")

        fetch_staged_preview
      end

      it "hands a page that references prices to Rails", parity: true do
        ready_seller

        post_preview(endpoint: "update_user_custom_html", custom_html: '<span data-gumroad-product="earner" data-gumroad-field="price">0</span>')

        expect(response.parsed_body["success"]).to be(true)
      end

      it "hands a page that reads the prices blob to Rails", parity: true do
        ready_seller

        post_preview(endpoint: "update_user_custom_html", custom_html: '<script>var p = document.getElementById("gumroad-prices")</script>')

        expect(response.parsed_body["success"]).to be(true)
      end

      it "hands a page for a seller who lists a post to Rails", parity: true do
        ready_seller
        create(:audience_installment, seller:, name: "News", published_at: 1.day.ago, shown_on_profile: true)

        post_preview(endpoint: "update_user_custom_html", custom_html: "<p>Has posts</p>")

        expect(response.parsed_body["success"]).to be(true)
      end

      it "hands a page that sanitizes to nothing to Rails", parity: true do
        ready_seller

        post_preview(endpoint: "update_user_custom_html", custom_html: '<iframe src="https://example.com"></iframe><marquee></marquee>')

        expect(response.parsed_body["success"]).to be(true)
      end

      it "hands a page with an xml:lang attribute to Rails", parity: true do
        ready_seller

        post_preview(endpoint: "update_user_custom_html", custom_html: '<div xml:lang="en" lang="en">x</div>')

        expect(response.parsed_body["success"]).to be(true)
      end

      it "hands a page with a script URL the port cannot read to Rails", parity: true do
        ready_seller

        post_preview(endpoint: "update_user_custom_html", custom_html: '<script src="https://[cdn.jsdelivr.net]/x.js"></script><p>x</p>')

        expect(response.parsed_body["success"]).to be(true)
      end

      it "hands a proposal that clears the page to Rails", parity: true do
        ready_seller

        post_preview(endpoint: "update_user_custom_html", custom_html: "  ")

        expect(response.parsed_body["success"]).to be(true)
      end

      it "hands a null custom_html to Rails", parity: true do
        ready_seller

        post_preview(endpoint: "update_user_custom_html", custom_html: nil)

        expect(response.parsed_body["success"]).to be(true)
      end
    end

    describe "edit_user_custom_html" do
      it "renders an error when find is missing", parity: true do
        ready_seller(html: page_html)

        post_preview(endpoint: "edit_user_custom_html", replace: "<h1>New</h1>")

        expect(response.parsed_body).to eq("success" => false, "error" => "The proposed edit is missing the snippet to replace.")
      end

      it "renders an error when find is blank", parity: true do
        ready_seller(html: page_html)

        post_preview(endpoint: "edit_user_custom_html", find: "", replace: "<h1>New</h1>")

        expect(response.parsed_body).to eq("success" => false, "error" => "The proposed edit is missing the snippet to replace.")
      end

      it "renders an error when find is not a string", parity: true do
        ready_seller(html: page_html)

        post_preview(endpoint: "edit_user_custom_html", find: 7, replace: "<h1>New</h1>")

        expect(response.parsed_body).to eq("success" => false, "error" => "The proposed edit is missing the snippet to replace.")
      end

      it "renders an error when replace is missing", parity: true do
        ready_seller(html: page_html)

        post_preview(endpoint: "edit_user_custom_html", find: "<h1>Old headline</h1>")

        expect(response.parsed_body).to eq("success" => false, "error" => "The proposed edit is missing the replacement text.")
      end

      it "renders an error when there is no page to edit", parity: true do
        ready_seller

        post_preview(endpoint: "edit_user_custom_html", find: "<h1>Old headline</h1>", replace: "<h1>New</h1>")

        expect(response.parsed_body).to eq("success" => false, "error" => "There is no custom HTML page to edit.")
      end

      it "renders an error when the snippet no longer appears in the page", parity: true do
        ready_seller(html: page_html)

        post_preview(endpoint: "edit_user_custom_html", find: "<h2>Gone</h2>", replace: "<h2>New</h2>")

        expect(response.parsed_body).to eq("success" => false, "error" => "The snippet to replace no longer appears in the current page.")
      end

      it "renders an error when the snippet matches more than once", parity: true do
        ready_seller(html: "<p>Same</p><p>Same</p>")

        post_preview(endpoint: "edit_user_custom_html", find: "<p>Same</p>", replace: "<p>New</p>")

        expect(response.parsed_body).to eq("success" => false, "error" => "The snippet to replace matches 2 places in the current page.")
      end

      it "renders an error when a whitespace-tolerant snippet matches more than once", parity: true do
        ready_seller(html: "<p>Same  words</p>\n<p>Same\twords</p>")

        post_preview(endpoint: "edit_user_custom_html", find: "<p>Same words</p>", replace: "<p>New</p>")

        expect(response.parsed_body).to eq("success" => false, "error" => "The snippet to replace matches 2 places in the current page.")
      end

      it "renders an error when the edited page would be too long", parity: true do
        ready_seller(html: "<p>x</p>#{"a" * (Page::MAX_CUSTOM_HTML_LENGTH - 20)}")

        post_preview(endpoint: "edit_user_custom_html", find: "<p>x</p>", replace: "<p>" + ("y" * 40) + "</p>")

        expect(response.parsed_body).to eq("success" => false, "error" => "The edited page would be too long (maximum is 500000 characters).")
      end

      it "renders an edit that matches once", parity: true do
        ready_seller(html: page_html)

        post_preview(endpoint: "edit_user_custom_html", find: "<h1>Old headline</h1>", replace: "<h1>New headline</h1>")

        fetch_staged_preview
      end


      it "renders an edit that lands inside an attribute without the scroll marker", parity: true do
        ready_seller(html: '<div class="old">x</div><p>after</p>')

        post_preview(endpoint: "edit_user_custom_html", find: "old", replace: "new")

        fetch_staged_preview
      end

      it "renders an edit whose replacement holds the marker text without the scroll marker", parity: true do
        ready_seller(html: "<p>one</p><p>two</p>")

        post_preview(endpoint: "edit_user_custom_html", find: "<p>two</p>", replace: "<!--gumroad-preview-changed--><p>2</p>")

        fetch_staged_preview
      end

      it "renders an edit the sanitizer changes", parity: true do
        ready_seller(html: "<p>one</p><div>two</div>")

        post_preview(endpoint: "edit_user_custom_html", find: "<div>two</div>", replace: '<div onclick="x()"><iframe src="https://example.com"></iframe>2</div>')

        fetch_staged_preview
      end

      it "hands an edit that sanitizes the page to nothing to Rails", parity: true do
        ready_seller(html: "<p>one</p>")

        post_preview(endpoint: "edit_user_custom_html", find: "<p>one</p>", replace: '<iframe src="https://example.com"></iframe>')

        expect(response.parsed_body["success"]).to be(true)
      end

      it "renders an edit whose snippet differs from the page only in whitespace", parity: true do
        ready_seller(html: "<p>Keep me</p>")

        post_preview(endpoint: "edit_user_custom_html", find: "<p>Keep me</p>", replace: "<p>Changed</p>")

        fetch_staged_preview
      end

      it "hands a guarded undo to Rails", parity: true do
        ready_seller(html: page_html)
        current_page = seller.reload.custom_html
        find = "<h1>Old headline</h1>"
        replace = "<h1>New headline</h1>"

        post_preview(
          endpoint: "edit_user_custom_html", find:, replace:,
          expected_custom_html_sha256: Digest::SHA256.hexdigest(current_page),
          result_custom_html_sha256: Digest::SHA256.hexdigest(Ai::PageSanitizer.sanitize_with_report(current_page.sub(find) { replace }).html.to_s),
        )

        expect(response.parsed_body).to include("success" => true)
      end
    end
  end

  describe "GET /internal/agent/custom_html_previews/:token" do
    let(:token) { "staged-token-0123456789" }
    let(:document) { "<!doctype html><html><body><h1>Staged</h1><script>window.ran = true</script></body></html>" }

    def stage(seller_id: seller.id, html: document)
      $redis.set(RedisKey.agent_custom_html_preview(seller_id, token), html, ex: 24.hours.to_i)
    end

    it "redirects a visitor who is signed out to the login page", parity: true do
      get "/internal/agent/custom_html_previews/#{token}"

      expect(response).to have_http_status(:found)
      expect(response.location).to end_with("/login?next=%2Finternal%2Fagent%2Fcustom_html_previews%2F#{token}")
    end

    it "redirects a seller who has not earned the agent to the dashboard", parity: true do
      log_in(seller)

      get "/internal/agent/custom_html_previews/#{token}"

      expect(response).to have_http_status(:found)
    end

    it "serves the staged document with the custom page policy", parity: true do
      earn_access(seller)
      log_in(seller)
      stage

      get "/internal/agent/custom_html_previews/#{token}"

      expect(response).to have_http_status(:ok)
      expect(response.body).to eq(document)
      expect(response.headers["Content-Security-Policy"]).to eq(RendersCustomHtmlPages::CUSTOM_HTML_CSP)
    end

    it "serves a staged document that holds multibyte text", parity: true do
      earn_access(seller)
      log_in(seller)
      stage(html: "<!doctype html><p>Café ☃ \u{1F600}</p>")

      get "/internal/agent/custom_html_previews/#{token}"

      expect(response).to have_http_status(:ok)
    end

    it "renders the expired notice for a token nobody staged", parity: true do
      earn_access(seller)
      log_in(seller)

      get "/internal/agent/custom_html_previews/unknown-token"

      expect(response).to have_http_status(:not_found)
      expect(response.body).to include("This preview has expired.")
    end

    it "renders the expired notice for a document staged for another seller", parity: true do
      earn_access(seller)
      log_in(seller)
      stage(seller_id: create(:user).id)

      get "/internal/agent/custom_html_previews/#{token}"

      expect(response).to have_http_status(:not_found)
      expect(response.body).not_to include("Staged")
    end
  end
end
