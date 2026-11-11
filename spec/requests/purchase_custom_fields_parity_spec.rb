# frozen_string_literal: true

require "spec_helper"

# POST /purchase_custom_fields (PurchaseCustomFieldsController#create), recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/purchase-custom-fields.replay.test.ts, which sends the last request of each example. Node saves the answer to
# a post-purchase text or long text field and answers the token and lookup 404s; an example named "hands a ..." is one Node leaves to
# Rails whole.
describe "Purchase custom fields", type: :request do
  include Parity::AudienceSignedIn

  let(:seller) { create(:user, name: "Answers Seller") }
  let(:product) { create(:product, user: seller, name: "Answered product", unique_permalink: "answered", created_at: Time.utc(2025, 1, 1)) }
  # A charged purchase would call Stripe.
  let(:purchase) { build(:purchase, link: product, seller:, email: "buyer@example.com", purchase_state: "successful").tap { _1.save!(validate: false) } }
  let(:url_redirect) { create(:url_redirect, link: product, purchase:) }
  let(:token) { url_redirect.token }
  let(:field) { create(:custom_field, seller:, products: [product], type: CustomField::TYPE_TEXT, is_post_purchase: true, name: "Favourite colour") }
  let(:json_headers) do
    { "Accept" => "application/json", "X-Requested-With" => "XMLHttpRequest", "Content-Type" => "application/json", "Referer" => "http://#{DOMAIN}/d/#{token}" }
  end

  before { host! DOMAIN }

  def save_answer(body)
    post "/purchase_custom_fields", params: body.to_json, headers: json_headers.merge("X-CSRF-Token" => csrf_token)
  end

  def params_for(custom_field = field, **overrides)
    { purchase_id: purchase.external_id, custom_field_id: custom_field.external_id, token:, value: "Blue" }.merge(overrides)
  end

  describe "saving an answer" do
    it "saves the first answer to a text field", parity: true do
      save_answer(params_for)

      expect(response).to have_http_status(:no_content)
      expect(purchase.purchase_custom_fields.sole).to have_attributes(value: "Blue", name: "Favourite colour", field_type: "text", is_post_purchase: true)
    end

    it "saves the first answer to a long text field", parity: true do
      long = create(:custom_field, seller:, products: [product], type: CustomField::TYPE_LONG_TEXT, is_post_purchase: true, name: "Tell us more")

      save_answer(params_for(long, value: "Line one\nLine two"))

      expect(response).to have_http_status(:no_content)
      expect(purchase.purchase_custom_fields.sole.value).to eq("Line one\nLine two")
    end

    it "strips and squeezes the spaces of the answer", parity: true do
      save_answer(params_for(value: "  Dark   green \t"))

      expect(response).to have_http_status(:no_content)
      expect(purchase.purchase_custom_fields.sole.value).to eq("Dark green")
    end

    it "replaces an earlier answer", parity: true do
      create(:purchase_custom_field, purchase:, custom_field: field, value: "Red", name: "Favourite colour")

      save_answer(params_for(value: "Green"))

      expect(response).to have_http_status(:no_content)
      expect(purchase.purchase_custom_fields.sole.value).to eq("Green")
    end

    it "clears an optional answer left blank", parity: true do
      create(:purchase_custom_field, purchase:, custom_field: field, value: "Red", name: "Favourite colour")

      save_answer(params_for(value: "   "))

      expect(response).to have_http_status(:no_content)
      expect(purchase.purchase_custom_fields.sole.read_attribute(:value)).to be_nil
    end

    it "saves an answer sent without a value as empty", parity: true do
      save_answer(params_for.except(:value))

      expect(response).to have_http_status(:no_content)
      expect(purchase.purchase_custom_fields.sole.read_attribute(:value)).to be_nil
    end

    it "accepts any URL redirect token of the purchase", parity: true do
      other = create(:url_redirect, link: product, purchase:)

      save_answer(params_for(token: other.token))

      expect(response).to have_http_status(:no_content)
    end
  end

  describe "guards" do
    it "answers 404 for a purchase that does not exist", parity: true do
      save_answer(params_for(purchase_id: "nosuchpurchase"))

      expect(response).to have_http_status(:not_found)
    end

    it "answers 404 without a token", parity: true do
      save_answer(params_for.except(:token))

      expect(response).to have_http_status(:not_found)
      expect(PurchaseCustomField.count).to eq(0)
    end

    it "answers 404 with a blank token", parity: true do
      save_answer(params_for(token: ""))

      expect(response).to have_http_status(:not_found)
    end

    it "answers 404 with a token that is not text", parity: true do
      save_answer(params_for(token: 1234))

      expect(response).to have_http_status(:not_found)
    end

    it "answers 404 with the token of another purchase", parity: true do
      other_purchase = build(:purchase, link: product, seller:, email: "other@example.com", purchase_state: "successful").tap { _1.save!(validate: false) }
      other = create(:url_redirect, link: product, purchase: other_purchase)

      save_answer(params_for(token: other.token))

      expect(response).to have_http_status(:not_found)
      expect(PurchaseCustomField.count).to eq(0)
    end

    it "answers 404 for a custom field that does not exist", parity: true do
      save_answer(params_for(custom_field_id: "nosuchfield"))

      expect(response).to have_http_status(:not_found)
    end

    it "answers 404 for a custom field of another product", parity: true do
      elsewhere = create(:custom_field, seller:, products: [create(:product, user: seller)], type: CustomField::TYPE_TEXT, is_post_purchase: true, name: "Elsewhere")

      save_answer(params_for(elsewhere))

      expect(response).to have_http_status(:not_found)
    end

    it "answers 404 for a checkout custom field", parity: true do
      checkout_field = create(:custom_field, seller:, products: [product], type: CustomField::TYPE_TEXT, is_post_purchase: false, name: "At checkout")

      save_answer(params_for(checkout_field))

      expect(response).to have_http_status(:not_found)
    end
  end

  describe "requests Rails answers" do
    it "hands an answer to a file field to Rails", parity: true do
      file_field = create(:custom_field, seller:, products: [product], type: CustomField::TYPE_FILE, is_post_purchase: true, name: "Upload")

      save_answer(params_for(file_field).except(:value).merge(file_signed_ids: []))

      expect(response).to have_http_status(:no_content)
    end

    it "hands a blank answer to a required field to Rails", parity: true do
      required = create(:custom_field, seller:, products: [product], type: CustomField::TYPE_TEXT, is_post_purchase: true, required: true, name: "Required")

      save_answer(params_for(required, value: ""))

      expect(response).to have_http_status(:unprocessable_content)
    end

    it "hands a request without a purchase_id to Rails", parity: true do
      save_answer(params_for.except(:purchase_id))

      expect(response).to have_http_status(:bad_request)
    end

    it "hands a request without a custom_field_id to Rails", parity: true do
      save_answer(params_for.except(:custom_field_id))

      expect(response).to have_http_status(:bad_request)
    end

    it "hands an answer that is a number to Rails", parity: true do
      save_answer(params_for(value: 42))

      expect(response).to have_http_status(:no_content)
    end
  end
end
