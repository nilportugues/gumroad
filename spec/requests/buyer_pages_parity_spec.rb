# frozen_string_literal: true

require "spec_helper"

# The GET renders of the buyer pages (forgot password, subscription magic link, invoice confirmation,
# reviews, saved and followed wishlists, library), recorded for the Next.js port (PARITY_RECORD=1)
# through the full Rack stack, signed out and signed in. Replayed by
# nextjs/parity/__tests__/buyer-pages.replay.test.ts, which sends the last request of each example.
describe "Buyer pages", type: :request do
  include ActiveSupport::Testing::TimeHelpers

  let(:buyer) { create(:user, name: "Parity Buyer") }

  before { host! DOMAIN }

  # Forgery protection is on in the test environment, so a page's token is fetched first. Any
  # signed-out page will do.
  def csrf_token
    get help_center_category_path(HelpCenter::Category.first)
    inertia_props_of(response).fetch("authenticity_token")
  end

  def log_in(user)
    post login_path, params: { authenticity_token: csrf_token, user: { login_identifier: user.email, password: user.password } }
    expect(response).to have_http_status(:found)
  end

  def inertia_props_of(response)
    page = response.body[/<script[^>]*data-page="[^"]*"[^>]*>(.*?)<\/script>/m, 1] || CGI.unescapeHTML(response.body[/\sdata-page="([^"]*)"/, 1])
    JSON.parse(page)["props"]
  end

  def inertia_visit(path)
    get path, headers: { "X-Inertia" => "true", "X-Requested-With" => "XMLHttpRequest" }
  end

  describe "GET /users/forgot_password/new" do
    it "renders the form", parity: true do
      get new_user_password_path

      expect(response).to be_successful
      expect(inertia_props_of(response)).to include("email" => nil, "application_name" => nil)
    end

    it "prefills the email from the query", parity: true do
      get new_user_password_path(email: "buyer@example.com")

      expect(response).to be_successful
      expect(inertia_props_of(response)["email"]).to eq("buyer@example.com")
    end

    it "prefills the email of a team invitation", parity: true do
      get new_user_password_path(next: "/settings/team/invitations?email=invitee%40example.com")

      expect(response).to be_successful
      expect(inertia_props_of(response)["email"]).to eq("invitee@example.com")
    end

    it "answers an Inertia visit with the page as JSON", parity: true do
      inertia_visit new_user_password_path

      expect(response).to be_successful
      expect(response.parsed_body["component"]).to eq("User/Passwords/New")
    end

    it "sends a signed-in visitor to where a login would", parity: true do
      log_in(buyer)

      get new_user_password_path

      expect(response).to have_http_status(:found)
    end
  end

  describe "GET /users/forgot_password/edit" do
    let(:user) { create(:user) }

    it "renders the form for a valid token", parity: true do
      token = user.send_reset_password_instructions

      get edit_user_password_path(reset_password_token: token)

      expect(response).to be_successful
      expect(inertia_props_of(response)).to include("reset_password_token" => token)
    end

    it "sends an unknown token to the home page", parity: true do
      get edit_user_password_path(reset_password_token: "not-a-token")

      expect(response).to redirect_to(root_path)
      expect(flash[:warning]).to eq("That reset password token doesn't look valid (or may have expired).")
    end

    it "sends a request without a token to the sign-in page", parity: false do
      get edit_user_password_path

      expect(response).to redirect_to("http://#{DOMAIN}/users/sign_in")
    end
  end

  describe "GET /subscriptions/:subscription_id/magic_link/new" do
    let(:subscription) { create(:membership_purchase, email: "member@example.com").subscription }

    it "renders the page", parity: true do
      get new_subscription_magic_link_path(subscription.external_id)

      expect(response).to be_successful
      expect(inertia_props_of(response)).to include("subscription_id" => subscription.external_id, "email_sent" => nil)
    end

    it "echoes which email the link was sent to", parity: true do
      get new_subscription_magic_link_path(subscription.external_id, email_sent: "purchase")

      expect(response).to be_successful
      expect(inertia_props_of(response)["email_sent"]).to eq("purchase")
    end

    it "lists the redacted emails of a subscription with a distinct account email", parity: true do
      subscription.update!(user: create(:user, email: "account-holder@example.com"))

      get new_subscription_magic_link_path(subscription.external_id)

      expect(response).to be_successful
      expect(inertia_props_of(response)["user_emails"].size).to eq(2)
    end

    it "renders for an installment plan", parity: true do
      plan_subscription = subscription.tap { _1.update!(is_installment_plan: true) }

      get new_subscription_magic_link_path(plan_subscription.external_id)

      expect(response).to be_successful
      expect(inertia_props_of(response)["is_installment_plan"]).to be(true)
    end

    it "answers an unknown subscription with a 404", parity: true do
      get new_subscription_magic_link_path("unknown-subscription")

      expect(response).to have_http_status(:not_found)
    end
  end

  describe "GET /purchases/:purchase_id/invoice/confirm" do
    let(:purchase) { create(:free_purchase) }

    it "renders the confirmation page", parity: true do
      get confirm_purchase_invoice_path(purchase.external_id)

      expect(response).to be_successful
      expect(response.headers["X-Robots-Tag"]).to include("noindex")
    end

    it "renders for an unknown purchase, as it does not look it up", parity: true do
      get confirm_purchase_invoice_path("unknown-purchase")

      expect(response).to be_successful
    end
  end

  describe "when signed in" do
    def switch_to(team_membership)
      post sellers_switch_path, params: { authenticity_token: csrf_token, team_membership_id: team_membership.external_id }
      expect(response).to have_http_status(:no_content)
    end

    describe "GET /wishlists" do
      it "renders an empty list", parity: true do
        log_in(buyer)

        get wishlists_path

        expect(response).to be_successful
        expect(inertia_props_of(response)["wishlists"]).to eq([])
      end

      it "lists the buyer's alive wishlists with their alive product counts", parity: true do
        kept = create(:wishlist, user: buyer, name: "Café & Co. picks!", discover_opted_out: true)
        create(:wishlist_product, wishlist: kept)
        create(:wishlist_product, wishlist: kept).mark_deleted!
        create(:wishlist, user: buyer, name: "Empty")
        create(:wishlist, user: buyer, name: "Gone").mark_deleted!
        create(:wishlist, name: "Someone else's")
        log_in(buyer)

        get wishlists_path

        expect(response).to be_successful
        wishlists = inertia_props_of(response)["wishlists"]
        expect(wishlists.map { _1["name"] }).to eq(["Café & Co. picks!", "Empty"])
        expect(wishlists.first).to include("product_count" => 1, "discover_opted_out" => true)
      end

      it "answers an Inertia visit with the page as JSON", parity: true do
        log_in(buyer)

        inertia_visit wishlists_path

        expect(response).to be_successful
        expect(response.parsed_body["component"]).to eq("Wishlists/Index")
      end

      it "sends a team member to the dashboard with the refusal", parity: true do
        seller = create(:user)
        membership = create(:team_membership, user: buyer, seller:, role: TeamMembership::ROLE_SUPPORT)
        log_in(buyer)
        switch_to(membership)

        get wishlists_path

        expect(response).to redirect_to(dashboard_url)
        expect(flash[:alert]).to eq("Your current role as Support cannot perform this action.")
      end
    end

    describe "GET /wishlists/following" do
      it "renders an empty list", parity: true do
        log_in(buyer)

        get wishlists_following_index_path

        expect(response).to be_successful
        expect(inertia_props_of(response)["wishlists"]).to eq([])
      end

      it "lists the wishlists the buyer follows with their creators", parity: true do
        creator = create(:user, name: "Wishlist Creator")
        followed = create(:wishlist, user: creator, name: "Summer reads")
        create(:wishlist_product, wishlist: followed)
        create(:wishlist_follower, wishlist: followed, follower_user: buyer)
        unfollowed = create(:wishlist, user: creator, name: "Unfollowed")
        create(:wishlist_follower, wishlist: unfollowed, follower_user: buyer).mark_deleted!
        log_in(buyer)

        get wishlists_following_index_path

        expect(response).to be_successful
        wishlists = inertia_props_of(response)["wishlists"]
        expect(wishlists.map { _1["name"] }).to eq(["Summer reads"])
        expect(wishlists.first["creator"]).to include("name" => "Wishlist Creator")
      end
    end

    describe "the public buyer pages" do
      it "renders the magic link page for the subscriber", parity: true do
        subscription = create(:membership_purchase, email: "member@example.com", purchaser: buyer).subscription
        log_in(buyer)

        get new_subscription_magic_link_path(subscription.external_id, email_sent: "user")

        expect(response).to be_successful
        expect(inertia_props_of(response)["logged_in_user"]).to include("email" => buyer.email)
      end

      it "renders the invoice confirmation page", parity: true do
        log_in(buyer)

        get confirm_purchase_invoice_path(create(:free_purchase, purchaser: buyer).external_id)

        expect(response).to be_successful
        expect(inertia_props_of(response)["logged_in_user"]).to include("email" => buyer.email)
      end
    end

    describe "GET /library" do
      def library_purchase(link: create(:product), **attributes)
        create(:free_purchase, purchaser: buyer, email: buyer.email, link:, **attributes).tap { _1.create_url_redirect! }
      end

      it "renders an empty library", parity: true do
        log_in(buyer)

        get library_path

        expect(response).to be_successful
        expect(inertia_props_of(response)).to include("results" => [], "archived_count" => 0, "unarchived_count" => 0)
      end

      it "lists the purchases with their creators, variants and archive state", parity: true do
        creator = create(:user, name: "Library Creator")
        product = create(:product_with_digital_versions, user: creator, name: "Versioned product", content_updated_at: 1.day.ago)
        library_purchase(link: product, variant_attributes: [product.alive_variants.first])
        library_purchase(link: create(:product, user: create(:user, name: nil, username: "plainseller"), name: "Plain product"))
        library_purchase(link: create(:product, name: "Archived product"), is_archived: true)
        library_purchase(link: create(:product, name: "Deleted product"), is_deleted_by_buyer: true)
        library_purchase(link: create(:product, name: "Revoked product"), is_access_revoked: true)
        log_in(buyer)

        get library_path

        expect(response).to be_successful
        props = inertia_props_of(response)
        expect(props["results"].map { _1.dig("product", "name") }).to contain_exactly("Versioned product", "Plain product")
        expect(props).to include("archived_count" => 1, "unarchived_count" => 2)
      end

      it "filters, sorts and pages through the library", parity: true do
        creator = create(:user, name: "Filter Creator")
        17.times { |i| library_purchase(link: create(:product, user: creator, name: "Book #{i}", content_updated_at: i.days.ago)) }
        library_purchase(link: create(:product, name: "Other product"))
        library_purchase(link: create(:product, name: "Put away"), is_archived: true)
        log_in(buyer)

        get library_path(page: 2, sort: "purchase_date", query: "Book", creators: creator.external_id)

        expect(response).to be_successful
        props = inertia_props_of(response)
        expect(props["pagination"]).to include("page" => 2, "pages" => 2, "count" => 17)
        expect(props["results"].size).to eq(2)
        expect(props["search"]).to include("sort" => "purchase_date", "query" => "Book", "creators" => [creator.external_id])
      end

      it "clamps a page past the end and shows only archived purchases on request", parity: true do
        library_purchase(link: create(:product, name: "Kept"))
        library_purchase(link: create(:product, name: "Put away"), is_archived: true)
        log_in(buyer)

        get library_path(page: 99, show_archived_only: "true", query: "100%_")

        expect(response).to be_successful
        expect(inertia_props_of(response)["pagination"]).to include("page" => 1, "pages" => 1, "count" => 0, "from" => 0, "to" => 0)
      end

      it "serves the library_purchase path the same way", parity: true do
        purchase = library_purchase(link: create(:product, name: "Linked product"))
        log_in(buyer)

        get library_purchase_path(purchase.external_id)

        expect(response).to be_successful
        expect(inertia_props_of(response)["results"].size).to eq(1)
      end

      it "answers an Inertia visit with the page as JSON", parity: true do
        library_purchase
        log_in(buyer)

        inertia_visit library_path

        expect(response).to be_successful
        expect(response.parsed_body["component"]).to eq("Library/Index")
      end

      it "sends a team member to the dashboard with the refusal", parity: true do
        seller = create(:user)
        membership = create(:team_membership, user: buyer, seller:, role: TeamMembership::ROLE_ADMIN)
        log_in(buyer)
        switch_to(membership)

        get library_path

        expect(response).to redirect_to(dashboard_url)
        expect(flash[:alert]).to eq("Your current role as Admin cannot perform this action.")
      end

      it "lists a membership that grants access and hides one whose access ended", parity: true do
        active = create(:membership_purchase, purchaser: buyer, link: create(:membership_product, name: "Active membership")).tap { _1.create_url_redirect! }
        ended = create(:membership_purchase, purchaser: buyer, link: create(:membership_product, name: "Ended membership")).tap { _1.create_url_redirect! }
        ended.link.update!(block_access_after_membership_cancellation: true)
        ended.subscription.update!(cancelled_at: 1.day.ago)
        log_in(buyer)

        get library_path

        expect(response).to be_successful
        props = inertia_props_of(response)
        expect(props["results"].map { _1.dig("purchase", "id") }).to eq([active.external_id])
        expect(props).to include("archived_count" => 0, "unarchived_count" => 1)
      end

      it "renders member purchases instead of the bundle purchase and offers the bundle filter", parity: true do
        # The purchase factory charges a card through Stripe; the page only needs the rows.
        bundle_purchase = build(:purchase, purchaser: buyer, email: buyer.email, link: create(:product, :bundle), is_bundle_purchase: true, purchase_state: "successful").tap { _1.save!(validate: false) }
        bundle_purchase.link.bundle_products.each do |bundle_product|
          member = build(:purchase, purchaser: buyer, email: buyer.email, link: bundle_product.product, is_bundle_product_purchase: true, purchase_state: "successful").tap { _1.save!(validate: false) }
          member.create_url_redirect!
          BundleProductPurchase.create!(bundle_purchase:, product_purchase: member)
        end
        log_in(buyer)

        get library_path(bundles: bundle_purchase.link.external_id)

        expect(response).to be_successful
        props = inertia_props_of(response)
        expect(props["bundles"]).to eq([{ "id" => bundle_purchase.link.external_id, "label" => bundle_purchase.link.name }])
        expect(props["results"].map { _1.dig("product", "name") }).to match_array(bundle_purchase.link.bundle_products.map { _1.product.name })
      end

      # The purchase factory charges a card through Stripe, and a refund is a column the page only reads.
      def subscription_purchase(subscription, original:, **attributes)
        build(:purchase, purchaser: buyer, email: buyer.email, link: subscription.link, subscription:, is_original_subscription_purchase: original, purchase_state: "successful", succeeded_at: Time.current, **attributes)
          .tap { _1.save!(validate: false) }.tap { _1.create_url_redirect! }
      end

      it "links a refunded membership signup to the buyer's paid renewal", parity: true do
        subscription = create(:subscription, user: buyer, link: create(:membership_product, name: "Refunded signup"))
        subscription_purchase(subscription, original: true, stripe_refunded: true)
        older_renewal = subscription_purchase(subscription, original: false, succeeded_at: 2.days.ago)
        renewal = subscription_purchase(subscription, original: false, succeeded_at: 1.day.ago)
        subscription_purchase(subscription, original: false, succeeded_at: Time.current, stripe_refunded: true)
        log_in(buyer)

        get library_path

        expect(response).to be_successful
        results = inertia_props_of(response)["results"]
        expect(results.size).to eq(1)
        expect(results.first.dig("purchase", "download_url")).to eq(renewal.url_redirect.download_page_url)
        expect(results.first.dig("purchase", "download_url")).not_to eq(older_renewal.url_redirect.download_page_url)
      end

      it "gives a refunded membership signup no download link when there is no paid renewal", parity: true do
        subscription = create(:subscription, user: buyer, link: create(:membership_product, name: "Refunded alone"))
        subscription_purchase(subscription, original: true, stripe_refunded: true)
        log_in(buyer)

        get library_path

        expect(response).to be_successful
        expect(inertia_props_of(response)["results"].map { _1.dig("purchase", "download_url") }).to eq([nil])
      end

      # The subscriptions tab is handed to Rails, so there is nothing to replay.
      it "renders the subscriptions tab", parity: false do
        create(:membership_purchase, purchaser: buyer).tap { _1.create_url_redirect! }
        log_in(buyer)

        get library_path(subscriptions_only: "true")

        expect(response).to be_successful
      end
    end

    describe "GET /reviews" do
      it "renders when there is nothing to review", parity: true do
        log_in(buyer)

        get reviews_path

        expect(response).to be_successful
        expect(inertia_props_of(response)).to include("reviews" => [], "purchases" => [])
      end

      it "lists written reviews and the purchases still waiting for one", parity: true do
        reviewed = create(:free_purchase, purchaser: buyer, email: buyer.email)
        create(:product_review, purchase: reviewed, rating: 4, message: "Solid")
        anonymous = create(:free_purchase, purchaser: buyer, email: buyer.email)
        create(:product_review, purchase: anonymous, rating: 2, message: "Hmm", anonymous: true)
        create(:free_purchase, purchaser: buyer, email: buyer.email, link: create(:product, user: create(:user, name: "Seller Name"), name: "Waiting product"))
        stale = create(:free_purchase, purchaser: buyer, email: buyer.email, created_at: 2.years.ago, link: create(:product, name: "Stale product"))
        stale.seller.update!(disable_reviews_after_year: true)
        create(:free_purchase, purchaser: buyer, email: buyer.email, is_deleted_by_buyer: true)
        create(:free_purchase, email: buyer.email)
        log_in(buyer)

        get reviews_path

        expect(response).to be_successful
        props = inertia_props_of(response)
        expect(props["reviews"].size).to eq(2)
        expect(props["purchases"].map { _1.dig("product", "name") }).to eq(["Waiting product"])
      end
    end
  end
end
