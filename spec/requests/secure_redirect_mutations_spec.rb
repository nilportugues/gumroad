# frozen_string_literal: true

require "spec_helper"

# Submitting the confirmation form of /secure_url_redirect, recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/content-delivery-mutations.replay.test.ts, which sends the last request of each example.
describe "Secure redirect confirmation", type: :request do
  include Parity::AudienceSignedIn

  let(:destination) { "https://example.com/unsubscribe/sample-id?email_type=notify" }
  let(:confirmation_text) { "buyer@example.com" }
  # Far enough ahead that the recorded request never expires when it is replayed.
  let(:created_at) { 10.years.from_now.to_i }
  let(:payload) { { destination:, confirmation_texts: [confirmation_text, "Other@example.com"], created_at: } }
  let(:encrypted_payload) { SecureEncryptService.encrypt(payload.to_json) }
  let(:form) { { message: "Confirm your email", field_name: "Email", error_message: "Email does not match" } }

  before { host! DOMAIN }

  def submit(text: confirmation_text, payload: encrypted_payload, **extra)
    post secure_url_redirect_path, params: { authenticity_token: csrf_token, encrypted_payload: payload, confirmation_text: text, **form, **extra }
  end

  it "sends the visitor to the destination when the text matches", parity: true do
    submit

    expect(response).to have_http_status(:see_other)
    expect(response.location).to eq(destination)
  end

  it "accepts any of the allowed texts", parity: true do
    submit(text: "Other@example.com")

    expect(response.location).to eq(destination)
  end

  it "adds the text to the destination when the payload asks for it", parity: true do
    submit(payload: SecureEncryptService.encrypt(payload.merge(send_confirmation_text: true, destination: "https://example.com/go?b=2&a=1#top").to_json))

    expect(response).to have_http_status(:see_other)
  end

  it "sends the text to a destination without a query", parity: true do
    submit(payload: SecureEncryptService.encrypt(payload.merge(send_confirmation_text: true, destination: "https://example.com/go").to_json))

    expect(response.location).to start_with("https://example.com/go?confirmation_text=")
  end

  it "goes back to the form when the text does not match", parity: true do
    submit(text: "wrong@example.com")

    expect(response).to have_http_status(:found)
    expect(flash[:alert]).to eq("Email does not match")
  end

  it "asks for the text when it is blank", parity: true do
    submit(text: "")

    expect(flash[:alert]).to eq("Please enter the confirmation text")
  end

  it "refuses a payload that does not decrypt", parity: true do
    submit(payload: "garbage")

    expect(flash[:alert]).to eq("Invalid request")
  end

  it "refuses a payload that is not JSON", parity: true do
    submit(payload: SecureEncryptService.encrypt("not json"))

    expect(flash[:alert]).to eq("Invalid request")
  end

  it "refuses an expired payload", parity: true do
    submit(payload: SecureEncryptService.encrypt(payload.merge(created_at: 1_600_000_000).to_json))

    expect(flash[:alert]).to eq("This link has expired")
  end

  it "refuses a payload without a destination", parity: true do
    submit(payload: SecureEncryptService.encrypt(payload.merge(destination: nil).to_json))

    expect(flash[:alert]).to eq("Invalid destination")
  end

  it "falls back to the default texts of the form", parity: true do
    submit(text: "wrong@example.com", message: "", field_name: "", error_message: "")

    expect(flash[:alert]).to eq("Confirmation text does not match")
  end

  it "sends a request without a payload to the home page", parity: true do
    post secure_url_redirect_path, params: { authenticity_token: csrf_token, confirmation_text: }

    expect(response).to have_http_status(:found)
  end
end
