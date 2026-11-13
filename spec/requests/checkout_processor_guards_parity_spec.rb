# frozen_string_literal: true

require "spec_helper"

# What the checkout's processor-facing routes answer before they touch a processor, recorded for the Next.js port (PARITY_RECORD=1):
# POST /orders/prepare, POST /orders/:id/{confirm,finalize,confirm_error} and POST /braintree/generate_transient_customer_token.
# nextjs/parity/__tests__/checkout-processor-guards.replay.test.ts replays the last request of each example. An example named
# "hands a ..." is one Node leaves to Rails whole. No processor is called: WebMock refuses any request.
describe "Checkout processor guards", type: :request do
  include Parity::AudienceSignedIn

  let(:seller) { create(:user) }
  let(:product) { create(:product, user: seller, unique_permalink: "guardsone", price_cents: 500) }
  let(:json_headers) do
    { "Accept" => "application/json", "X-Requested-With" => "XMLHttpRequest", "Content-Type" => "application/json", "Referer" => "http://#{DOMAIN}/checkout" }
  end

  before { host! DOMAIN }

  def post_json(path, body = {}, user_agent: nil)
    token = csrf_token
    cookies[:_gumroad_guid] = "guards-guid"
    headers = json_headers.merge("X-CSRF-Token" => token)
    headers["User-Agent"] = user_agent if user_agent
    post path, params: body.to_json, headers:
  end

  def line(uid: "uid-0", **extra)
    { uid:, permalink: product.unique_permalink, perceived_price_cents: 500, quantity: 1 }.merge(extra)
  end

  def order_body(*lines, **extra)
    { email: "buyer@example.com", cc_zipcode_required: "false", line_items: lines }.merge(extra)
  end

  describe "preparing a payment" do
    it "pretends a bot's order succeeded", parity: true do
      post_json("/orders/prepare", order_body(line), user_agent: "Googlebot/2.1")

      expect(response.parsed_body).to eq("success" => true)
    end

    it "refuses a cart above the product limit", parity: true do
      lines = Array.new(Cart::MAX_ALLOWED_CART_PRODUCTS + 1) { |i| line(uid: "uid-#{i}") }
      post_json("/orders/prepare", order_body(*lines))

      expect(response.parsed_body).to include("success" => false, "error_message" => "You cannot add more than 50 products to the cart.")
    end

    it "hands an order that passes the guards to Rails", parity: true do
      post_json("/orders/prepare", order_body(line, email: "not-an-email"))

      expect(response).to have_http_status(:ok)
    end
  end

  %w[confirm finalize confirm_error].each do |action|
    describe "#{action} of an order" do
      it "answers 404 for a token that is not an order's", parity: true do
        post_json("/orders/not-a-token/#{action}")

        expect(response).to have_http_status(:not_found)
      end

      it "answers 404 for a token of another scope", parity: true do
        order = create(:order)
        post_json("/orders/#{order.secure_external_id(scope: "something_else")}/#{action}")

        expect(response).to have_http_status(:not_found)
      end

      it "answers 404 for the token of an order that is gone", parity: true do
        order = create(:order)
        token = order.secure_external_id(scope: "confirm")
        order.destroy!
        post_json("/orders/#{token}/#{action}")

        expect(response).to have_http_status(:not_found)
      end
    end
  end

  describe "Braintree transient customer token" do
    it "answers null for a blank nonce", parity: true do
      post_json("/braintree/generate_transient_customer_token", { braintree_nonce: "" })

      expect(response.parsed_body).to eq("transient_customer_store_key" => nil)
    end

    it "answers null for a whitespace nonce", parity: true do
      post_json("/braintree/generate_transient_customer_token", { braintree_nonce: "  \n" })

      expect(response.parsed_body).to eq("transient_customer_store_key" => nil)
    end

    it "answers null when no nonce is sent", parity: true do
      post_json("/braintree/generate_transient_customer_token")

      expect(response.parsed_body).to eq("transient_customer_store_key" => nil)
    end
  end
end
