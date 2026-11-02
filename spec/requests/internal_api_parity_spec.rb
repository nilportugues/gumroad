# frozen_string_literal: true

require "spec_helper"

# Api::Internal::* endpoints, recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/internal-api.replay.test.ts, which sends the last request of each example. Examples whose
# name starts "hands a" are requests the port hands back to Rails: the replay asserts Rails receives them untouched.
describe "Internal API", type: :request, elasticsearch_wait_for_refresh: true do
  include Parity::AudienceSignedIn

  JSON_ACCEPT = { "Accept" => "application/json" }.freeze

  let(:seller) { create(:user, name: "Internal Seller", is_team_member: true) }
  let(:product) { create(:product, user: seller, name: "Alpha", unique_permalink: "alpha", created_at: Time.utc(2025, 1, 1)) }

  before do
    Rails.cache.clear
    AudienceMember.__elasticsearch__.create_index!(force: true)
  end

  describe "on the API host" do
    let(:application) { create(:oauth_application, owner: create(:user)) }

    before { host! API_DOMAIN }

    def token_for(scopes) = create("doorkeeper/access_token", application:, resource_owner_id: seller.id, scopes:)

    def bearer(token) = { "Authorization" => "Bearer #{token.token}" }

    describe "GET /internal/mobile_minimum_version" do
      it "refuses a request without a token", parity: true do
        get "/internal/mobile_minimum_version"

        expect(response).to have_http_status(:unauthorized)
      end

      it "forbids a token without the mobile scope", parity: true do
        get "/internal/mobile_minimum_version", headers: bearer(token_for("view_public"))

        expect(response).to have_http_status(:forbidden)
      end

      it "answers null versions when none is set", parity: true do
        get "/internal/mobile_minimum_version", headers: bearer(token_for("mobile_api"))

        expect(response.parsed_body).to eq("minimum_version" => nil, "minimum_update_created_at" => nil)
      end

      it "answers the stored versions to a token with the account scope", parity: true do
        $redis.set(RedisKey.mobile_minimum_version, "1.2.3")
        $redis.set(RedisKey.mobile_minimum_update_created_at, "2025-01-02T03:04:05Z")

        get "/internal/mobile_minimum_version", headers: bearer(token_for("account"))

        expect(response.parsed_body).to eq("minimum_version" => "1.2.3", "minimum_update_created_at" => "2025-01-02T03:04:05Z")
      end
    end

    describe "GET /internal/home_page_numbers" do
      it "renders a blank figure when the payout is unset", parity: true do
        get "/internal/home_page_numbers"

        expect(response.parsed_body).to eq("prev_week_payout_usd" => "$")
      end

      it "groups the stored payout by thousands", parity: true do
        $redis.set(RedisKey.prev_week_payout_usd, "1234567")

        get "/internal/home_page_numbers"

        expect(response.parsed_body).to eq("prev_week_payout_usd" => "$1,234,567")
      end

      it "keeps the decimals of a stored payout", parity: true do
        $redis.set(RedisKey.prev_week_payout_usd, "1234.5")

        get "/internal/home_page_numbers"

        expect(response.parsed_body).to eq("prev_week_payout_usd" => "$1,234.5")
      end

      it "leaves a payout that is not a number as it is", parity: true do
        $redis.set(RedisKey.prev_week_payout_usd, "n/a")

        get "/internal/home_page_numbers"

        expect(response.parsed_body).to eq("prev_week_payout_usd" => "$n/a")
      end
    end

    describe "POST /internal/grmc/webhook" do
      let(:body) { { job_id: "job-1", status: "success", nested: { ids: [1, 2] } }.to_json }

      def signature(payload, timestamp: (Time.current.to_f * 1000).to_i, secret: GlobalConfig.get("GRMC_WEBHOOK_SECRET"))
        "t=#{timestamp},v0=#{OpenSSL::HMAC.hexdigest("sha256", secret, payload)}"
      end

      def deliver(payload, header, content_type: "application/json")
        post "/internal/grmc/webhook", params: payload, headers: { "Content-Type" => content_type, "Grmc-Signature" => header }
      end

      it "enqueues the callback job for a signed notification", parity: true do
        deliver(body, signature(body))

        expect(response).to have_http_status(:ok)
      end

      it "refuses a wrong signature", parity: true do
        deliver(body, signature(body, secret: "another-secret"))

        expect(response).to have_http_status(:unauthorized)
        expect(response.parsed_body).to eq("success" => false, "message" => "invalid timestamp or signature")
      end

      it "refuses a stale timestamp", parity: true do
        deliver(body, signature(body, timestamp: ((Time.current.to_f - 3600) * 1000).to_i))

        expect(response).to have_http_status(:unauthorized)
      end

      it "refuses a request without the signature header", parity: true do
        deliver(body, "")

        expect(response).to have_http_status(:unauthorized)
      end

      it "refuses a header that only carries the v0 part", parity: true do
        deliver(body, "v0=#{OpenSSL::HMAC.hexdigest("sha256", GlobalConfig.get("GRMC_WEBHOOK_SECRET"), body)}")

        expect(response).to have_http_status(:unauthorized)
      end

      it "hands a notification with a float to Rails", parity: true do
        floats = { job_id: "job-2", status: "success", progress: 0.5 }.to_json
        deliver(floats, signature(floats))

        expect(response).to have_http_status(:ok)
      end
    end
  end

  describe "when signed in" do
    before { host! DOMAIN }

    def audience_member(**attributes) = create(:audience_member, seller:, **attributes)

    def seed_audience
      audience_member(purchases: [{ product_id: product.id, price_cents: 500, country: "United States" }])
      audience_member(purchases: [{ product_id: product.id, price_cents: 100, country: "Canada" }])
      audience_member(follower: { id: 1 })
      index_model_records(AudienceMember)
    end

    # Engagement items outlive the example, and installment ids repeat from one run to the next.
    def post_for(**attributes)
      create(:installment, seller:, link: nil, installment_type: "audience", name: "Post", message: "<p>Body</p>", **attributes).tap do |installment|
        client = EmailEngagementDynamoStore.client
        client.query(table_name: EmailEngagementDynamoStore.table_name, key_condition_expression: "pk = :pk", expression_attribute_values: { ":pk" => installment.id.to_s })
          .items.each { |item| client.delete_item(table_name: EmailEngagementDynamoStore.table_name, key: item.slice("pk", "sk")) }
      end
    end

    describe "GET /internal/installments/:id/audience_count" do
      it "counts the whole audience for a post without filters", parity: true do
        seed_audience
        installment = post_for
        log_in(seller)

        get "/internal/installments/#{installment.external_id}/audience_count", headers: JSON_ACCEPT

        expect(response.parsed_body).to eq("count" => 3)
      end

      it "counts the customers a seller post filters by price", parity: true do
        seed_audience
        installment = post_for(installment_type: "seller", paid_more_than_cents: 300)
        log_in(seller)

        get "/internal/installments/#{installment.external_id}/audience_count", headers: JSON_ACCEPT

        expect(response.parsed_body).to eq("count" => 1)
      end

      it "answers 404 JSON for a post of another seller", parity: true do
        other = create(:installment, seller: create(:user), link: nil, installment_type: "audience")
        log_in(seller)

        get "/internal/installments/#{other.external_id}/audience_count", headers: JSON_ACCEPT

        expect(response).to have_http_status(:not_found)
        expect(response.parsed_body).to eq("success" => false, "error" => "Not found")
      end

      it "answers 404 JSON for a deleted post", parity: true do
        installment = post_for(deleted_at: Time.utc(2025, 1, 2))
        log_in(seller)

        get "/internal/installments/#{installment.external_id}/audience_count", headers: JSON_ACCEPT

        expect(response).to have_http_status(:not_found)
      end

      it "answers 404 JSON for an id that does not decode", parity: true do
        log_in(seller)

        get "/internal/installments/not-an-id/audience_count", headers: JSON_ACCEPT

        expect(response).to have_http_status(:not_found)
      end

      it "answers 401 JSON to a support team member", parity: true do
        installment = post_for
        member = create(:user, name: "Support Member")
        membership = create(:team_membership, user: member, seller:, role: TeamMembership::ROLE_SUPPORT)
        log_in(member)
        switch_to(membership)

        get "/internal/installments/#{installment.external_id}/audience_count", headers: JSON_ACCEPT

        expect(response).to have_http_status(:unauthorized)
        expect(response.parsed_body["error"]).to eq("Your current role as Support cannot perform this action.")
      end

      it "lets a marketing team member count", parity: true do
        seed_audience
        installment = post_for
        member = create(:user, name: "Marketing Member")
        membership = create(:team_membership, user: member, seller:, role: TeamMembership::ROLE_MARKETING)
        log_in(member)
        switch_to(membership)

        get "/internal/installments/#{installment.external_id}/audience_count", headers: JSON_ACCEPT

        expect(response.parsed_body).to eq("count" => 3)
      end

      it "answers 404 JSON to a signed-out visitor", parity: true do
        installment = post_for

        get "/internal/installments/#{installment.external_id}/audience_count", headers: JSON_ACCEPT

        expect(response).to have_http_status(:not_found)
      end

      it "hands a post that excludes buyers who clicked another post to Rails", parity: true do
        earlier = post_for(name: "Earlier")
        installment = post_for(not_clicked_post_id: earlier.external_id)
        log_in(seller)

        get "/internal/installments/#{installment.external_id}/audience_count", headers: JSON_ACCEPT

        expect(response).to have_http_status(:ok)
      end
    end

    describe "GET /internal/installments/recipient_count" do
      it "counts the audience and the recipients of the unsaved filters", parity: true do
        seed_audience
        log_in(seller)

        get "/internal/installments/recipient_count", params: { installment_type: "seller", paid_more_than_cents: "300" }, headers: JSON_ACCEPT

        expect(response.parsed_body).to eq("audience_count" => 3, "recipient_count" => 1)
      end

      it "counts every audience member without filters", parity: true do
        seed_audience
        log_in(seller)

        get "/internal/installments/recipient_count", headers: JSON_ACCEPT

        expect(response.parsed_body).to eq("audience_count" => 3, "recipient_count" => 3)
      end

      it "filters by product and country", parity: true do
        seed_audience
        log_in(seller)

        get "/internal/installments/recipient_count", params: { installment_type: "product", bought_products: [product.unique_permalink], bought_from: "Canada" }, headers: JSON_ACCEPT

        expect(response.parsed_body).to eq("audience_count" => 3, "recipient_count" => 1)
      end

      it "counts followers", parity: true do
        seed_audience
        log_in(seller)

        get "/internal/installments/recipient_count", params: { installment_type: "follower" }, headers: JSON_ACCEPT

        expect(response.parsed_body["recipient_count"]).to eq(1)
      end

      it "ignores a filter that is not text", parity: true do
        seed_audience
        log_in(seller)

        get "/internal/installments/recipient_count", params: { installment_type: "seller", paid_more_than_cents: { gt: "300" } }, headers: JSON_ACCEPT

        expect(response.parsed_body).to eq("audience_count" => 3, "recipient_count" => 2)
      end

      it "answers 401 JSON to a support team member", parity: true do
        member = create(:user, name: "Support Member")
        membership = create(:team_membership, user: member, seller:, role: TeamMembership::ROLE_SUPPORT)
        log_in(member)
        switch_to(membership)

        get "/internal/installments/recipient_count", headers: JSON_ACCEPT

        expect(response).to have_http_status(:unauthorized)
      end

      it "hands a cents filter that is not digits to Rails", parity: true do
        seed_audience
        log_in(seller)

        get "/internal/installments/recipient_count", params: { installment_type: "seller", paid_more_than_cents: "3e2" }, headers: JSON_ACCEPT

        expect(response).to have_http_status(:ok)
      end
    end

    describe "GET /internal/installments/:id/clicked_urls" do
      def put_url_click(installment, url, count)
        digest = Digest::SHA256.hexdigest(url)
        EmailEngagementDynamoStore.client.put_item(
          table_name: EmailEngagementDynamoStore.table_name,
          item: { "pk" => installment.id.to_s, "sk" => "URL##{digest}", "click_url" => url, "click_count" => count }
        )
      end

      it "lists the clicked URLs by count", parity: true do
        installment = post_for
        put_url_click(installment, "https://example.com/a", 2)
        put_url_click(installment, "http://www.example.com/b", 5)
        put_url_click(installment, EmailEventInfo::VIEW_ATTACHMENTS_URL, 3)
        log_in(seller)

        get "/internal/installments/#{installment.external_id}/clicked_urls", headers: JSON_ACCEPT

        expect(response.parsed_body).to eq("clicked_urls" => [{ "url" => "example.com/b", "count" => 5 }, { "url" => "View content", "count" => 3 }, { "url" => "example.com/a", "count" => 2 }])
      end

      it "sums stored URLs that display the same", parity: true do
        installment = post_for
        put_url_click(installment, "https://example.com/a", 2)
        put_url_click(installment, "http://www.example.com/a", 1)
        log_in(seller)

        get "/internal/installments/#{installment.external_id}/clicked_urls", headers: JSON_ACCEPT

        expect(response.parsed_body).to eq("clicked_urls" => [{ "url" => "example.com/a", "count" => 3 }])
      end

      it "lists nothing for a post without clicks", parity: true do
        installment = post_for
        log_in(seller)

        get "/internal/installments/#{installment.external_id}/clicked_urls", headers: JSON_ACCEPT

        expect(response.parsed_body).to eq("clicked_urls" => [])
      end

      it "hands a list of URLs with equal counts to Rails", parity: true do
        installment = post_for
        put_url_click(installment, "https://example.com/a", 2)
        put_url_click(installment, "https://example.com/b", 2)
        log_in(seller)

        get "/internal/installments/#{installment.external_id}/clicked_urls", headers: JSON_ACCEPT

        expect(response).to have_http_status(:ok)
      end

      it "lets an accountant read the clicks", parity: true do
        installment = post_for
        put_url_click(installment, "https://example.com/a", 2)
        member = create(:user, name: "Accountant Member")
        membership = create(:team_membership, user: member, seller:, role: TeamMembership::ROLE_ACCOUNTANT)
        log_in(member)
        switch_to(membership)

        get "/internal/installments/#{installment.external_id}/clicked_urls", headers: JSON_ACCEPT

        expect(response.parsed_body["clicked_urls"].size).to eq(1)
      end

      it "answers 404 JSON for a post of another seller", parity: true do
        other = create(:installment, seller: create(:user), link: nil, installment_type: "audience")
        log_in(seller)

        get "/internal/installments/#{other.external_id}/clicked_urls", headers: JSON_ACCEPT

        expect(response).to have_http_status(:not_found)
      end
    end

    describe "GET /internal/products/:product_id/product_posts" do
      let(:seller) { create(:user, name: "Posting Seller", username: "poster") }
      let(:other_product) { create(:product, user: seller, name: "Beta", unique_permalink: "beta", created_at: Time.utc(2025, 1, 1)) }

      def published_post(name, at, **attributes)
        create(:installment, seller:, link: nil, installment_type: "seller", name:, message: "<p>#{name}</p>", slug: name.parameterize, published_at: at, send_emails: true, **attributes)
      end

      it "lists the posts a buyer of the product receives, newest first", parity: true do
        product
        published_post("Everyone older", Time.utc(2025, 1, 10))
        published_post("Everyone newer", Time.utc(2025, 2, 10))
        published_post("Alpha only", Time.utc(2025, 1, 20), installment_type: "product", link: product, bought_products: [product.unique_permalink])
        published_post("Beta only", Time.utc(2025, 1, 25), bought_products: [other_product.unique_permalink])
        log_in(seller)

        get "/internal/products/#{product.unique_permalink}/product_posts", headers: JSON_ACCEPT

        expect(response.parsed_body["posts"].map { _1["name"] }).to eq(["Everyone newer", "Alpha only", "Everyone older"])
        expect(response.parsed_body["total"]).to eq(3)
      end

      it "leaves out drafts, deleted posts and single recipient emails", parity: true do
        product
        published_post("Visible", Time.utc(2025, 1, 10))
        published_post("Draft", nil)
        published_post("Deleted", Time.utc(2025, 1, 11), deleted_at: Time.utc(2025, 1, 12))
        published_post("Single", Time.utc(2025, 1, 12), single_recipient_email: true)
        log_in(seller)

        get "/internal/products/#{product.unique_permalink}/product_posts", headers: JSON_ACCEPT

        expect(response.parsed_body["posts"].map { _1["name"] }).to eq(["Visible"])
      end

      it "narrows the list to a variant", parity: true do
        product
        variant = create(:variant, variant_category: create(:variant_category, link: product, title: "Tier"), name: "Gold")
        other_variant = create(:variant, variant_category: create(:variant_category, link: product, title: "Size"), name: "Large")
        published_post("Everyone", Time.utc(2025, 1, 10))
        published_post("Gold", Time.utc(2025, 1, 11), installment_type: "variant", link: product, bought_variants: [variant.external_id])
        published_post("Large", Time.utc(2025, 1, 12), installment_type: "variant", link: product, bought_variants: [other_variant.external_id])
        log_in(seller)

        get "/internal/products/#{product.unique_permalink}/product_posts", params: { variant_id: variant.external_id }, headers: JSON_ACCEPT

        expect(response.parsed_body["posts"].map { _1["name"] }).to eq(["Gold", "Everyone"])
      end

      it "puts workflow emails first, described by their delay", parity: true do
        product
        published_post("Plain", Time.utc(2025, 1, 10))
        workflow = create(:product_workflow, seller:, link: product)
        early = create(:workflow_installment, workflow:, seller:, link: product, published_at: Time.utc(2025, 1, 5), name: "Early", slug: "early")
        late = create(:workflow_installment, workflow:, seller:, link: product, published_at: Time.utc(2025, 1, 6), name: "Late", slug: "late")
        early.installment_rule.update!(delayed_delivery_time: 1.day.to_i, time_period: "day")
        late.installment_rule.update!(delayed_delivery_time: 3.days.to_i, time_period: "day")
        log_in(seller)

        get "/internal/products/#{product.unique_permalink}/product_posts", headers: JSON_ACCEPT

        expect(response.parsed_body["posts"].map { _1["name"] }).to eq(["Late", "Early", "Plain"])
        expect(response.parsed_body["posts"].first["date"]).to eq("type" => "workflow_email_rule", "time_duration" => 3, "time_period" => "day")
      end

      it "writes a post without a slug as null", parity: true do
        product
        published_post("Slugless", Time.utc(2025, 1, 10)).update_columns(slug: nil)
        log_in(seller)

        get "/internal/products/#{product.unique_permalink}/product_posts", headers: JSON_ACCEPT

        expect(response.parsed_body["posts"].first["url"]).to be_nil
      end

      it "pages the list ten at a time", parity: true do
        product
        12.times { |index| published_post("Post #{index}", Time.utc(2025, 1, 1) + index.days) }
        log_in(seller)

        get "/internal/products/#{product.unique_permalink}/product_posts", params: { page: "2" }, headers: JSON_ACCEPT

        expect(response.parsed_body["posts"].size).to eq(2)
        expect(response.parsed_body["next_page"]).to be_nil
        expect(response.parsed_body["total"]).to eq(12)
      end

      it "points to the next page", parity: true do
        product
        12.times { |index| published_post("Post #{index}", Time.utc(2025, 1, 1) + index.days) }
        log_in(seller)

        get "/internal/products/#{product.unique_permalink}/product_posts", headers: JSON_ACCEPT

        expect(response.parsed_body["next_page"]).to eq(2)
      end

      it "hands a pair of posts that share a sort key to Rails", parity: true do
        product
        published_post("Twin one", Time.utc(2025, 1, 10))
        published_post("Twin two", Time.utc(2025, 1, 10))
        log_in(seller)

        get "/internal/products/#{product.unique_permalink}/product_posts", headers: JSON_ACCEPT

        expect(response).to have_http_status(:ok)
      end

      it "answers 404 for another seller's product", parity: true do
        theirs = create(:product, user: create(:user), unique_permalink: "theirs")
        log_in(seller)

        get "/internal/products/#{theirs.unique_permalink}/product_posts", headers: JSON_ACCEPT

        expect(response).to have_http_status(:not_found)
      end

      it "answers 404 for a product that does not exist", parity: true do
        log_in(seller)

        get "/internal/products/nothing/product_posts", headers: JSON_ACCEPT

        expect(response).to have_http_status(:not_found)
      end

      it "answers 404 JSON to a signed-out visitor", parity: true do
        product

        get "/internal/products/#{product.unique_permalink}/product_posts", headers: JSON_ACCEPT

        expect(response).to have_http_status(:not_found)
      end
    end

    describe "POST /internal/installments/:id/non_opener_resend" do
      let(:installment) { create(:installment, seller:, link: nil, installment_type: "seller", name: "Sent post", message: "<p>Body</p>", published_at: Time.utc(2025, 1, 1), send_emails: true) }

      def resend(record, headers: {})
        post "/internal/installments/#{record.external_id}/non_opener_resend", headers: JSON_ACCEPT.merge("X-CSRF-Token" => csrf_token).merge(headers)
      end

      def blast_for(record, **attributes)
        create(:post_email_blast, post: record, seller:, recipient_filter: "unopened", **attributes)
      end

      it "queues a resend to the people who have not opened the post", parity: true do
        log_in(seller)

        resend(installment)

        expect(response.parsed_body).to eq("success" => true)
        expect(installment.blasts.to_non_openers.count).to eq(1)
      end

      it "refuses while a resend is still going out", parity: true do
        blast_for(installment, requested_at: 10.minutes.ago, completed_at: nil)
        log_in(seller)

        resend(installment)

        expect(response).to have_http_status(:unprocessable_entity)
        expect(response.parsed_body).to eq("success" => false, "error" => "You can only resend to non-openers once every 24 hours.")
      end

      it "refuses within a day of a resend that delivered", parity: true do
        blast_for(installment, requested_at: 3.hours.ago, completed_at: 2.hours.ago, delivery_count: 40)
        log_in(seller)

        resend(installment)

        expect(response).to have_http_status(:unprocessable_entity)
      end

      it "resends again once a day has passed", parity: true do
        blast_for(installment, requested_at: 3.days.ago, completed_at: 2.days.ago, delivery_count: 40)
        log_in(seller)

        resend(installment)

        expect(response.parsed_body).to eq("success" => true)
        expect(installment.blasts.to_non_openers.count).to eq(2)
      end

      it "does not count a resend that delivered nothing", parity: true do
        blast_for(installment, requested_at: 3.hours.ago, completed_at: 2.hours.ago, delivery_count: 0)
        log_in(seller)

        resend(installment)

        expect(response.parsed_body).to eq("success" => true)
      end

      it "stops at three resends", parity: true do
        3.times { |index| blast_for(installment, requested_at: (10 + index).days.ago, completed_at: (9 + index).days.ago, delivery_count: 10) }
        log_in(seller)

        resend(installment)

        expect(response).to have_http_status(:unprocessable_entity)
        expect(response.parsed_body["error"]).to eq("You can resend to non-openers up to 3 times per email.")
      end

      it "answers 404 JSON for a draft", parity: true do
        draft = create(:installment, seller:, link: nil, installment_type: "seller", published_at: nil, send_emails: true)
        log_in(seller)

        resend(draft)

        expect(response).to have_http_status(:not_found)
      end

      it "answers 404 JSON for a post that was not emailed", parity: true do
        silent = create(:installment, seller:, link: nil, installment_type: "seller", published_at: Time.utc(2025, 1, 1), send_emails: false, shown_on_profile: true)
        log_in(seller)

        resend(silent)

        expect(response).to have_http_status(:not_found)
      end

      it "answers 404 JSON for a post sent to followers", parity: true do
        followers = create(:installment, seller:, link: nil, installment_type: "follower", published_at: Time.utc(2025, 1, 1), send_emails: true)
        log_in(seller)

        resend(followers)

        expect(response).to have_http_status(:not_found)
      end

      it "answers 404 JSON for a send that expired without reaching anyone", parity: true do
        create(:post_email_blast, post: installment, seller:, first_email_delivered_at: nil, last_email_delivered_at: nil, delivery_count: 0, expired_at: 1.day.ago)
        log_in(seller)

        resend(installment)

        expect(response).to have_http_status(:not_found)
      end

      it "answers 404 JSON for a post of another seller", parity: true do
        other = create(:installment, seller: create(:user), link: nil, installment_type: "seller", published_at: Time.utc(2025, 1, 1), send_emails: true)
        log_in(seller)

        resend(other)

        expect(response).to have_http_status(:not_found)
      end

      it "lets a marketing team member resend", parity: true do
        member = create(:user, name: "Marketing Member")
        membership = create(:team_membership, user: member, seller:, role: TeamMembership::ROLE_MARKETING)
        log_in(member)
        switch_to(membership)

        resend(installment)

        expect(response.parsed_body).to eq("success" => true)
      end

      it "answers 401 JSON to a support team member", parity: true do
        member = create(:user, name: "Support Member")
        membership = create(:team_membership, user: member, seller:, role: TeamMembership::ROLE_SUPPORT)
        log_in(member)
        switch_to(membership)

        resend(installment)

        expect(response).to have_http_status(:unauthorized)
      end

      it "hands a request without the CSRF token to Rails", parity: true do
        log_in(seller)

        post "/internal/installments/#{installment.external_id}/non_opener_resend", headers: JSON_ACCEPT

        expect(response.status).to be_in([200, 404, 422])
      end
    end

    describe "GET /internal/products/:product_id/existing_product_files" do
      it "lists nothing for a seller without files", parity: true do
        product
        log_in(seller)

        get "/internal/products/#{product.unique_permalink}/existing_product_files", headers: JSON_ACCEPT

        expect(response.parsed_body).to eq("existing_files" => [])
      end

      it "hands a seller with files to Rails", parity: true do
        create(:product_file, link: product)
        log_in(seller)

        get "/internal/products/#{product.unique_permalink}/existing_product_files", headers: JSON_ACCEPT

        expect(response).to have_http_status(:ok)
      end

      it "answers 404 for a permalink that does not exist", parity: true do
        log_in(seller)

        get "/internal/products/nothing/existing_product_files", headers: JSON_ACCEPT

        expect(response).to have_http_status(:not_found)
      end

      it "hands a product of another seller to Rails", parity: true do
        other = create(:product, user: create(:user), unique_permalink: "theirs")
        log_in(seller)

        get "/internal/products/#{other.unique_permalink}/existing_product_files", headers: JSON_ACCEPT

        expect(response).to have_http_status(:not_found)
      end
    end

    describe "POST /internal/product_review_videos/:id/{approvals,rejections}" do
      let(:buyer) { create(:user, name: "Reviewer") }
      let(:purchase) { build(:purchase, link: product, seller:, purchaser: buyer, price_cents: 500).tap { |row| row.save!(validate: false) } }
      let(:review) { create(:product_review, purchase:, link: product, message: "Great") }
      let(:video) { create(:product_review_video, product_review: review) }

      def decide(kind, record, headers: {})
        post "/internal/product_review_videos/#{record.external_id}/#{kind}", headers: JSON_ACCEPT.merge("X-CSRF-Token" => csrf_token).merge(headers)
      end

      it "approves a pending video", parity: true do
        log_in(seller)

        decide(:approvals, video)

        expect(response).to have_http_status(:ok)
        expect(video.reload).to be_approved
      end

      it "rejects a pending video", parity: true do
        log_in(seller)

        decide(:rejections, video)

        expect(response).to have_http_status(:ok)
        expect(video.reload).to be_rejected
      end

      it "retires the review's earlier approved video when another is approved", parity: true do
        earlier = create(:product_review_video, product_review: review, approval_status: :approved)
        log_in(seller)

        decide(:approvals, video)

        expect(earlier.reload).to be_deleted
        expect(video.reload).to be_approved
      end

      it "approves a video that is already approved", parity: true do
        approved = create(:product_review_video, product_review: review, approval_status: :approved)
        log_in(seller)

        decide(:approvals, approved)

        expect(response).to have_http_status(:ok)
      end

      it "answers 404 for a deleted video", parity: true do
        video.mark_deleted!
        log_in(seller)

        decide(:approvals, video)

        expect(response).to have_http_status(:not_found)
      end

      it "answers 404 for an id that does not decode", parity: true do
        log_in(seller)
        post "/internal/product_review_videos/not-an-id/approvals", headers: JSON_ACCEPT.merge("X-CSRF-Token" => csrf_token)

        expect(response).to have_http_status(:not_found)
      end

      it "answers 401 JSON for a video of another seller's review", parity: true do
        other_review = create(:product_review, purchase: build(:purchase, link: create(:product, user: create(:user)), price_cents: 500).tap { |row| row.save!(validate: false) })
        foreign = create(:product_review_video, product_review: other_review)
        log_in(seller)

        decide(:approvals, foreign)

        expect(response).to have_http_status(:unauthorized)
      end

      it "lets a support team member reject", parity: true do
        member = create(:user, name: "Support Member")
        membership = create(:team_membership, user: member, seller:, role: TeamMembership::ROLE_SUPPORT)
        log_in(member)
        switch_to(membership)

        decide(:rejections, video)

        expect(response).to have_http_status(:ok)
      end

      it "keeps a marketing team member out", parity: true do
        member = create(:user, name: "Marketing Member")
        membership = create(:team_membership, user: member, seller:, role: TeamMembership::ROLE_MARKETING)
        log_in(member)
        switch_to(membership)

        decide(:approvals, video)

        expect(response).to have_http_status(:unauthorized)
      end

      it "answers 404 JSON to a signed-out visitor", parity: true do
        post "/internal/product_review_videos/#{video.external_id}/approvals", headers: JSON_ACCEPT.merge("X-CSRF-Token" => csrf_token)

        expect(response).to have_http_status(:not_found)
      end

      it "hands a request without the CSRF token to Rails", parity: true do
        log_in(seller)

        post "/internal/product_review_videos/#{video.external_id}/approvals", headers: JSON_ACCEPT

        expect(response.status).to be_in([200, 404, 422])
      end
    end
  end
end
