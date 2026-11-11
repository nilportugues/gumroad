# frozen_string_literal: true

require "spec_helper"

# POST /save_to_library (SignupController#save_to_library), recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/ws10-triage.replay.test.ts, which sends the last request of each example. An example named "hands ..." is one Node
# leaves to Rails: the replay asserts it reached Rails and wrote nothing.
describe "Save to library", type: :request do
  include Parity::AudienceSignedIn

  before { host! DOMAIN }

  it "asks for an email address when no user is posted", parity: true do
    post "/save_to_library", params: { authenticity_token: csrf_token }

    expect(response.parsed_body).to eq("success" => false, "error_message" => "Please provide a valid email address.")
  end

  it "reads a user that is a plain string as no user", parity: true do
    post "/save_to_library", params: { authenticity_token: csrf_token, user: "buyer" }

    expect(response.parsed_body).to eq("success" => false, "error_message" => "Please provide a valid email address.")
  end

  it "reads a user that is a list as no user", parity: true do
    post "/save_to_library", params: { authenticity_token: csrf_token, user: %w[a b] }

    expect(response.parsed_body["success"]).to eq(false)
  end

  it "answers the same for a request that accepts JSON", parity: true do
    post "/save_to_library", params: { authenticity_token: csrf_token }, headers: { "Accept" => "application/json" }

    expect(response.parsed_body["error_message"]).to eq("Please provide a valid email address.")
  end

  it "hands a user hash that creates an account to Rails", parity: true do
    post "/save_to_library", params: { authenticity_token: csrf_token, user: { email: "library-buyer@example.com", password: "a-long-library-password" } }

    expect(response.parsed_body).to eq("success" => true)
    expect(User.where(email: "library-buyer@example.com").count).to eq(1)
  end

  it "hands a post without an authenticity token to Rails", parity: true do
    post "/save_to_library"

    expect(response).to have_http_status(:ok)
  end
end
