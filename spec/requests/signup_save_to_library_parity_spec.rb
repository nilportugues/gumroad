# frozen_string_literal: true

require "spec_helper"

# POST /save_to_library (SignupController#save_to_library), recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/auth-mutations.replay.test.ts, which sends the last request of each example. An example named "hands ..." is one Node
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

  it "creates the account without signing it in", parity: true do
    post "/save_to_library", params: { authenticity_token: csrf_token, user: { email: "library-buyer@example.com", password: "a-long-library-password", terms_accepted: "1", buyer_signup: "true" } }

    expect(response.parsed_body).to eq("success" => true)
    user = User.find_by!(email: "library-buyer@example.com")
    expect(user.buyer_signup).to eq(true)
    expect(user.tos_agreements.count).to eq(1)
  end

  it "answers the first validation error for a password confirmation that does not match", parity: true do
    post "/save_to_library", params: { authenticity_token: csrf_token, user: { email: "short-library@example.com", password: "a-long-library-password", password_confirmation: "another-long-password" } }

    expect(response.parsed_body["success"]).to eq(false)
    expect(response.parsed_body["error_message"]).to be_present
    expect(User.where(email: "short-library@example.com").count).to eq(0)
  end

  it "answers the first validation error for an email that is taken", parity: true do
    create(:user, email: "taken-library@example.com")

    post "/save_to_library", params: { authenticity_token: csrf_token, user: { email: "taken-library@example.com", password: "a-long-library-password" } }

    expect(response.parsed_body["success"]).to eq(false)
    expect(response.parsed_body["error_message"]).to be_present
  end

  it "answers the first validation error for a missing email", parity: true do
    post "/save_to_library", params: { authenticity_token: csrf_token, user: { password: "a-long-library-password" } }

    expect(response.parsed_body["success"]).to eq(false)
  end

  it "creates the account for a purchase id that names no purchase", parity: true do
    post "/save_to_library", params: { authenticity_token: csrf_token, user: { email: "purchase-library@example.com", password: "a-long-library-password", purchase_id: "unknown" } }

    expect(response.parsed_body).to eq("success" => true)
    expect(User.find_by!(email: "purchase-library@example.com").purchases).to be_empty
  end

  it "creates the account for a purchase id that decrypts to no row", parity: true do
    post "/save_to_library", params: { authenticity_token: csrf_token, user: { email: "gone-library@example.com", password: "a-long-library-password", purchase_id: ObfuscateIds.encrypt(987_654) } }

    expect(response.parsed_body).to eq("success" => true)
  end

  it "hands a user hash that names an existing purchase to Rails", parity: true do
    build(:purchase, email: "purchase-library@example.com", purchaser: nil, purchase_state: "successful").save!(validate: false)
    purchase = Purchase.last

    post "/save_to_library", params: { authenticity_token: csrf_token, user: { email: "purchase-library@example.com", password: "a-long-library-password", purchase_id: purchase.external_id } }

    expect(response.parsed_body).to eq("success" => true)
    expect(purchase.reload.purchaser).to eq(User.find_by!(email: "purchase-library@example.com"))
  end

  it "creates the account with the remember-me checkbox ticked", parity: true do
    post "/save_to_library", params: { authenticity_token: csrf_token, user: { email: "remember-library@example.com", password: "a-long-library-password", remember_me: "1" } }

    expect(response.parsed_body).to eq("success" => true)
    expect(User.find_by!(email: "remember-library@example.com").remember_created_at).to be_nil
  end

  it "creates the account with the remember-me checkbox unticked", parity: true do
    post "/save_to_library", params: { authenticity_token: csrf_token, user: { email: "forget-library@example.com", password: "a-long-library-password", remember_me: "0" } }

    expect(response.parsed_body).to eq("success" => true)
  end

  it "answers the email error for a user hash holding only the remember-me checkbox", parity: true do
    post "/save_to_library", params: { authenticity_token: csrf_token, user: { remember_me: "1" } }

    expect(response.parsed_body["success"]).to eq(false)
  end

  it "answers 400 for an empty user hash", parity: true do
    post "/save_to_library", params: { authenticity_token: csrf_token, user: {} }.to_json, headers: { "CONTENT_TYPE" => "application/json" }

    expect(response).to have_http_status(:bad_request)
  end

  it "hands a post without an authenticity token to Rails", parity: true do
    post "/save_to_library"

    expect(response).to have_http_status(:ok)
  end
end
