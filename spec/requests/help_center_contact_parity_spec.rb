# frozen_string_literal: true

require "spec_helper"

# POST /help/contact, recorded for the Next.js port (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/rest-sweep-2.replay.test.ts,
# which sends the last request of each example. A valid submission only enqueues SupportContactMailer.contact_form (the request spec's
# test adapter records no mail job, so the replay asserts it by example name). Examples named `hands a ...` are the requests the
# port leaves to Rails whole: a screenshot upload and a request without a CSRF token (Rails runs those with a null session).
describe "Help Center contact form", type: :request do
  include Parity::AudienceSignedIn

  let(:valid_params) do
    {
      email: "buyer@example.com",
      category: "payouts",
      message: "My payout hasn't arrived and it's been over a week now.",
      referrer_path: "/help/article/13-getting-paid"
    }
  end

  before { host! DOMAIN }

  def contact(token: csrf_token, **params)
    post help_center_contact_path, params: valid_params.merge(authenticity_token: token).merge(params)
  end

  it "enqueues the support email of a visitor", parity: true do
    contact

    expect(response).to have_http_status(:ok)
    expect(response.parsed_body).to eq("success" => true)
  end

  it "enqueues the support email with the signed-in user's id", parity: true do
    user = create(:user)
    log_in(user)

    contact

    expect(response).to have_http_status(:ok)
  end

  it "forwards only a same-app referrer path", parity: true do
    contact(referrer_path: "//evil.example.com/steal")

    expect(response).to have_http_status(:ok)
  end

  it "trims the email and the message", parity: true do
    contact(email: "  buyer@example.com  ", message: "   My payout hasn't arrived yet.   ")

    expect(response).to have_http_status(:ok)
  end

  it "drops a submission that fills the honeypot, with a fake success", parity: true do
    contact(website: "https://spam.example.com")

    expect(response).to have_http_status(:ok)
    expect(response.parsed_body).to eq("success" => true)
  end

  it "rejects an invalid email", parity: true do
    contact(email: "not-an-email")

    expect(response).to have_http_status(:unprocessable_entity)
    expect(response.parsed_body["error"]).to eq("Please enter a valid email address.")
  end

  it "rejects an unknown category", parity: true do
    contact(category: "spam")

    expect(response).to have_http_status(:unprocessable_entity)
    expect(response.parsed_body["error"]).to eq("Please select a category.")
  end

  it "rejects a message that is too short", parity: true do
    contact(message: "help")

    expect(response).to have_http_status(:unprocessable_entity)
    expect(response.parsed_body["error"]).to include("at least 10 characters")
  end

  it "rejects a message that is too long", parity: true do
    contact(message: "a" * 10_001)

    expect(response).to have_http_status(:unprocessable_entity)
    expect(response.parsed_body["error"]).to include("too long")
  end

  it "counts the characters of the message, not its bytes", parity: true do
    contact(message: "é" * 10)

    expect(response).to have_http_status(:ok)
  end

  it "hands a screenshot upload to Rails", parity: true do
    png = "\x89PNG\r\n\x1A\n".b + ("x" * 32)
    upload = Rack::Test::UploadedFile.new(StringIO.new(png), "image/png", original_filename: "screenshot.png")

    contact(attachments: [upload])

    expect(response).to have_http_status(:ok)
  end

  it "hands a request without a CSRF token to Rails", parity: true do
    post help_center_contact_path, params: valid_params

    expect(response).to have_http_status(:ok)
  end
end
