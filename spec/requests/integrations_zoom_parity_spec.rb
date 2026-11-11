# frozen_string_literal: true

require "spec_helper"

# Integrations::ZoomController#account_info as the integration form calls it, recorded for the Next.js port (PARITY_RECORD=1) with the
# Zoom API stubbed by WebMock: the recorder keeps the calls Rails made, and nextjs/parity/__tests__/integrations-oauth.replay.test.ts
# replays the last request of each example against a stand-in that answers them and compares the calls Node makes.
# #oauth_redirect renders the application layout and stays in Rails.
describe "Zoom integration", type: :request do
  include Parity::AudienceSignedIn

  let(:user) { create(:user, name: "Zoom Seller", username: "zoomseller", created_at: Time.utc(2025, 1, 1)) }
  let(:oauth_request_body) do
    { grant_type: "authorization_code", code: "test_code", redirect_uri: "http://#{DOMAIN}/integrations/zoom/oauth_redirect" }
  end
  let(:basic_token) { Base64.strict_encode64("#{GlobalConfig.get("ZOOM_CLIENT_ID")}:#{GlobalConfig.get("ZOOM_CLIENT_SECRET")}") }
  let(:oauth_request_header) { { "Authorization" => "Basic #{basic_token}", "Content-Type" => "application/x-www-form-urlencoded" } }
  let(:json_response) { { status: 200, headers: { "Content-Type" => "application/json" } } }

  before do
    host! DOMAIN
    log_in(user)
  end

  def stub_token(**response)
    WebMock.stub_request(:post, ZoomApi::ZOOM_OAUTH_URL).with(body: oauth_request_body, headers: oauth_request_header).to_return(response)
  end

  def stub_user(**response)
    WebMock.stub_request(:get, "#{ZoomApi.base_uri}/users/me").with(headers: { "Authorization" => "Bearer test_access_token" }).to_return(response)
  end

  def account_info(params = { code: "test_code" })
    get "/integrations/zoom/account_info", params:, headers: { "Accept" => "application/json" }
  end

  it "answers the account behind a valid code", parity: true do
    stub_token(**json_response, body: { access_token: "test_access_token", refresh_token: "test_refresh_token" }.to_json)
    stub_user(**json_response, body: { id: "zoom-user-1", email: "host@example.com" }.to_json)

    account_info

    expect(response.parsed_body).to eq("success" => true, "user_id" => "zoom-user-1", "email" => "host@example.com", "access_token" => "test_access_token", "refresh_token" => "test_refresh_token")
  end

  it "fails when Zoom refuses the code", parity: true do
    stub_token(status: 500)

    account_info

    expect(response.parsed_body).to eq("success" => false)
  end

  it "fails when the token answer has no access token", parity: true do
    stub_token(**json_response, body: { refresh_token: "test_refresh_token" }.to_json)

    account_info

    expect(response.parsed_body).to eq("success" => false)
  end

  it "fails when the token answer has no refresh token", parity: true do
    stub_token(**json_response, body: { access_token: "test_access_token" }.to_json)

    account_info

    expect(response.parsed_body).to eq("success" => false)
  end

  it "fails when the user answer has no id", parity: true do
    stub_token(**json_response, body: { access_token: "test_access_token", refresh_token: "test_refresh_token" }.to_json)
    stub_user(**json_response, body: { email: "host@example.com" }.to_json)

    account_info

    expect(response.parsed_body).to eq("success" => false)
  end

  it "fails when the user answer has no email", parity: true do
    stub_token(**json_response, body: { access_token: "test_access_token", refresh_token: "test_refresh_token" }.to_json)
    stub_user(**json_response, body: { id: "zoom-user-1" }.to_json)

    account_info

    expect(response.parsed_body).to eq("success" => false)
  end

  it "fails when the token answer is a JSON null", parity: true do
    stub_token(**json_response, body: "null")

    account_info

    expect(response.parsed_body).to eq("success" => false)
  end
end
