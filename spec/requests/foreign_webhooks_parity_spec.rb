# frozen_string_literal: true

require "spec_helper"

# ForeignWebhooksController, recorded for the Next.js port (nextjs/src/server/controllers/foreign-webhooks.ts) and replayed by
# nextjs/parity/__tests__/foreign-webhooks.replay.test.ts. The clock is frozen at the instant SendGrid's own signature fixture
# (sendgrid-ruby spec/fixtures/event_webhook.rb) was made, so one fixed signature verifies, and every example sees the same Stripe,
# Resend and SNS timestamps. Record with the environment below, which the replay boots with too:
#   SENDGRID_GR_CREATORS_WEBHOOK_PUBLIC_KEY=<sendgrid_public_key> RESEND_WEBHOOK_SECRET=<resend_secret>
#   PAYPAL_WEBHOOK_ID=TEST_WEBHOOK_ID PAYPAL_PARTNER_CLIENT_SECRET=test-paypal-partner-client-secret
# A deployment with no SendGrid key or PayPal webhook id configured is covered by the Node unit tests, not by a recording.
describe "Foreign webhooks", type: :request do
  def frozen_at = Time.at(1_600_112_502).utc
  def sendgrid_public_key = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE83T4O/n84iotIvIW4mdBgQ/7dAfSmpqIM8kF9mN1flpVKS3GRqe62gw+2fNNRaINXvVpiglSI8eNEc6wEA3F+g=="
  def sendgrid_signature = "MEUCIGHQVtGj+Y3LkG9fLcxf3qfI10QysgDWmMOVmxG0u6ZUAiEAyBiXDWzM+uOe5W0JuG+luQAbPIqHh89M15TluLtEZtM="
  def sendgrid_failing_signature = "MEUCIQCtIHJeH93Y+qpYeWrySphQgpNGNr/U+UyUlBkU6n7RAwIgJTz2C+8a8xonZGi6BpSzoQsbVRamr2nlxFDWYNH3j/0="
  def sendgrid_timestamp = "1600112502"

  # JSON.generate, not to_json: ActiveSupport escapes the angle brackets of smtp-id, and the signature covers the plain bytes.
  def sendgrid_body = "#{JSON.generate([{ email: 'hello@world.com', event: 'dropped', reason: 'Bounced Address',
                                          sg_event_id: 'ZHJvcC0xMDk5NDkxOS1MUnpYbF9OSFN0T0doUTRrb2ZTbV9BLTA',
                                          sg_message_id: 'LRzXl_NHStOGhQ4kofSm_A.filterdrecv-p3mdw1-756b745b58-kmzbl-18-5F5FC76C-9.0',
                                          'smtp-id': '<LRzXl_NHStOGhQ4kofSm_A@ismtpd0039p1iad1.sendgrid.net>', timestamp: 1_600_112_492 }])}\r\n"

  def resend_secret = "whsec_dGVzdC1yZXNlbmQtc2VjcmV0"
  def resend_message_id = "msg_2abc"

  before do
    host! DOMAIN
    travel_to(frozen_at)
  end

  def json_post(path, body, headers = {})
    post path, params: body.is_a?(String) ? body : body.to_json, headers: { "CONTENT_TYPE" => "application/json" }.merge(headers)
  end

  describe "POST /stripe-webhook" do
    def signed(payload, secret: GlobalConfig.dig(:stripe, :endpoint_secret), at: frozen_at)
      signature = Stripe::Webhook::Signature.compute_signature(at, payload, secret)
      { "Stripe-Signature" => Stripe::Webhook::Signature.generate_header(at, signature) }
    end

    let(:event) do
      { id: "evt_1ParityCharge", object: "event", api_version: "2023-10-16", created: 1_600_112_000, type: "charge.succeeded",
        livemode: false, pending_webhooks: 1, request: { id: nil, idempotency_key: nil },
        data: { object: { id: "ch_1Parity", object: "charge", amount: 1500, paid: true, refunded: false,
                          metadata: { purchase_id: "abc==", note: "ü and \"quotes\"" }, refunds: { data: [], has_more: false } } } }
    end

    it "enqueues the event of a signed delivery", parity: true do
      payload = event.to_json
      json_post "/stripe-webhook", payload, signed(payload)

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body).to eq("success" => true)
      expect(HandleStripeEventWorker.jobs.size).to eq(1)
    end

    it "answers success false for a signed event with no id", parity: true do
      payload = event.except(:id).to_json
      json_post "/stripe-webhook", payload, signed(payload)

      expect(response.parsed_body).to eq("success" => false)
      expect(HandleStripeEventWorker.jobs.size).to eq(0)
    end

    it "answers 400 for a signature made with another secret", parity: true do
      payload = event.to_json
      json_post "/stripe-webhook", payload, signed(payload, secret: "another-secret")

      expect(response).to have_http_status(:bad_request)
      expect(response.parsed_body).to eq("success" => false)
      expect(HandleStripeEventWorker.jobs.size).to eq(0)
    end

    it "answers 400 when the signature header is missing", parity: true do
      json_post "/stripe-webhook", event.to_json

      expect(response).to have_http_status(:bad_request)
      expect(HandleStripeEventWorker.jobs.size).to eq(0)
    end

    it "answers 400 for a signature older than the tolerance", parity: true do
      payload = event.to_json
      json_post "/stripe-webhook", payload, signed(payload, at: frozen_at - 301.seconds)

      expect(response).to have_http_status(:bad_request)
      expect(HandleStripeEventWorker.jobs.size).to eq(0)
    end

    it "hands an event with a fractional number to Rails", parity: true do
      payload = event.merge(data: { object: { id: "ch_1Parity", amount: 1500, exchange_rate: 1.5 } }).to_json
      json_post "/stripe-webhook", payload, signed(payload)

      expect(response.parsed_body).to eq("success" => true)
      expect(HandleStripeEventWorker.jobs.size).to eq(1)
    end

    it "hands a signature timestamp written in hexadecimal to Rails", parity: true do
      payload = event.to_json
      signature = Stripe::Webhook::Signature.compute_signature(frozen_at, payload, GlobalConfig.dig(:stripe, :endpoint_secret))
      json_post "/stripe-webhook", payload, { "Stripe-Signature" => "t=0x#{frozen_at.to_i.to_s(16)},v1=#{signature}" }

      expect(response.parsed_body).to eq("success" => true)
    end

    it "answers 400 for a signed body that is not JSON", parity: true do
      payload = "not json"
      json_post "/stripe-webhook", payload, signed(payload).merge("CONTENT_TYPE" => "text/plain")

      expect(response).to have_http_status(:bad_request)
      expect(HandleStripeEventWorker.jobs.size).to eq(0)
    end
  end

  describe "POST /stripe-connect-webhook" do
    def signed(payload)
      secret = GlobalConfig.dig(:stripe_connect, :endpoint_secret)
      signature = Stripe::Webhook::Signature.compute_signature(frozen_at, payload, secret)
      { "Stripe-Signature" => Stripe::Webhook::Signature.generate_header(frozen_at, signature) }
    end

    let(:event) { { id: "evt_1ParityConnect", object: "event", type: "account.updated", data: { object: { id: "acct_1Parity", object: "account" } } } }

    it "enqueues an event that names a connected account", parity: true do
      payload = event.merge(account: "acct_1Parity").to_json
      json_post "/stripe-connect-webhook", payload, signed(payload)

      expect(response.parsed_body).to eq("success" => true)
      expect(HandleStripeEventWorker.jobs.size).to eq(1)
    end

    it "enqueues an event that carries a user_id", parity: true do
      payload = event.merge(user_id: "acct_1Parity").to_json
      json_post "/stripe-connect-webhook", payload, signed(payload)

      expect(response.parsed_body).to eq("success" => true)
      expect(HandleStripeEventWorker.jobs.size).to eq(1)
    end

    it "answers success false for an event with neither an account nor a user_id", parity: true do
      payload = event.to_json
      json_post "/stripe-connect-webhook", payload, signed(payload)

      expect(response.parsed_body).to eq("success" => false)
      expect(HandleStripeEventWorker.jobs.size).to eq(0)
    end

    it "answers 400 for the platform secret", parity: true do
      payload = event.merge(account: "acct_1Parity").to_json
      secret = GlobalConfig.dig(:stripe, :endpoint_secret)
      signature = Stripe::Webhook::Signature.compute_signature(frozen_at, payload, secret)
      json_post "/stripe-connect-webhook", payload, { "Stripe-Signature" => Stripe::Webhook::Signature.generate_header(frozen_at, signature) }

      expect(response).to have_http_status(:bad_request)
      expect(HandleStripeEventWorker.jobs.size).to eq(0)
    end
  end

  describe "POST /paypal-webhook" do
    let(:rest_endpoint) { "https://api.sandbox.paypal.com" }
    let(:paypal_headers) do
      { "Paypal-Transmission-Id" => "abc", "Paypal-Transmission-Sig" => "sig", "Paypal-Cert-Url" => "https://api.paypal.com/certs/123",
        "Paypal-Auth-Algo" => "SHA256", "Paypal-Transmission-Time" => "Mon, 14 Sep 2020 20:41:42 GMT" }
    end
    let(:capture_event) { { id: "WH-123", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: "CAP-1", amount: { value: "10.00", currency_code: "USD" } } } }

    def stub_token
      stub_request(:post, "#{rest_endpoint}/v1/oauth2/token")
        .to_return(status: 200, body: { token_type: "Bearer", access_token: "A21-parity", expires_in: 32_400 }.to_json, headers: { "Content-Type" => "application/json" })
    end

    def stub_verification(status: "SUCCESS", code: 200)
      stub_request(:post, "#{rest_endpoint}/v1/notifications/verify-webhook-signature")
        .to_return(status: code, body: { verification_status: status }.to_json, headers: { "Content-Type" => "application/json" })
    end

    it "fetches a partner token, verifies the signature and enqueues an order event now", parity: true do
      stub_token
      stub_verification
      json_post "/paypal-webhook", capture_event, paypal_headers

      expect(response.parsed_body).to eq("success" => true)
      expect(HandlePaypalEventWorker.jobs.size).to eq(1)
    end

    it "reuses the cached partner token", parity: true do
      PaypalPartnerRestCredentials::REDIS_KEY_STORAGE_NS.set(PaypalPartnerRestCredentials::TOKEN_KEY, "Bearer cached-token")
      stub_verification
      json_post "/paypal-webhook", capture_event, paypal_headers

      expect(response.parsed_body).to eq("success" => true)
      expect(HandlePaypalEventWorker.jobs.size).to eq(1)
    end

    it "enqueues a merchant account event now", parity: true do
      PaypalPartnerRestCredentials::REDIS_KEY_STORAGE_NS.set(PaypalPartnerRestCredentials::TOKEN_KEY, "Bearer cached-token")
      stub_verification
      json_post "/paypal-webhook", { id: "WH-456", event_type: "MERCHANT.ONBOARDING.COMPLETED", resource: { merchant_id: "MID1" } }, paypal_headers

      expect(response.parsed_body).to eq("success" => true)
      expect(HandlePaypalEventWorker.jobs.map { _1["at"] }).to all(be_nil)
    end

    it "delays an event of any other type by ten minutes", parity: true do
      PaypalPartnerRestCredentials::REDIS_KEY_STORAGE_NS.set(PaypalPartnerRestCredentials::TOKEN_KEY, "Bearer cached-token")
      stub_verification
      json_post "/paypal-webhook", { id: "WH-789", event_type: "BILLING.SUBSCRIPTION.CREATED" }, paypal_headers

      expect(response.parsed_body).to eq("success" => true)
      expect(HandlePaypalEventWorker.jobs.size).to eq(1)
      expect(HandlePaypalEventWorker.jobs.first["at"]).to be_present
    end

    it "answers 400 when PayPal rejects the signature", parity: true do
      PaypalPartnerRestCredentials::REDIS_KEY_STORAGE_NS.set(PaypalPartnerRestCredentials::TOKEN_KEY, "Bearer cached-token")
      stub_verification(status: "FAILURE")
      json_post "/paypal-webhook", capture_event, paypal_headers

      expect(response).to have_http_status(:bad_request)
      expect(HandlePaypalEventWorker.jobs.size).to eq(0)
    end

    it "answers 400 when the verification call is refused", parity: true do
      PaypalPartnerRestCredentials::REDIS_KEY_STORAGE_NS.set(PaypalPartnerRestCredentials::TOKEN_KEY, "Bearer cached-token")
      stub_verification(status: "SUCCESS", code: 401)
      json_post "/paypal-webhook", capture_event, paypal_headers

      expect(response).to have_http_status(:bad_request)
      expect(HandlePaypalEventWorker.jobs.size).to eq(0)
    end

    it "answers 400 without calling PayPal when a signature header is missing", parity: true do
      json_post "/paypal-webhook", capture_event, paypal_headers.except("Paypal-Transmission-Id")

      expect(response).to have_http_status(:bad_request)
      expect(HandlePaypalEventWorker.jobs.size).to eq(0)
    end

    it "hands a webhook whose JSON body is a list to Rails", parity: true do
      json_post "/paypal-webhook", [{ event_type: "PAYMENT.CAPTURE.COMPLETED" }], paypal_headers

      expect(response.parsed_body).to eq("success" => true)
      expect(HandlePaypalEventWorker.jobs.size).to eq(1)
    end

    it "skips verification for a legacy IPN and delays it by ten minutes", parity: true do
      post "/paypal-webhook", params: { txn_type: "masspay", txn_id: "123", payer_email: "payer@example.com" }

      expect(response.parsed_body).to eq("success" => true)
      expect(HandlePaypalEventWorker.jobs.size).to eq(1)
      expect(HandlePaypalEventWorker.jobs.first["at"]).to be_present
    end
  end

  describe "POST /sendgrid-webhook" do
    let(:headers) { { "X-Twilio-Email-Event-Webhook-Signature" => sendgrid_signature, "X-Twilio-Email-Event-Webhook-Timestamp" => sendgrid_timestamp } }

    before { Feature.activate(:verify_sendgrid_webhook_signatures) }

    it "enqueues the events of a signed delivery", parity: true do
      json_post "/sendgrid-webhook", sendgrid_body, headers

      expect(response.parsed_body).to eq("success" => true)
      expect(HandleSendgridEventJob.jobs.size).to eq(1)
    end

    it "answers 500 for a signature that does not verify", parity: true do
      json_post "/sendgrid-webhook", sendgrid_body, headers.merge("X-Twilio-Email-Event-Webhook-Signature" => sendgrid_failing_signature)

      expect(response).to have_http_status(:internal_server_error)
      expect(response.parsed_body).to eq("success" => false)
      expect(HandleSendgridEventJob.jobs.size).to eq(0)
    end

    it "answers 500 when the signature header is missing", parity: true do
      json_post "/sendgrid-webhook", sendgrid_body, headers.except("X-Twilio-Email-Event-Webhook-Signature")

      expect(response).to have_http_status(:internal_server_error)
      expect(HandleSendgridEventJob.jobs.size).to eq(0)
    end

    it "answers 500 when the timestamp header is missing", parity: true do
      json_post "/sendgrid-webhook", sendgrid_body, headers.except("X-Twilio-Email-Event-Webhook-Timestamp")

      expect(response).to have_http_status(:internal_server_error)
      expect(HandleSendgridEventJob.jobs.size).to eq(0)
    end

    it "answers 500 for a timestamp more than five minutes old", parity: true do
      json_post "/sendgrid-webhook", sendgrid_body, headers.merge("X-Twilio-Email-Event-Webhook-Timestamp" => (frozen_at.to_i - 301).to_s)

      expect(response).to have_http_status(:internal_server_error)
      expect(HandleSendgridEventJob.jobs.size).to eq(0)
    end

    it "answers 500 for a body that was changed after signing", parity: true do
      json_post "/sendgrid-webhook", sendgrid_body.sub("dropped", "delivered"), headers

      expect(response).to have_http_status(:internal_server_error)
      expect(HandleSendgridEventJob.jobs.size).to eq(0)
    end

    it "enqueues a failed verification when the enforcement flag is off", parity: true do
      Feature.deactivate(:verify_sendgrid_webhook_signatures)
      json_post "/sendgrid-webhook", sendgrid_body, headers.merge("X-Twilio-Email-Event-Webhook-Signature" => sendgrid_failing_signature)

      expect(response.parsed_body).to eq("success" => true)
      expect(HandleSendgridEventJob.jobs.size).to eq(1)
    end
  end

  describe "POST /resend-webhook" do
    let(:secret_bytes) { Base64.decode64(resend_secret.split("_", 2).last) }

    def gum_header(name, value)
      { "name" => MailerInfo.header_name(name), "value" => MailerInfo.encrypt(value) }
    end

    def event(type: "email.delivered", headers: [gum_header(:mailer_class, "CustomerMailer"), gum_header(:mailer_method, "receipt")], data: {})
      { "created_at" => "2025-01-02T00:14:12.391Z", "type" => type,
        "data" => { "created_at" => "2025-01-02 00:14:11.140106+00", "to" => ["buyer@example.com"], "headers" => headers }.merge(data) }
    end

    def signed(json, at: frozen_at.to_i, message_id: resend_message_id, signature: nil)
      signature ||= Base64.strict_encode64(OpenSSL::HMAC.digest("SHA256", secret_bytes, "#{message_id}.#{at}.#{json}"))
      { "svix-id" => message_id, "svix-timestamp" => at.to_s, "svix-signature" => "v1,#{signature}" }
    end

    def deliver(payload, **options)
      json = payload.to_json
      json_post "/resend-webhook", json, signed(json, **options)
    end

    it "enqueues a tracked event", parity: true do
      deliver(event)

      expect(response.parsed_body).to eq("success" => true)
      expect(HandleResendEventJob.jobs.size).to eq(1)
    end

    it "enqueues a click event with its link and workflow ids", parity: true do
      deliver(event(type: "email.clicked", headers: [gum_header(:mailer_class, "CustomerMailer"), gum_header(:mailer_method, "receipt"),
                                                     gum_header(:workflow_ids, [1, 2].to_json), gum_header(:purchase_id, "7")],
                    data: { "click" => { "link" => "https://example.com/x" } }))

      expect(HandleResendEventJob.jobs.size).to eq(1)
    end

    it "hands an event with a fractional number to Rails", parity: true do
      deliver(event(data: { "click" => { "link" => "https://example.com/x", "weight" => 1.5 } }))

      expect(response.parsed_body).to eq("success" => true)
      expect(HandleResendEventJob.jobs.size).to eq(1)
    end

    it "discards an event type nobody tracks", parity: true do
      deliver(event(type: "email.sent"))

      expect(response.parsed_body).to eq("success" => true)
      expect(HandleResendEventJob.jobs.size).to eq(0)
    end

    it "discards mail sent without the mailer headers", parity: true do
      deliver(event(headers: []))

      expect(response.parsed_body).to eq("success" => true)
      expect(HandleResendEventJob.jobs.size).to eq(0)
    end

    it "enqueues a payload it cannot parse and leaves the decision to the job", parity: true do
      deliver({ "type" => "email.delivered" })

      expect(response.parsed_body).to eq("success" => true)
      expect(HandleResendEventJob.jobs.size).to eq(1)
    end

    it "enqueues an event whose header does not decrypt", parity: true do
      deliver(event(headers: [{ "name" => MailerInfo.header_name(:mailer_class), "value" => "v1:AAAA:BBBB" }]))

      expect(HandleResendEventJob.jobs.size).to eq(1)
    end

    it "answers 400 for a wrong signature", parity: true do
      json = event.to_json
      json_post "/resend-webhook", json, signed(json, signature: Base64.strict_encode64("x" * 32))

      expect(response).to have_http_status(:bad_request)
      expect(HandleResendEventJob.jobs.size).to eq(0)
    end

    it "answers 400 for a signature header without the version prefix", parity: true do
      json = event.to_json
      json_post "/resend-webhook", json, signed(json).merge("svix-signature" => "nocomma")

      expect(response).to have_http_status(:bad_request)
    end

    it "answers 400 for a timestamp more than five minutes old", parity: true do
      deliver(event, at: frozen_at.to_i - 301)

      expect(response).to have_http_status(:bad_request)
      expect(HandleResendEventJob.jobs.size).to eq(0)
    end

    it "answers 400 when the message id is missing", parity: true do
      json = event.to_json
      json_post "/resend-webhook", json, signed(json).except("svix-id")

      expect(response).to have_http_status(:bad_request)
    end

    it "answers 400 when the timestamp is missing", parity: true do
      json = event.to_json
      json_post "/resend-webhook", json, signed(json).except("svix-timestamp")

      expect(response).to have_http_status(:bad_request)
    end

    it "answers 400 when the signature is missing", parity: true do
      json_post "/resend-webhook", event.to_json, {}

      expect(response).to have_http_status(:bad_request)
    end
  end

  describe "SNS webhooks" do
    let(:cert_url) { "https://sns.us-east-1.amazonaws.com/SimpleNotificationService-parity.pem" }
    let(:key) { OpenSSL::PKey::RSA.new(2048) }
    let(:certificate) do
      OpenSSL::X509::Certificate.new.tap do |cert|
        cert.version = 2
        cert.serial = 1
        cert.subject = cert.issuer = OpenSSL::X509::Name.parse("/CN=sns.us-east-1.amazonaws.com")
        cert.public_key = key.public_key
        cert.not_before = frozen_at - 1.day
        cert.not_after = frozen_at + 1.year
        cert.sign(key, OpenSSL::Digest.new("SHA256"))
      end
    end
    let(:message) do
      { "Type" => "Notification", "MessageId" => "5a7d-parity", "TopicArn" => "arn:aws:sns:us-east-1:111122223333:parity",
        "Subject" => "Parity", "Message" => { detail: { status: "COMPLETE", jobId: "1" } }.to_json, "Timestamp" => (frozen_at - 2.days).iso8601(3),
        "SignatureVersion" => "1", "SigningCertURL" => cert_url }
    end

    def sign(notification, digest: OpenSSL::Digest::SHA1.new)
      signable = %w[Message MessageId Subject SubscribeURL Timestamp Token TopicArn Type]
      canonical = signable.filter_map { |name| "#{name}\n#{notification[name]}\n" if notification[name].present? }.join
      notification.merge("Signature" => Base64.strict_encode64(key.sign(digest, canonical)))
    end

    def serve_certificate(url = cert_url)
      stub_request(:get, url).to_return(status: 200, body: certificate.to_pem)
    end

    describe "POST /sns-mediaconvert-webhook" do
      it "enqueues a notification signed with SignatureVersion 1", parity: true do
        serve_certificate
        post "/sns-mediaconvert-webhook", params: sign(message).to_json, headers: { "CONTENT_TYPE" => "text/plain; charset=UTF-8" }

        expect(response).to have_http_status(:ok)
        expect(HandleSnsMediaconvertEventWorker.jobs.size).to eq(1)
      end

      it "enqueues a notification signed with SignatureVersion 2", parity: true do
        serve_certificate
        post "/sns-mediaconvert-webhook", params: sign(message.merge("SignatureVersion" => "2"), digest: OpenSSL::Digest::SHA256.new).to_json, headers: { "CONTENT_TYPE" => "text/plain" }

        expect(response).to have_http_status(:ok)
        expect(HandleSnsMediaconvertEventWorker.jobs.size).to eq(1)
      end

      it "answers 400 when the signature does not match the message", parity: true do
        serve_certificate
        post "/sns-mediaconvert-webhook", params: sign(message).merge("Message" => "changed").to_json, headers: { "CONTENT_TYPE" => "text/plain" }

        expect(response).to have_http_status(:bad_request)
        expect(response.parsed_body).to eq("success" => false)
        expect(HandleSnsMediaconvertEventWorker.jobs.size).to eq(0)
      end

      it "answers 400 for a SignatureVersion it does not know", parity: true do
        post "/sns-mediaconvert-webhook", params: sign(message).merge("SignatureVersion" => "3").to_json, headers: { "CONTENT_TYPE" => "text/plain" }

        expect(response).to have_http_status(:bad_request)
        expect(HandleSnsMediaconvertEventWorker.jobs.size).to eq(0)
      end

      it "answers 400 for a certificate not hosted by AWS", parity: true do
        post "/sns-mediaconvert-webhook", params: sign(message.merge("SigningCertURL" => "https://sns.example.com/cert.pem")).to_json, headers: { "CONTENT_TYPE" => "text/plain" }

        expect(response).to have_http_status(:bad_request)
        expect(HandleSnsMediaconvertEventWorker.jobs.size).to eq(0)
      end

      it "answers 400 for a certificate served over http", parity: true do
        post "/sns-mediaconvert-webhook", params: sign(message.merge("SigningCertURL" => "http://sns.us-east-1.amazonaws.com/cert.pem")).to_json, headers: { "CONTENT_TYPE" => "text/plain" }

        expect(response).to have_http_status(:bad_request)
      end

      it "answers 400 for a certificate that is not a .pem file", parity: true do
        post "/sns-mediaconvert-webhook", params: sign(message.merge("SigningCertURL" => "https://sns.us-east-1.amazonaws.com/cert.txt")).to_json, headers: { "CONTENT_TYPE" => "text/plain" }

        expect(response).to have_http_status(:bad_request)
      end

      it "answers 400 when the certificate cannot be fetched", parity: true do
        stub_request(:get, cert_url).to_return(status: 404, body: "gone")
        post "/sns-mediaconvert-webhook", params: sign(message).to_json, headers: { "CONTENT_TYPE" => "text/plain" }

        expect(response).to have_http_status(:bad_request)
        expect(HandleSnsMediaconvertEventWorker.jobs.size).to eq(0)
      end

      it "answers 400 when the certificate is not in PEM format", parity: true do
        stub_request(:get, cert_url).to_return(status: 200, body: "<html>not a certificate</html>")
        post "/sns-mediaconvert-webhook", params: sign(message).to_json, headers: { "CONTENT_TYPE" => "text/plain" }

        expect(response).to have_http_status(:bad_request)
      end

      it "answers 400 for a body that is not a JSON object", parity: true do
        post "/sns-mediaconvert-webhook", params: "[1, 2]", headers: { "CONTENT_TYPE" => "text/plain" }

        expect(response).to have_http_status(:bad_request)
        expect(HandleSnsMediaconvertEventWorker.jobs.size).to eq(0)
      end
    end

    describe "POST /sns-aws-config-webhook" do
      it "enqueues a notification signed with SignatureVersion 1", parity: true do
        serve_certificate
        post "/sns-aws-config-webhook", params: sign(message).to_json, headers: { "CONTENT_TYPE" => "text/plain; charset=UTF-8" }

        expect(response).to have_http_status(:ok)
        expect(HandleSnsAwsConfigEventWorker.jobs.size).to eq(1)
      end

      it "enqueues a notification signed with SignatureVersion 2", parity: true do
        serve_certificate
        post "/sns-aws-config-webhook", params: sign(message.merge("SignatureVersion" => "2"), digest: OpenSSL::Digest::SHA256.new).to_json, headers: { "CONTENT_TYPE" => "text/plain" }

        expect(response).to have_http_status(:ok)
        expect(HandleSnsAwsConfigEventWorker.jobs.size).to eq(1)
      end

      it "answers 400 when the signature does not match the message", parity: true do
        serve_certificate
        post "/sns-aws-config-webhook", params: sign(message).merge("Message" => "changed").to_json, headers: { "CONTENT_TYPE" => "text/plain" }

        expect(response).to have_http_status(:bad_request)
        expect(response.parsed_body).to eq("success" => false)
        expect(HandleSnsAwsConfigEventWorker.jobs.size).to eq(0)
      end

      it "answers 400 for a SignatureVersion it does not know", parity: true do
        post "/sns-aws-config-webhook", params: sign(message).merge("SignatureVersion" => "3").to_json, headers: { "CONTENT_TYPE" => "text/plain" }

        expect(response).to have_http_status(:bad_request)
        expect(HandleSnsAwsConfigEventWorker.jobs.size).to eq(0)
      end

      it "answers 400 for a certificate not hosted by AWS", parity: true do
        post "/sns-aws-config-webhook", params: sign(message.merge("SigningCertURL" => "https://sns.example.com/cert.pem")).to_json, headers: { "CONTENT_TYPE" => "text/plain" }

        expect(response).to have_http_status(:bad_request)
        expect(HandleSnsAwsConfigEventWorker.jobs.size).to eq(0)
      end

      it "answers 400 for a certificate served over http", parity: true do
        post "/sns-aws-config-webhook", params: sign(message.merge("SigningCertURL" => "http://sns.us-east-1.amazonaws.com/cert.pem")).to_json, headers: { "CONTENT_TYPE" => "text/plain" }

        expect(response).to have_http_status(:bad_request)
      end

      it "answers 400 for a certificate that is not a .pem file", parity: true do
        post "/sns-aws-config-webhook", params: sign(message.merge("SigningCertURL" => "https://sns.us-east-1.amazonaws.com/cert.txt")).to_json, headers: { "CONTENT_TYPE" => "text/plain" }

        expect(response).to have_http_status(:bad_request)
      end

      it "answers 400 when the certificate cannot be fetched", parity: true do
        stub_request(:get, cert_url).to_return(status: 404, body: "gone")
        post "/sns-aws-config-webhook", params: sign(message).to_json, headers: { "CONTENT_TYPE" => "text/plain" }

        expect(response).to have_http_status(:bad_request)
        expect(HandleSnsAwsConfigEventWorker.jobs.size).to eq(0)
      end

      it "answers 400 when the certificate is not in PEM format", parity: true do
        stub_request(:get, cert_url).to_return(status: 200, body: "<html>not a certificate</html>")
        post "/sns-aws-config-webhook", params: sign(message).to_json, headers: { "CONTENT_TYPE" => "text/plain" }

        expect(response).to have_http_status(:bad_request)
      end

      it "answers 400 for a body that is not a JSON object", parity: true do
        post "/sns-aws-config-webhook", params: "[1, 2]", headers: { "CONTENT_TYPE" => "text/plain" }

        expect(response).to have_http_status(:bad_request)
        expect(HandleSnsAwsConfigEventWorker.jobs.size).to eq(0)
      end
    end
  end

  describe "POST /grmc-webhook" do
    it "has no action behind its route and answers 404", parity: true do
      json_post "/grmc-webhook", { any: "thing" }

      expect(response).to have_http_status(:not_found)
    end
  end
end
