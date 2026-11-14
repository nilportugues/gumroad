# frozen_string_literal: true

require "spec_helper"

# The PurchasesController actions Node answers by their guards: update, change_can_contact, cancel_preorder_by_seller, refund,
# receipt, confirm_receipt_email, subscribe, unsubscribe, resend_receipt, confirm and charge_preorder. Recorded for the Next.js port
# (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/purchases-controller.replay.test.ts, which sends the last request of
# each example. An example named "hands a ..." is one Node leaves to Rails whole.
describe "Purchases controller guards", type: :request do
  include Parity::AudienceSignedIn

  let(:seller) { create(:user, name: "Purchases Seller", is_team_member: true) }
  let(:product) { create(:product, user: seller, name: "Guarded product", unique_permalink: "guarded", created_at: Time.utc(2025, 1, 1)) }
  let(:purchase) { build(:purchase, link: product, seller:, email: "buyer@example.com", purchase_state: "successful").tap { _1.save!(validate: false) } }
  let(:json_headers) do
    { "Accept" => "application/json, text/html", "Content-Type" => "application/json", "Referer" => "http://#{DOMAIN}/customers" }
  end

  before { host! DOMAIN }

  def send_json(method, path, body = {})
    public_send(method, path, params: body.to_json, headers: json_headers.merge("X-CSRF-Token" => csrf_token))
  end

  def team_member(role)
    member = create(:user, name: "#{role.capitalize} Member")
    membership = create(:team_membership, user: member, seller:, role:)
    log_in(member)
    switch_to(membership)
  end

  def foreign_purchase
    other = create(:product, unique_permalink: "notmine")
    build(:purchase, link: other, seller: other.user, purchase_state: "successful").tap { _1.save!(validate: false) }
  end

  def preorder_purchase
    preorder_link = create(:preorder_link, link: product)
    preorder = create(:preorder, preorder_link:, seller:, state: "authorization_successful")
    purchase.update_columns(preorder_id: preorder.id)
    [purchase, preorder]
  end

  describe "updating a purchase" do
    it "hands the update of an owner's purchase to Rails", parity: true do
      log_in(seller)

      send_json(:put, "/purchases/#{purchase.external_id}", { full_name: "Renamed Buyer" })

      expect(response).to have_http_status(:ok)
    end

    it "hands a PATCH update of an owner's purchase to Rails", parity: true do
      log_in(seller)

      send_json(:patch, "/purchases/#{purchase.external_id}", { city: "Lisbon" })

      expect(response).to have_http_status(:ok)
    end

    it "answers 404 when updating a purchase of another seller", parity: true do
      other = foreign_purchase
      log_in(seller)

      send_json(:put, "/purchases/#{other.external_id}", { full_name: "Stolen" })

      expect(response).to have_http_status(:not_found)
      expect(response.parsed_body).to eq("success" => false, "error" => "Not found")
    end

    it "answers 404 when updating a purchase that does not exist", parity: true do
      log_in(seller)

      send_json(:put, "/purchases/nosuchpurchase", { full_name: "Ghost" })

      expect(response).to have_http_status(:not_found)
    end

    it "does not let an accountant update a purchase", parity: true do
      purchase
      team_member(TeamMembership::ROLE_ACCOUNTANT)

      send_json(:put, "/purchases/#{purchase.external_id}", { full_name: "Renamed Buyer" })

      expect(response).to have_http_status(:unauthorized)
      expect(response.parsed_body).to eq("success" => false, "error" => "Your current role as Accountant cannot perform this action.")
    end
  end

  describe "changing whether a buyer can be contacted", defer_audience_refresh: true do
    let(:free_product) { create(:product, user: seller, name: "Free product", unique_permalink: "freeguarded", price_cents: 0, created_at: Time.utc(2025, 1, 1)) }
    let(:free_purchase) { build(:purchase, link: free_product, seller:, email: "free-buyer@example.com", purchase_state: "successful").tap { _1.save!(validate: false) } }

    it "stops emailing the buyer of a free purchase", parity: true do
      log_in(seller)

      send_json(:post, "/purchases/#{free_purchase.external_id}/change_can_contact", { can_contact: false })

      expect(response).to have_http_status(:no_content)
      expect(free_purchase.reload.can_contact).to be(false)
    end

    it "resumes emailing a buyer who was opted out", parity: true do
      free_purchase.update_columns(can_contact: false)
      log_in(seller)

      send_json(:post, "/purchases/#{free_purchase.external_id}/change_can_contact", { can_contact: true })

      expect(response).to have_http_status(:no_content)
      expect(free_purchase.reload.can_contact).to be(true)
    end

    it "writes nothing when the buyer can already be contacted", parity: true do
      log_in(seller)

      send_json(:post, "/purchases/#{free_purchase.external_id}/change_can_contact", { can_contact: "true" })

      expect(response).to have_http_status(:no_content)
    end

    it "reads off as false", parity: true do
      log_in(seller)

      send_json(:post, "/purchases/#{free_purchase.external_id}/change_can_contact", { can_contact: "off" })

      expect(response).to have_http_status(:no_content)
      expect(free_purchase.reload.can_contact).to be(false)
    end

    it "saves a priced purchase that carries its processor trace", parity: true do
      purchase.update_columns(merchant_account_id: create(:merchant_account, user: seller).id)
      log_in(seller)

      send_json(:post, "/purchases/#{purchase.external_id}/change_can_contact", { can_contact: false })

      expect(response).to have_http_status(:no_content)
      expect(purchase.reload.can_contact).to be(false)
    end

    it "stores NULL for a missing value", parity: true do
      free_purchase.update_columns(updated_at: 1.hour.ago)
      log_in(seller)

      send_json(:post, "/purchases/#{free_purchase.external_id}/change_can_contact", {})

      expect(response).to have_http_status(:no_content)
      expect(free_purchase.reload.can_contact).to be_nil
    end

    it "stores NULL for an empty string", parity: true do
      free_purchase.update_columns(updated_at: 1.hour.ago)
      log_in(seller)

      send_json(:post, "/purchases/#{free_purchase.external_id}/change_can_contact", { can_contact: "" })

      expect(response).to have_http_status(:no_content)
      expect(free_purchase.reload.can_contact).to be_nil
    end

    it "stores NULL for a null value", parity: true do
      free_purchase.update_columns(updated_at: 1.hour.ago)
      log_in(seller)

      send_json(:post, "/purchases/#{free_purchase.external_id}/change_can_contact", { can_contact: nil })

      expect(response).to have_http_status(:no_content)
      expect(free_purchase.reload.can_contact).to be_nil
    end

    it "writes nothing when a missing value meets a purchase that is already NULL", parity: true do
      free_purchase.update_columns(can_contact: nil)
      log_in(seller)

      send_json(:post, "/purchases/#{free_purchase.external_id}/change_can_contact", {})

      expect(response).to have_http_status(:no_content)
    end

    [
      ["a list of off values", ["off"]],
      ["an empty list", []],
      ["an object of off values", { "value" => "off" }]
    ].each do |label, value|
      it "reads #{label} as true", parity: true do
        free_purchase.update_columns(can_contact: false, updated_at: 1.hour.ago)
        log_in(seller)

        send_json(:post, "/purchases/#{free_purchase.external_id}/change_can_contact", { can_contact: value })

        expect(response).to have_http_status(:no_content)
        expect(free_purchase.reload.can_contact).to be(true)
      end
    end

    it "hands the change of a seller under a newsletter cutover to Rails", parity: true do
      FeatureAnnouncementNewsletterCutover.create!(seller:, state: "prepared", cutoff_at: Time.utc(2025, 6, 1))
      log_in(seller)

      send_json(:post, "/purchases/#{free_purchase.external_id}/change_can_contact", { can_contact: false })

      expect(response).to have_http_status(:no_content)
    end

    it "hands the change of a purchase that has a review to Rails", parity: true do
      create(:product_review, purchase: free_purchase, link: free_product, rating: 4)
      log_in(seller)

      send_json(:post, "/purchases/#{free_purchase.external_id}/change_can_contact", { can_contact: false })

      expect(response).to have_http_status(:no_content)
    end

    it "hands the change of an owner's purchase to Rails", parity: true do
      log_in(seller)

      send_json(:post, "/purchases/#{purchase.external_id}/change_can_contact", { can_contact: false })

      # The purchase was saved without validations, so Rails' save! refuses it.
      expect(response).to have_http_status(:unprocessable_content)
    end

    it "answers 404 for a purchase of another seller", parity: true do
      other = foreign_purchase
      log_in(seller)

      send_json(:post, "/purchases/#{other.external_id}/change_can_contact", { can_contact: false })

      expect(response).to have_http_status(:not_found)
    end

    it "answers 404 for a purchase that does not exist", parity: true do
      log_in(seller)

      send_json(:post, "/purchases/nosuchpurchase/change_can_contact", { can_contact: false })

      expect(response).to have_http_status(:not_found)
    end

    it "does not let a marketing team member change it", parity: true do
      purchase
      team_member(TeamMembership::ROLE_MARKETING)

      send_json(:post, "/purchases/#{purchase.external_id}/change_can_contact", { can_contact: false })

      expect(response).to have_http_status(:unauthorized)
      expect(response.parsed_body).to eq("success" => false, "error" => "Your current role as Marketing cannot perform this action.")
    end
  end

  describe "cancelling a preorder as the seller" do
    it "hands the cancellation to Rails", parity: true do
      preordered, = preorder_purchase
      log_in(seller)

      send_json(:post, "/purchases/#{preordered.external_id}/cancel_preorder_by_seller")

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body).to eq("success" => true)
    end

    it "answers 404 for a purchase of another seller", parity: true do
      other = foreign_purchase
      log_in(seller)

      send_json(:post, "/purchases/#{other.external_id}/cancel_preorder_by_seller")

      expect(response).to have_http_status(:not_found)
    end

    it "does not let an accountant cancel a preorder", parity: true do
      preordered, = preorder_purchase
      team_member(TeamMembership::ROLE_ACCOUNTANT)

      send_json(:post, "/purchases/#{preordered.external_id}/cancel_preorder_by_seller")

      expect(response).to have_http_status(:unauthorized)
    end
  end

  describe "refunding a purchase" do
    it "answers 404 for the refund of a purchase that does not exist", parity: true do
      log_in(seller)

      send_json(:put, "/purchases/nosuchpurchase/refund", { amount: "1.00" })

      expect(response).to have_http_status(:not_found)
    end

    it "does not let a marketing team member refund", parity: true do
      purchase
      team_member(TeamMembership::ROLE_MARKETING)

      send_json(:put, "/purchases/#{purchase.external_id}/refund", { amount: "1.00" })

      expect(response).to have_http_status(:unauthorized)
      expect(response.parsed_body).to eq("success" => false, "error" => "Your current role as Marketing cannot perform this action.")
    end
  end

  describe "the receipt" do
    it "answers 404 for a purchase that does not exist", parity: true do
      get "/purchases/nosuchpurchase/receipt"

      expect(response).to have_http_status(:not_found)
    end

    it "redirects a visitor without the buyer's email to the page that asks for it", parity: true do
      get "/purchases/#{purchase.external_id}/receipt"

      expect(response).to redirect_to("/purchases/#{purchase.external_id}/confirm_receipt_email")
    end

    it "hands a visitor who sends the buyer's email to Rails, which renders the receipt", parity: true do
      get "/purchases/#{purchase.external_id}/receipt", params: { email: "buyer@example.com" }

      expect(response).to have_http_status(:ok)
    end

    it "redirects a visitor who sends another email to the page that asks for it, with a wrong email alert", parity: true do
      get "/purchases/#{purchase.external_id}/receipt", params: { email: "someone@example.com" }

      expect(response).to redirect_to("/purchases/#{purchase.external_id}/confirm_receipt_email")
      expect(flash[:alert]).to eq("Wrong email. Please try again.")
    end

    it "answers 404 for the page that asks for the email of a purchase that does not exist", parity: true do
      get "/purchases/nosuchpurchase/confirm_receipt_email"

      expect(response).to have_http_status(:not_found)
    end

    it "hands the page that asks for the email to Rails", parity: true do
      get "/purchases/#{purchase.external_id}/confirm_receipt_email"

      expect(response).to have_http_status(:ok)
      expect(response.body).to include("Confirm your email address")
    end
  end

  describe "resending a receipt" do
    it "answers 404 for a purchase that does not exist", parity: true do
      send_json(:post, "/purchases/nosuchpurchase/resend_receipt")

      expect(response).to have_http_status(:not_found)
    end

    it "enqueues the receipt of a plain purchase", parity: true do
      send_json(:post, "/purchases/#{purchase.external_id}/resend_receipt")

      expect(response).to have_http_status(:no_content)
      expect(SendPurchaseReceiptJob.jobs.size).to eq(1)
    end

    it "answers 404 for a purchase with no email to send to", parity: true do
      purchase.update_columns(email: "")

      send_json(:post, "/purchases/#{purchase.external_id}/resend_receipt")

      expect(response).to have_http_status(:not_found)
      expect(SendPurchaseReceiptJob.jobs.size).to eq(0)
    end

    it "enqueues the preorder receipt mail of a preorder authorization", parity: true, parity_mail_jobs: true do
      preordered, = preorder_purchase
      preordered.update_attribute(:is_preorder_authorization, true)

      send_json(:post, "/purchases/#{preordered.external_id}/resend_receipt")

      expect(response).to have_http_status(:no_content)
      expect(SendPurchaseReceiptJob.jobs.size).to eq(0)
    end

    it "enqueues the receipts of a gift sender and of its giftee", parity: true do
      purchase.update_attribute(:is_gift_sender_purchase, true)
      giftee_purchase = build(:purchase, link: product, seller:, email: "giftee@example.com", purchase_state: "gift_receiver_purchase_successful").tap { _1.save!(validate: false) }
      giftee_purchase.update_attribute(:is_gift_receiver_purchase, true)
      create(:gift, link: product, gifter_purchase: purchase, giftee_purchase:)

      send_json(:post, "/purchases/#{purchase.external_id}/resend_receipt")

      expect(response).to have_http_status(:no_content)
      expect(SendPurchaseReceiptJob.jobs.size).to eq(2)
    end

    it "enqueues only the sender's receipt when the gift has no giftee purchase", parity: true do
      purchase.update_attribute(:is_gift_sender_purchase, true)
      create(:gift, link: product, gifter_purchase: purchase)

      send_json(:post, "/purchases/#{purchase.external_id}/resend_receipt")

      expect(response).to have_http_status(:no_content)
      expect(SendPurchaseReceiptJob.jobs.size).to eq(1)
    end

    it "enqueues only the sender's receipt when there is no gift", parity: true do
      purchase.update_attribute(:is_gift_sender_purchase, true)

      send_json(:post, "/purchases/#{purchase.external_id}/resend_receipt")

      expect(response).to have_http_status(:no_content)
      expect(SendPurchaseReceiptJob.jobs.size).to eq(1)
    end

    it "enqueues the receipt of a purchase whose charge belongs to an order", parity: true do
      order = create(:order)
      order.purchases << purchase
      create(:charge, order:, seller:, purchases: [purchase])

      send_json(:post, "/purchases/#{purchase.external_id}/resend_receipt")

      expect(response).to have_http_status(:no_content)
      expect(SendPurchaseReceiptJob.jobs.size).to eq(1)
    end

    it "answers 404 when the first purchase of the order has no email, whatever the email of this one", parity: true do
      order = create(:order)
      first = build(:purchase, link: product, seller:, email: "", purchase_state: "successful").tap { _1.save!(validate: false) }
      order.purchases << first
      order.purchases << purchase
      create(:charge, order:, seller:, purchases: [first, purchase])

      send_json(:post, "/purchases/#{purchase.external_id}/resend_receipt")

      expect(response).to have_http_status(:not_found)
      expect(SendPurchaseReceiptJob.jobs.size).to eq(0)
    end
  end

  describe "resubscribing" do
    it "answers 404 for a purchase that does not exist", parity: true do
      get "/purchases/nosuchpurchase/subscribe"

      expect(response).to have_http_status(:not_found)
    end

    it "hands the resubscribe page to Rails", parity: true do
      get "/purchases/#{purchase.external_id}/subscribe"

      expect(response).to have_http_status(:ok)
      expect(response.body).to include("Resubscribe to this creator")
    end

    it "answers 404 when a purchase that does not exist is resubscribed", parity: true do
      post "/purchases/nosuchpurchase/subscribe", params: { authenticity_token: csrf_token }

      expect(response).to have_http_status(:not_found)
    end

    it "hands the resubscribe of a buyer who unsubscribed to Rails", parity: true do
      purchase.update_columns(can_contact: false)

      post "/purchases/#{purchase.external_id}/subscribe", params: { authenticity_token: csrf_token }

      expect(response).to have_http_status(:ok)
      expect(purchase.reload.can_contact).to be(true)
    end
  end

  describe "unsubscribing" do
    it "answers 404 for a purchase that does not exist", parity: true do
      get "/purchases/nosuchpurchase/unsubscribe"

      expect(response).to have_http_status(:not_found)
    end

    it "answers 404 for a token of another scope", parity: true do
      get "/purchases/#{purchase.secure_external_id(scope: "confirm")}/unsubscribe"

      expect(response).to have_http_status(:not_found)
    end

    it "hands the unsubscribe behind a signed token to Rails", parity: true do
      get "/purchases/#{purchase.secure_external_id(scope: "unsubscribe")}/unsubscribe"

      expect(response).to have_http_status(:ok)
      expect(purchase.reload.can_contact).to be(false)
    end

    it "hands the legacy external id to Rails, which redirects to the signed confirmation form", parity: true do
      get "/purchases/#{purchase.external_id}/unsubscribe"

      expect(response).to have_http_status(:found)
      expect(response.location).to include("/secure_url_redirect")
    end
  end

  describe "confirming a purchase" do
    it "answers 404 for a token that opens nothing", parity: true do
      send_json(:post, "/purchases/nosuchpurchase/confirm")

      expect(response).to have_http_status(:not_found)
    end

    it "answers 404 for a token of another scope", parity: true do
      send_json(:post, "/purchases/#{purchase.secure_external_id(scope: "unsubscribe")}/confirm")

      expect(response).to have_http_status(:not_found)
    end

    it "hands the confirmation of a purchase to Rails", parity: true do
      send_json(:post, "/purchases/#{purchase.secure_external_id(scope: "confirm")}/confirm")

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body).to include("success" => true)
    end
  end

  describe "charging a preorder" do
    it "answers 404 for a preorder that does not exist", parity: true do
      send_json(:post, "/preorders/nosuchpreorder/charge_preorder")

      expect(response).to have_http_status(:not_found)
    end

    it "hands the charge of a preorder to Rails", parity: true do
      _, preorder = preorder_purchase
      preorder.update_columns(state: "in_progress")

      send_json(:post, "/preorders/#{preorder.external_id}/charge_preorder")

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body).to include("success" => true)
    end
  end

  describe "updating a subscription" do
    let(:membership) { create(:subscription_product, user: seller, unique_permalink: "member") }
    let(:subscription) do
      create(:subscription, link: membership, user: create(:user)).tap do |created|
        build(:purchase, link: membership, seller:, subscription: created, is_original_subscription_purchase: true, purchase_state: "successful").save!(validate: false)
      end
    end

    def manage_cookie_for(target)
      jar = ActionDispatch::Request.new(Rails.application.env_config.deep_dup).cookie_jar
      jar.encrypted[target.cookie_key] = target.external_id
      cookies[target.cookie_key] = jar[target.cookie_key]
    end

    it "answers 404 for a subscription that does not exist", parity: true do
      send_json(:put, "/subscriptions/nosuchsubscription", { perceived_price_cents: "0" })

      expect(response).to have_http_status(:not_found)
    end

    it "answers 404 for a visitor without the manage cookie of the subscription", parity: true do
      send_json(:put, "/subscriptions/#{subscription.external_id}", { perceived_price_cents: "0" })

      expect(response).to have_http_status(:not_found)
    end

    it "hands the update of a subscription its manage cookie opens to Rails", parity: true do
      manage_cookie_for(subscription)

      send_json(:put, "/subscriptions/#{subscription.external_id}", { perceived_price_cents: "0" })

      expect(response).to have_http_status(:ok)
    end
  end
end
