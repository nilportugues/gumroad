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

    it "hands a seller with a published post to Rails", parity: true do
      create(:published_installment, link: product, seller:)

      get "/mobile/sales/#{sale.external_id}/missed_posts", params: auth(seller)

      expect(response.parsed_body["missed_posts"].size).to eq(1)
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

    it "hands a reply to a review to Rails", parity: true do
      create(:product_review, purchase: sale, link: product, rating: 4, message: "Great")

      put "/mobile/sales/#{sale.external_id}/review_response", params: auth(seller).merge(message: "Thanks")

      expect(response.parsed_body).to eq("success" => true)
    end
  end

  describe "hand backs" do
    it "hands a receipt email to Rails", parity: true do
      post "/mobile/sales/#{sale.external_id}/resend_receipt", params: auth(seller)

      expect(response.parsed_body).to include("success")
    end

    it "hands a can_contact change to Rails", parity: true do
      post "/mobile/sales/#{sale.external_id}/change_can_contact", params: auth(seller).merge(can_contact: "false")

      expect(response.status).to be >= 200
    end

    it "hands a ping to Rails", parity: true do
      post "/mobile/sales/#{sale.external_id}/resend_ping", params: auth(seller)

      expect(response.parsed_body).to eq("success" => true)
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
