# frozen_string_literal: true

require "spec_helper"

# POST /paypal/billing_agreement_token and POST /paypal/billing_agreement, recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/paypal-billing-agreements.replay.test.ts. PayPal answers from WebMock; the replay serves the same answers from a local
# stand-in and asserts the calls Node made (method, URL, body, order) are the ones Rails made. The agreement and token bodies are read out of
# the VCR cassettes of spec/controllers/paypal_controller_spec.rb, recorded against api.sandbox.paypal.com.
describe "PayPal billing agreements", type: :request do
  include Parity::AudienceSignedIn

  let(:json_headers) do
    { "Accept" => "application/json", "X-Requested-With" => "XMLHttpRequest", "Content-Type" => "application/json", "Referer" => "http://#{DOMAIN}/l/example" }
  end
  let(:paypal_api) { "https://api.sandbox.paypal.com" }
  let(:json_utf8) { "application/json;charset=UTF-8" }

  before do
    host! DOMAIN
    $redis.flushdb
  end

  def recorded_body(cassette)
    path = Rails.root.join("spec/support/fixtures/vcr_cassettes/PaypalController", cassette)
    YAML.safe_load_file(path, permitted_classes: [Symbol])["http_interactions"].first["response"]["body"]["string"]
  end

  def cache_partner_token = $redis.set("paypal_partner_rest_auth_token:#{PaypalPartnerRestCredentials::TOKEN_KEY}", "Bearer cached-partner-token")

  def stub_paypal(path, status:, body:, content_type: json_utf8)
    stub_request(:post, "#{paypal_api}#{path}").to_return(status:, body:, headers: { "Content-Type" => content_type.dup }) # paypalhttp downcases header values in place
  end

  def post_paypal(action, params = {})
    post "/paypal/#{action}", params: params.to_json, headers: json_headers.merge("X-CSRF-Token" => csrf_token)
  end

  def skip_shipping_address(request) = JSON.parse(request.body).dig("plan", "merchant_preferences", "skip_shipping_address")

  describe "POST /paypal/billing_agreement_token" do
    let(:path) { "/v1/billing-agreements/agreement-tokens" }
    let(:issued) { recorded_body("_billing_agreement_token/when_request_passes/returns_a_valid_billing_agreement_token_id.yml") }

    it "renders the token id PayPal issued with the cached partner token", parity: true do
      cache_partner_token
      stub_paypal(path, status: 201, body: issued)

      post_paypal("billing_agreement_token")

      expect(response.parsed_body).to eq("billing_agreement_token_id" => "BA-7TR16712TA5219609")
      expect(WebMock).not_to have_requested(:post, %r{/v1/oauth2/token})
      expect(WebMock).to have_requested(:post, "#{paypal_api}#{path}").with { |request| skip_shipping_address(request) == true }
    end

    it "fetches the partner token first when none is cached", parity: true do
      stub_paypal("/v1/oauth2/token", status: 200, body: { token_type: "Bearer", access_token: "A21AAfresh", expires_in: 32_400 }.to_json)
      stub_paypal(path, status: 201, body: issued)

      post_paypal("billing_agreement_token")

      expect(response.parsed_body).to eq("billing_agreement_token_id" => "BA-7TR16712TA5219609")
      expect(WebMock).to have_requested(:post, "#{paypal_api}#{path}").with(headers: { "Authorization" => "Bearer A21AAfresh" })
    end

    it "asks for a shipping address when shipping is the string true", parity: true do
      cache_partner_token
      stub_paypal(path, status: 201, body: issued)

      post_paypal("billing_agreement_token", shipping: "true")

      expect(WebMock).to have_requested(:post, "#{paypal_api}#{path}").with { |request| skip_shipping_address(request) == false }
    end

    it "does not ask for a shipping address when shipping is the JSON boolean true", parity: true do
      cache_partner_token
      stub_paypal(path, status: 201, body: issued)

      post_paypal("billing_agreement_token", shipping: true)

      expect(WebMock).to have_requested(:post, "#{paypal_api}#{path}").with { |request| skip_shipping_address(request) == true }
    end

    it "renders a null token id when PayPal refuses the request", parity: true do
      cache_partner_token
      stub_paypal(path, status: 400, body: { name: "VALIDATION_ERROR", message: "Invalid request - see details" }.to_json)

      post_paypal("billing_agreement_token")

      expect(response.parsed_body).to eq("billing_agreement_token_id" => nil)
    end

    it "renders a null token id when PayPal refuses a request whose body still names a token", parity: true do
      cache_partner_token
      stub_paypal(path, status: 400, body: { token_id: "BA-7TR16712TA5219609" }.to_json)

      post_paypal("billing_agreement_token")

      expect(response.parsed_body).to eq("billing_agreement_token_id" => nil)
    end

    it "renders a null token id when PayPal succeeds without a token", parity: true do
      cache_partner_token
      stub_paypal(path, status: 201, body: { links: [] }.to_json)

      post_paypal("billing_agreement_token")

      expect(response.parsed_body).to eq("billing_agreement_token_id" => nil)
    end

    it "renders a null token id when PayPal answers with a blank token", parity: true do
      cache_partner_token
      stub_paypal(path, status: 201, body: { token_id: "  " }.to_json)

      post_paypal("billing_agreement_token")

      expect(response.parsed_body).to eq("billing_agreement_token_id" => nil)
    end

    it "renders a null token id when PayPal answers in plain text", parity: true do
      cache_partner_token
      stub_paypal(path, status: 201, body: "BA-7TR16712TA5219609", content_type: "text/plain")

      post_paypal("billing_agreement_token")

      expect(response.parsed_body).to eq("billing_agreement_token_id" => nil)
    end

    it "renders a null token id when PayPal answers with a JSON list", parity: true do
      cache_partner_token
      stub_paypal(path, status: 201, body: "[]")

      post_paypal("billing_agreement_token")

      expect(response.parsed_body).to eq("billing_agreement_token_id" => nil)
    end

    it "renders a null token id when PayPal refuses the partner credentials", parity: true do
      stub_paypal("/v1/oauth2/token", status: 401, body: { name: "AUTHENTICATION_FAILURE" }.to_json)
      stub_paypal(path, status: 401, body: { name: "AUTHENTICATION_FAILURE" }.to_json)

      post_paypal("billing_agreement_token")

      expect(response.parsed_body).to eq("billing_agreement_token_id" => nil)
    end
  end

  describe "POST /paypal/billing_agreement" do
    let(:path) { "/v1/billing-agreements/agreements" }
    let(:agreement) { recorded_body("_billing_agreement/when_request_is_valid/returns_a_valid_billing_agreement.yml") }
    let(:refusal) { recorded_body("_billing_agreement/when_request_is_invalid/returns_nil.yml") }

    it "renders the agreement PayPal created", parity: true do
      cache_partner_token
      stub_paypal(path, status: 201, body: agreement)

      post_paypal("billing_agreement", billing_agreement_token_id: "BA-7TR16712TA5219609")

      expect(response.parsed_body).to include("id" => "B-1NN687283L635633R", "state" => "ACTIVE")
      expect(WebMock).to have_requested(:post, "#{paypal_api}#{path}").with(body: { token_id: "BA-7TR16712TA5219609" }.to_json, headers: { "Paypal-Request-Id" => "create-billing-agreement-BA-7TR16712TA5219609" })
    end

    it "renders null when PayPal refuses the token", parity: true do
      cache_partner_token
      stub_paypal(path, status: 400, body: refusal)

      post_paypal("billing_agreement", billing_agreement_token_id: "invalid_billing_agreement_token_id")

      expect(response.body).to eq("null")
    end

    it "renders null when PayPal refuses a request whose body still carries an agreement id", parity: true do
      cache_partner_token
      stub_paypal(path, status: 400, body: { id: "B-1NN687283L635633R" }.to_json)

      post_paypal("billing_agreement", billing_agreement_token_id: "BA-7TR16712TA5219609")

      expect(response.body).to eq("null")
    end

    it "renders null when PayPal succeeds without an agreement id", parity: true do
      cache_partner_token
      stub_paypal(path, status: 201, body: { state: "ACTIVE" }.to_json)

      post_paypal("billing_agreement", billing_agreement_token_id: "BA-7TR16712TA5219609")

      expect(response.body).to eq("null")
    end

    it "renders null when PayPal answers in plain text", parity: true do
      cache_partner_token
      stub_paypal(path, status: 201, body: "created", content_type: "text/plain")

      post_paypal("billing_agreement", billing_agreement_token_id: "BA-7TR16712TA5219609")

      expect(response.body).to eq("null")
    end

    it "hands a request without a billing agreement token id to Rails", parity: true do
      cache_partner_token
      stub_paypal(path, status: 400, body: refusal)

      post_paypal("billing_agreement")

      expect(response.body).to eq("null")
      expect(WebMock).to have_requested(:post, "#{paypal_api}#{path}").with(body: { token_id: nil }.to_json)
    end

    it "hands a billing agreement token id that is a list to Rails", parity: true do
      cache_partner_token
      stub_paypal(path, status: 400, body: refusal)

      post_paypal("billing_agreement", billing_agreement_token_id: ["BA-1"])

      expect(response.body).to eq("null")
    end
  end
end
