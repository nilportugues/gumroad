# frozen_string_literal: true

require "spec_helper"

# GET renders of the pages UrlRedirectsController shows when content is gone or needs the buyer's email
# (expired, rental_expired_page, membership_inactive_page, confirm_page), recorded for the Next.js port
# (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/url-redirect-pages.replay.test.ts, which sends
# the last request of each example.
describe "Url redirect unavailable pages", type: :request do
  include Parity::SignedInDashboard

  let(:seller) { create(:user, name: "Parity Seller") }
  let(:buyer) { create(:user, name: "Parity Buyer") }
  let(:product) { create(:product, user: seller, name: "Parity course") }
  # A charged purchase would call Stripe: the price is set on a free one's row.
  let(:purchase) do
    create(:free_purchase, link: product, purchaser: buyer, email: "buyer@example.com").tap do |record|
      record.update_columns(price_cents: 500, total_transaction_cents: 500)
    end
  end
  let(:url_redirect) { create(:url_redirect, link: product, purchase:) }

  describe "GET /r/:id/expired" do
    it "explains that access expired", parity: true do
      get url_redirect_expired_page_path(url_redirect.token)

      expect(response).to be_successful
      props = inertia_props_of(response)
      expect(props).to include("token" => url_redirect.token, "add_to_library_option" => "none", "content_unavailability_reason_code" => "access_expired")
      expect(props["purchase"]).to include("email" => "buyer@example.com", "product_name" => "Parity course", "has_invoice" => true)
    end

    it "answers an Inertia visit with the page as JSON", parity: true do
      inertia_visit url_redirect_expired_page_path(url_redirect.token)

      expect(response).to be_successful
      expect(response.headers["X-Inertia"]).to eq("true")
    end

    it "offers a guest purchase's signup form", parity: true do
      purchase.update_columns(purchaser_id: nil)

      get url_redirect_expired_page_path(url_redirect.token, display: "mobile_app")

      expect(response).to be_successful
      expect(inertia_props_of(response)).to include("add_to_library_option" => "signup_form", "is_mobile_app_web_view" => true)
    end

    it "offers a signed-in visitor the add to library button for a guest purchase", parity: true do
      purchase.update_columns(purchaser_id: nil)
      log_in(create(:user, name: "Other Buyer"))

      get url_redirect_expired_page_path(url_redirect.token)

      expect(response).to be_successful
      expect(inertia_props_of(response)["add_to_library_option"]).to eq("add_to_library_button")
    end

    it "does not offer the seller their own customer's purchase", parity: true do
      purchase.update_columns(purchaser_id: nil)
      log_in(seller)

      get url_redirect_expired_page_path(url_redirect.token)

      expect(response).to be_successful
      expect(inertia_props_of(response)["add_to_library_option"]).to eq("none")
    end

    it "renders a free purchase without an invoice link", parity: true do
      free_product = create(:product, user: seller, name: "Free course", price_cents: 0)
      free_purchase = create(:free_purchase, link: free_product, purchaser: buyer, email: "buyer@example.com")
      free_redirect = create(:url_redirect, link: free_product, purchase: free_purchase)

      get url_redirect_expired_page_path(free_redirect.token)

      expect(response).to be_successful
      expect(inertia_props_of(response)["purchase"]["has_invoice"]).to be(false)
    end

    it "renders a redirect without a purchase", parity: true do
      redirect = UrlRedirect.create!(link: product)

      get url_redirect_expired_page_path(redirect.token)

      expect(response).to be_successful
      expect(inertia_props_of(response)).to include("purchase" => nil, "add_to_library_option" => "none")
    end

    it "answers 404 for an unknown token", parity: true do
      get url_redirect_expired_page_path("unknown-token")

      expect(response).to have_http_status(:not_found)
    end
  end

  describe "GET /r/:id/rental_expired" do
    it "explains that the rental expired", parity: true do
      get url_redirect_rental_expired_page_path(url_redirect.token)

      expect(response).to be_successful
      expect(inertia_props_of(response)["content_unavailability_reason_code"]).to eq("rental_expired")
    end
  end

  describe "GET /r/:id/membership_inactive" do
    it "shows the cancelled membership", parity: true do
      membership = create(:membership_purchase, purchaser: buyer, email: "buyer@example.com")
      membership.subscription.update_columns(cancelled_at: 2.days.ago, flags: membership.subscription.flags | 2)
      redirect = create(:url_redirect, link: membership.link, purchase: membership)

      get url_redirect_membership_inactive_page_path(redirect.token)

      expect(response).to be_successful
      props = inertia_props_of(response)
      expect(props["content_unavailability_reason_code"]).to eq("inactive_membership")
      expect(props["purchase"]["membership"]).to include("has_active_subscription" => false, "is_subscription_cancelled_or_failed" => true, "is_installment_plan" => false)
    end

    it "shows a membership the seller ended", parity: true do
      membership = create(:membership_purchase, purchaser: buyer, email: "buyer@example.com")
      membership.subscription.update_columns(ended_at: 1.day.ago)
      redirect = create(:url_redirect, link: membership.link, purchase: membership)

      get url_redirect_membership_inactive_page_path(redirect.token)

      expect(response).to be_successful
      expect(inertia_props_of(response)["purchase"]["membership"]).to include("is_subscription_ended" => true, "is_alive_or_restartable" => false)
    end

    it "shows a membership in its free trial", parity: true do
      trial = create(:free_trial_membership_purchase, purchaser: buyer, email: "buyer@example.com")
      redirect = create(:url_redirect, link: trial.link, purchase: trial)

      get url_redirect_membership_inactive_page_path(redirect.token)

      expect(response).to be_successful
      expect(inertia_props_of(response)["purchase"]).to include("has_invoice" => false)
      expect(inertia_props_of(response)["purchase"]["membership"]["in_free_trial"]).to be(true)
    end

    it "shows a failed installment plan", parity: true do
      # An installment plan's purchase would call Stripe: the subscription row is flagged instead.
      plan = create(:membership_purchase, purchaser: buyer, email: "buyer@example.com")
      plan.subscription.update_columns(failed_at: 1.day.ago, charge_occurrence_count: 3, flags: plan.subscription.flags | 64)
      redirect = create(:url_redirect, link: plan.link, purchase: plan)

      get url_redirect_membership_inactive_page_path(redirect.token)

      expect(response).to be_successful
      expect(inertia_props_of(response)["purchase"]["membership"]).to include("is_installment_plan" => true, "is_subscription_cancelled_or_failed" => true)
    end
  end

  describe "GET /confirm" do
    it "asks for the purchase email and hides it from the props", parity: true do
      get confirm_page_path(id: url_redirect.token, destination: "download_page", display: "mobile_app", email: "typed@example.com")

      expect(response).to be_successful
      expect(response.headers["X-Robots-Tag"]).to include("noindex")
      props = inertia_props_of(response)
      expect(props["content_unavailability_reason_code"]).to eq("email_confirmation_required")
      expect(props["purchase"]["email"]).to be_nil
      expect(props["confirmation_info"]).to include("destination" => "download_page", "display" => "mobile_app", "email" => "typed@example.com", "is_gift" => false)
    end

    it "answers an Inertia visit with the page as JSON", parity: true do
      inertia_visit confirm_page_path(id: url_redirect.token)

      expect(response).to be_successful
      expect(inertia_props_of_json(response)["confirmation_info"]).to include("destination" => nil)
    end

    it "answers 404 without an id", parity: true do
      get confirm_page_path

      expect(response).to have_http_status(:not_found)
    end
  end

  def inertia_props_of_json(response) = JSON.parse(response.body)["props"]
end
