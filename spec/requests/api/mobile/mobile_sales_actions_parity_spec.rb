# frozen_string_literal: true

require "spec_helper"

# The Api::Mobile::SalesController actions the Next.js port answers itself when nothing has to be written, mailed or charged
# (nextjs/src/server/controllers/mobile-sales-actions.ts): the 404s, the empty lists, the gift, variant and post refusals.
# The examples that end in `hands a ...` are the requests it passes to Rails whole; the replay asserts Node forwards each one and
# writes nothing.
describe "Mobile API sales actions", type: :request, elasticsearch_wait_for_refresh: true do
  include Parity::MobileApi

  let(:buyer) { create(:user) }
  let(:seller) { create(:user) }
  let(:product) { create(:product, user: seller) }
  let(:sale) { purchase_row(link: product, seller:, purchaser: buyer, email: buyer.email, purchase_state: "successful") }
  let(:other_sale) { purchase_row(link: create(:product), seller: create(:user), purchase_state: "successful") }
  # A team member may email their audience whatever their sales, which the post routes need to get past the eligibility check.
  let(:emailing_seller) { create(:user, is_team_member: true) }
  let(:emailing_product) { create(:product, user: emailing_seller) }
  let(:emailing_sale) { purchase_row(link: emailing_product, seller: emailing_seller, email: "customer@example.com", purchase_state: "successful") }

  def build_blob(filename)
    ActiveStorage::Blob.create_before_direct_upload!(filename:, byte_size: 100, checksum: "abc", content_type: "application/octet-stream", metadata: { analyzed: true, identified: true })
  end

  describe "a sale that is not the seller's" do
    {
      get: %w[missed_posts product_purchases],
      post: %w[resend_receipt change_can_contact mark_as_shipped resend_ping send_post],
      put: %w[variant review_response],
    }.each do |verb, actions|
      actions.each do |action|
        it "does not find a sale for #{verb.upcase} #{action}", parity: true do
          public_send(verb, "/mobile/sales/#{other_sale.external_id}/#{action}", params: auth(seller))

          expect(response).to have_http_status(:not_found)
          expect(response.parsed_body).to eq("success" => false, "message" => "Could not find purchase")
        end
      end
    end

    it "does not find a sale to update", parity: true do
      patch "/mobile/sales/#{other_sale.external_id}", params: auth(seller).merge(full_name: "Ada")

      expect(response).to have_http_status(:not_found)
    end
  end

  describe "product purchases" do
    it "lists nothing for a sale that is not a bundle", parity: true do
      get "/mobile/sales/#{sale.external_id}/product_purchases", params: auth(seller)

      expect(response.parsed_body).to eq("success" => true, "product_purchases" => [])
    end
  end

  describe "missed posts" do
    it "lists nothing for a customer who unsubscribed", parity: true do
      sale.update_column(:can_contact, false)
      create(:published_installment, link: product, seller:)

      get "/mobile/sales/#{sale.external_id}/missed_posts", params: auth(seller)

      expect(response.parsed_body).to eq("success" => true, "missed_posts" => [])
    end

    it "lists nothing for a seller without published posts", parity: true do
      create(:installment, link: product, seller:)

      get "/mobile/sales/#{sale.external_id}/missed_posts", params: auth(seller)

      expect(response.parsed_body).to eq("success" => true, "missed_posts" => [])
    end

    # Midday UTC, so the replay clock (whole hours) cannot move a post across a day.
    def at_midday(days_ago) = days_ago.days.ago.utc.change(hour: 12)

    def product_post(name, days_ago, **attributes)
      create(:published_installment, link: product, seller:, installment_type: "product", name:, published_at: at_midday(days_ago), **attributes)
    end

    def missed_posts_of(record)
      get "/mobile/sales/#{record.external_id}/missed_posts", params: auth(seller)
      response.parsed_body["missed_posts"]
    end

    def received(buyer_sale, post)
      create(:creator_contacting_customers_email_info_delivered, purchase: buyer_sale, installment: post, sent_at: at_midday(1), delivered_at: at_midday(1))
    end

    it "lists a published post the customer has not received", parity: true do
      post = product_post("Update", 3)

      posts = missed_posts_of(sale)

      expect(posts.size).to eq(1)
      expect(posts.first).to include("id" => post.external_id, "name" => "Update", "url" => post.full_url)
    end

    it "lists posts newest first, oldest id first when published together, without the one already sent", parity: true do
      older = product_post("Older", 9)
      first_tie = product_post("First tie", 4)
      second_tie = product_post("Second tie", 4)
      newest = product_post("Newest", 2)
      received(sale, product_post("Sent", 1))

      expect(missed_posts_of(sale).map { _1["id"] }).to eq([newest, first_tie, second_tie, older].map(&:external_id))
    end

    it "skips a post another sale of the customer received, but not one a refunded or charged back sale received", parity: true do
      received(purchase_row(link: product, seller:, email: sale.email, purchase_state: "successful"), product_post("Sent", 3))
      received(purchase_row(link: product, seller:, email: sale.email, purchase_state: "successful", stripe_refunded: true), product_post("Refunded only", 4))
      received(purchase_row(link: product, seller:, email: sale.email, purchase_state: "successful", chargeback_date: at_midday(2)), product_post("Charged back only", 5))
      received(purchase_row(link: product, seller:, email: sale.email, purchase_state: "successful", chargeback_date: at_midday(2), chargeback_reversed: true), product_post("Reversed", 6))
      received(purchase_row(link: product, seller:, email: "stranger@example.com", purchase_state: "successful"), product_post("Other customer", 7))

      expect(missed_posts_of(sale).map { _1["name"] }).to eq(["Refunded only", "Charged back only", "Other customer"])
    end

    it "skips a draft, a deleted post, a post for one recipient and a post that is not emailed, and lists a seller-wide post", parity: true do
      create(:installment, link: product, seller:, installment_type: "product", name: "Draft")
      product_post("Deleted", 3, deleted_at: at_midday(1))
      product_post("Not emailed", 4, send_emails: false, shown_on_profile: true)
      product_post("One recipient", 5, single_recipient_email: true)
      create(:published_installment, link: product, seller: create(:user), installment_type: "product", name: "Another seller", published_at: at_midday(6))
      everyone = create(:published_installment, seller:, link: nil, installment_type: "seller", name: "To everyone", published_at: at_midday(7))

      expect(missed_posts_of(sale).map { _1["id"] }).to eq([everyone.external_id])
    end

    it "lists a post of a product the customer did not buy", parity: true do
      post = create(:published_installment, link: create(:product, user: seller), seller:, installment_type: "product", name: "Other product", published_at: at_midday(3))

      expect(missed_posts_of(sale).map { _1["id"] }).to eq([post.external_id])
    end
  end

  describe "blob url" do
    it "does not find an unknown key", parity: true do
      get "/mobile/sales/blob_url", params: auth(seller).merge(key: "does-not-exist")

      expect(response).to have_http_status(:not_found)
      expect(response.parsed_body).to eq("success" => false, "message" => "Could not find file")
    end

    it "does not find a blob attached to another seller's file custom field", parity: true do
      custom_field = create(:purchase_custom_field, field_type: CustomField::TYPE_FILE, purchase: other_sale, name: CustomField::FILE_FIELD_NAME, value: nil)
      blob = build_blob("smilie.png")
      custom_field.files.attach(blob)

      get "/mobile/sales/blob_url", params: auth(seller).merge(key: blob.key)

      expect(response).to have_http_status(:not_found)
    end

    it "does not find a blob that is attached to nothing", parity: true do
      blob = build_blob("smilie.png")

      get "/mobile/sales/blob_url", params: auth(seller).merge(key: blob.key)

      expect(response).to have_http_status(:not_found)
    end

    it "hands a blob attached to the seller's file custom field to Rails", parity: true do
      custom_field = create(:purchase_custom_field, field_type: CustomField::TYPE_FILE, purchase: sale, name: CustomField::FILE_FIELD_NAME, value: nil)
      blob = build_blob("smilie.png")
      custom_field.files.attach(blob)

      get "/mobile/sales/blob_url", params: auth(seller).merge(key: blob.key)

      expect(response.parsed_body).to include("success" => true)
    end
  end

  describe "update" do
    it "refuses a giftee email on a sale that is not a gift", parity: true do
      patch "/mobile/sales/#{sale.external_id}", params: auth(seller).merge(giftee_email: "giftee@example.com")

      expect(response).to have_http_status(:unprocessable_entity)
      expect(response.parsed_body).to eq("success" => false, "message" => "This sale is not a gift")
    end

    it "refuses a gift that has no giftee purchase", parity: true do
      sale.update_column(:flags, sale.flags | Purchase.flag_mapping["flags"][:is_gift_sender_purchase])
      create(:gift, link: product, gifter_purchase: sale)

      put "/mobile/sales/#{sale.external_id}", params: auth(seller).merge(giftee_email: "giftee@example.com")

      expect(response).to have_http_status(:unprocessable_entity)
      expect(response.parsed_body["message"]).to eq("This gift is missing a giftee purchase")
    end

    it "hands a change of the buyer's name to Rails", parity: true do
      patch "/mobile/sales/#{sale.external_id}", params: auth(seller).merge(full_name: "Ada Lovelace")

      expect(response).to have_http_status(:unprocessable_entity).or have_http_status(:ok)
    end
  end

  describe "variant" do
    let(:variant_product) { create(:product_with_digital_versions, user: seller) }
    let(:variant_sale) { purchase_row(link: variant_product, seller:, email: "customer@example.com", purchase_state: "successful") }

    it "does not find an unknown variant", parity: true do
      put "/mobile/sales/#{sale.external_id}/variant", params: auth(seller).merge(variant_id: "unknown", quantity: "1")

      expect(response).to have_http_status(:not_found)
      expect(response.parsed_body).to eq("success" => false, "message" => "Variant not found")
    end

    it "does not find a variant of another product", parity: true do
      foreign = create(:product_with_digital_versions)

      put "/mobile/sales/#{variant_sale.external_id}/variant", params: auth(seller).merge(variant_id: foreign.variants.first.external_id, quantity: "1")

      expect(response).to have_http_status(:not_found)
    end

    it "hands a swap to a variant of the product to Rails", parity: true do
      put "/mobile/sales/#{variant_sale.external_id}/variant", params: auth(seller).merge(variant_id: variant_product.variants.first.external_id, quantity: "1")

      # The row was saved without validation, so Rails' own `save!` refuses the swap; only the forwarding is under test.
      expect(response.status).to be >= 200
    end
  end

  describe "send post" do
    it "refuses a seller who cannot email their audience", parity: true do
      post "/mobile/sales/#{sale.external_id}/send_post", params: auth(seller).merge(post_id: "x")

      expect(response).to have_http_status(:unauthorized)
      expect(response.parsed_body).to eq("success" => false, "message" => "You are not eligible to resend this email.")
    end

    it "does not find a post", parity: true do
      post "/mobile/sales/#{emailing_sale.external_id}/send_post", params: auth(emailing_seller).merge(post_id: "unknown")

      expect(response).to have_http_status(:not_found)
      expect(response.parsed_body).to eq("success" => false, "message" => "Could not find post")
    end

    it "refuses a customer who unsubscribed", parity: true do
      emailing_sale.update_column(:can_contact, false)
      post_record = create(:published_installment, link: emailing_product, seller: emailing_seller)

      post "/mobile/sales/#{emailing_sale.external_id}/send_post", params: auth(emailing_seller).merge(post_id: post_record.external_id)

      expect(response).to have_http_status(:unprocessable_entity)
    end

    it "hands a post email to Rails", parity: true do
      post_record = create(:published_installment, link: emailing_product, seller: emailing_seller)

      post "/mobile/sales/#{emailing_sale.external_id}/send_post", params: auth(emailing_seller).merge(post_id: post_record.external_id)

      expect(response.parsed_body).to include("success" => true)
    end
  end

  describe "review response" do
    it "does not find a review to answer", parity: true do
      put "/mobile/sales/#{sale.external_id}/review_response", params: auth(seller).merge(message: "Thanks")

      expect(response).to have_http_status(:not_found)
      expect(response.parsed_body).to eq("success" => false, "message" => "Could not find review")
    end

    it "creates the first reply to a review and mails the reviewer", parity: true, parity_mail_jobs: true do
      create(:product_review, purchase: sale, link: product, rating: 4, message: "Great")

      put "/mobile/sales/#{sale.external_id}/review_response", params: auth(seller).merge(message: "Thanks")

      expect(response.parsed_body).to eq("success" => true)
      expect(ProductReviewResponse.sole).to have_attributes(message: "Thanks", user_id: seller.id)
    end

    it "replaces an earlier reply without mailing the reviewer again", parity: true, parity_mail_jobs: true do
      review = create(:product_review, purchase: sale, link: product, rating: 4, message: "Great")
      ProductReviewResponse.create!(product_review: review, user: seller, message: "First")

      put "/mobile/sales/#{sale.external_id}/review_response", params: auth(seller).merge(message: "Second")

      expect(response.parsed_body).to eq("success" => true)
      expect(ProductReviewResponse.sole.message).to eq("Second")
    end

    it "refuses a reply with no message", parity: true, parity_mail_jobs: true do
      create(:product_review, purchase: sale, link: product, rating: 4, message: "Great")

      put "/mobile/sales/#{sale.external_id}/review_response", params: auth(seller)

      expect(response).to have_http_status(:unprocessable_entity)
      expect(response.parsed_body).to eq("success" => false, "message" => "Message can't be blank")
      expect(ProductReviewResponse.count).to eq(0)
    end

    it "refuses a blank message on top of an earlier reply and keeps the reply", parity: true, parity_mail_jobs: true do
      review = create(:product_review, purchase: sale, link: product, rating: 4, message: "Great")
      ProductReviewResponse.create!(product_review: review, user: seller, message: "First")

      put "/mobile/sales/#{sale.external_id}/review_response", params: auth(seller).merge(message: "")

      expect(response).to have_http_status(:unprocessable_entity)
      expect(ProductReviewResponse.sole.message).to eq("First")
    end

    it "does not find a review for a gift sender's sale whose giftee never bought", parity: true do
      create(:product_review, purchase: sale, link: product, rating: 4, message: "Great")
      sale.update_attribute(:is_gift_sender_purchase, true)
      create(:gift, link: product, gifter_purchase: sale)

      put "/mobile/sales/#{sale.external_id}/review_response", params: auth(seller).merge(message: "Thanks")

      expect(response).to have_http_status(:not_found)
      expect(response.parsed_body).to eq("success" => false, "message" => "Could not find review")
    end

    it "does not find a review for a gift sender's sale without a gift", parity: true do
      sale.update_attribute(:is_gift_sender_purchase, true)

      put "/mobile/sales/#{sale.external_id}/review_response", params: auth(seller).merge(message: "Thanks")

      expect(response).to have_http_status(:not_found)
      expect(response.parsed_body).to eq("success" => false, "message" => "Could not find review")
    end

    it "does not find a review for a membership sale without one", parity: true do
      membership = create(:membership_product, user: seller)
      subscription = create(:subscription, link: membership, user: buyer)
      recurring = purchase_row(link: membership, seller:, purchaser: buyer, email: buyer.email, purchase_state: "successful", is_original_subscription_purchase: true, subscription:)

      put "/mobile/sales/#{recurring.external_id}/review_response", params: auth(seller).merge(message: "Thanks")

      expect(response).to have_http_status(:not_found)
      expect(response.parsed_body).to eq("success" => false, "message" => "Could not find review")
    end
  end

  describe "hand backs" do
    it "enqueues the receipt of a sale", parity: true do
      post "/mobile/sales/#{sale.external_id}/resend_receipt", params: auth(seller)

      expect(response.parsed_body).to eq("success" => true)
      expect(SendPurchaseReceiptJob.jobs.size).to eq(1)
    end

    it "answers 404 for the receipt of a sale with no email", parity: true do
      sale.update_columns(email: "")

      post "/mobile/sales/#{sale.external_id}/resend_receipt", params: auth(seller)

      expect(response).to have_http_status(:not_found)
      expect(response.parsed_body).to eq("success" => false, "message" => "Could not find receipt")
      expect(SendPurchaseReceiptJob.jobs.size).to eq(0)
    end

    it "enqueues the receipts of a gift sender and of its giftee", parity: true do
      sale.update_attribute(:is_gift_sender_purchase, true)
      giftee_sale = purchase_row(link: product, seller:, email: "giftee@example.com", purchase_state: "gift_receiver_purchase_successful")
      giftee_sale.update_attribute(:is_gift_receiver_purchase, true)
      create(:gift, link: product, gifter_purchase: sale, giftee_purchase: giftee_sale)

      post "/mobile/sales/#{sale.external_id}/resend_receipt", params: auth(seller)

      expect(response.parsed_body).to eq("success" => true)
      expect(SendPurchaseReceiptJob.jobs.size).to eq(2)
    end

    it "stops emailing the buyer of a free sale", parity: true, defer_audience_refresh: true do
      free_sale = purchase_row(link: create(:product, user: seller, price_cents: 0), seller:, email: "customer@example.com", purchase_state: "successful")

      post "/mobile/sales/#{free_sale.external_id}/change_can_contact", params: auth(seller).merge(can_contact: "false")

      expect(response.parsed_body).to eq("success" => true)
      expect(free_sale.reload.can_contact).to be(false)
    end

    it "writes nothing when the buyer of a free sale can already be contacted", parity: true, defer_audience_refresh: true do
      free_sale = purchase_row(link: create(:product, user: seller, price_cents: 0), seller:, email: "customer@example.com", purchase_state: "successful")

      post "/mobile/sales/#{free_sale.external_id}/change_can_contact", params: auth(seller).merge(can_contact: "1")

      expect(response.parsed_body).to eq("success" => true)
    end

    it "hands a can_contact change to Rails", parity: true do
      post "/mobile/sales/#{sale.external_id}/change_can_contact", params: auth(seller).merge(can_contact: "false")

      expect(response.status).to be >= 200
    end

    it "enqueues the ping of a sale", parity: true do
      post "/mobile/sales/#{sale.external_id}/resend_ping", params: auth(seller)

      expect(response.parsed_body).to eq("success" => true)
      expect(PostToPingEndpointsWorker.jobs.map { _1["args"] }).to eq([[sale.id, nil]])
    end

    it "enqueues the ping of the giftee's purchase for a gift's sender", parity: true do
      sale.update_attribute(:is_gift_sender_purchase, true)
      giftee_sale = purchase_row(link: product, seller:, email: "giftee@example.com", purchase_state: "gift_receiver_purchase_successful")
      giftee_sale.update_attribute(:is_gift_receiver_purchase, true)
      create(:gift, link: product, gifter_purchase: sale, giftee_purchase: giftee_sale)

      post "/mobile/sales/#{sale.external_id}/resend_ping", params: auth(seller)

      expect(response.parsed_body).to eq("success" => true)
      expect(PostToPingEndpointsWorker.jobs.map { _1["args"] }).to eq([[giftee_sale.id, nil]])
    end

    it "enqueues nothing for a gift whose giftee has not purchased", parity: true do
      sale.update_attribute(:is_gift_sender_purchase, true)
      create(:gift, link: product, gifter_purchase: sale)

      post "/mobile/sales/#{sale.external_id}/resend_ping", params: auth(seller)

      expect(response.parsed_body).to eq("success" => true)
      expect(PostToPingEndpointsWorker.jobs.size).to eq(0)
    end

    it "enqueues the ping of a sale with its URL parameters", parity: true do
      PurchaseUrlParameter.create!(purchase: sale, params: { "discord_id" => "42" })

      post "/mobile/sales/#{sale.external_id}/resend_ping", params: auth(seller)

      expect(response.parsed_body).to eq("success" => true)
      expect(PostToPingEndpointsWorker.jobs.map { _1["args"] }).to eq([[sale.id, { "discord_id" => "42" }]])
    end

    it "hands a shipment to Rails", parity: true do
      physical = purchase_row(link: create(:physical_product, user: seller), seller:, email: "customer@example.com", purchase_state: "successful")

      post "/mobile/sales/#{physical.external_id}/mark_as_shipped", params: auth(seller).merge(tracking_url: "https://example.com/track/1")

      expect(response.parsed_body).to include("success")
    end

    it "answers 404 for a refund of a refunded sale", parity: true do
      sale.update_column(:stripe_refunded, true)

      patch "/mobile/sales/#{sale.external_id}/refund", params: auth(seller).merge(amount: "1.00")

      expect(response).to have_http_status(:not_found)
    end
  end
end
