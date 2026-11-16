# frozen_string_literal: true

require "spec_helper"

# POST /test_pings (TestPingsController#create), recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/test-pings.replay.test.ts, which sends the last request of each example. Node answers the guards and the invalid
# URL; an example named "hands a ..." is one Node leaves to Rails whole because Rails would call the seller's endpoint.
describe "Test pings", type: :request do
  include Parity::AudienceSignedIn

  let(:seller) { create(:named_seller, name: "Pinging Seller") }
  let(:json_headers) { { "Accept" => "application/json", "Content-Type" => "application/json" } }

  before { host! DOMAIN }

  def ping(body, token: csrf_token)
    headers = token ? json_headers.merge("X-CSRF-Token" => token) : json_headers
    post "/test_pings", params: body.to_json, headers:
  end

  def as_team_member(role)
    member = create(:user, name: "#{role.capitalize} Member")
    membership = create(:team_membership, user: member, seller:, role:)
    log_in(member)
    switch_to(membership)
  end

  it "answers that a request without a URL is invalid", parity: true do
    log_in(seller)

    ping({})

    expect(response).to have_http_status(:ok)
    expect(response.parsed_body).to eq("success" => false, "error_message" => "That URL seems to be invalid.")
  end

  it "answers that an empty URL is invalid", parity: true do
    log_in(seller)

    ping({ url: "" })

    expect(response.parsed_body["error_message"]).to eq("That URL seems to be invalid.")
  end

  it "answers that a URL without a scheme is invalid", parity: true do
    log_in(seller)

    ping({ url: "example.com/ping" })

    expect(response.parsed_body).to eq("success" => false, "error_message" => "That URL seems to be invalid.")
  end

  it "answers that a null URL is invalid", parity: true do
    log_in(seller)

    ping({ url: nil })

    expect(response.parsed_body["error_message"]).to eq("That URL seems to be invalid.")
  end

  it "lets an admin team member through to the URL check", parity: true do
    as_team_member(TeamMembership::ROLE_ADMIN)

    ping({ url: "no scheme" })

    expect(response.parsed_body["error_message"]).to eq("That URL seems to be invalid.")
  end

  it "answers the generic failure to a support team member", parity: true do
    as_team_member(TeamMembership::ROLE_SUPPORT)

    ping({ url: "https://example.com/ping" })

    expect(response).to have_http_status(:ok)
    expect(response.parsed_body).to eq("success" => false, "error_message" => "Sorry, something went wrong. Please try again.")
  end

  it "answers the generic failure to an accountant team member before reading the URL", parity: true do
    as_team_member(TeamMembership::ROLE_ACCOUNTANT)

    ping({})

    expect(response.parsed_body["error_message"]).to eq("Sorry, something went wrong. Please try again.")
  end

  it "hands a URL with a scheme to Rails", parity: true do
    log_in(seller)

    ping({ url: "https://example.com/ping" })

    expect(response.parsed_body).to include("success" => true)
  end

  it "hands a URL that has a colon but no scheme to Rails", parity: true do
    log_in(seller)

    ping({ url: "not a url: really" })

    expect(response.parsed_body["error_message"]).to eq("That URL seems to be invalid.")
  end

  it "answers the generic failure to a URL that is a list", parity: true do
    log_in(seller)

    ping({ url: ["https://example.com/ping"] })

    expect(response.parsed_body["error_message"]).to eq("Sorry, something went wrong. Please try again.")
  end

  it "hands a request without a CSRF token to Rails", parity: true do
    log_in(seller)

    ping({ url: "no scheme" }, token: nil)

    expect(response).to have_http_status(:not_found)
  end

  it "hands a signed-out request to Rails", parity: true do
    ping({ url: "no scheme" })

    expect(response).to have_http_status(:not_found)
  end
end
