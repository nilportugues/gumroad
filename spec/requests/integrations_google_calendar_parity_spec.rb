# frozen_string_literal: true

require "spec_helper"

# Integrations::GoogleCalendarController#account_info and #calendar_list as the integration form calls them, recorded for the Next.js port
# (PARITY_RECORD=1) with Google stubbed by WebMock: the fixture keeps each call Rails made, and
# nextjs/parity/__tests__/integrations-providers.replay.test.ts replays the last request of each example against a stand-in that answers
# them in order and compares the calls Node makes. The test environment has no GOOGLE_CLIENT_SECRET; the recording sets one.
describe "Google Calendar integration", type: :request do
  include Parity::AudienceSignedIn

  let(:user) { create(:user, name: "Calendar Seller", username: "calendarseller", created_at: Time.utc(2025, 1, 1)) }
  let(:json_headers) { { "Content-Type" => "application/json" } }
  let(:json_response) { { status: 200, headers: json_headers } }
  let(:token_url) { "#{GoogleCalendarApi::GOOGLE_CALENDAR_OAUTH_URL}/token" }
  let(:list_url) { "https://www.googleapis.com/calendar/v3/users/me/calendarList" }
  let(:json) { { "Accept" => "application/json" } }

  before do
    host! DOMAIN
    log_in(user)
  end

  def stub_token(**response) = WebMock.stub_request(:post, token_url).to_return(response)

  def stub_userinfo(**response) = WebMock.stub_request(:get, "https://www.googleapis.com/oauth2/v2/userinfo").with(query: { access_token: "gcal_access" }).to_return(response)

  def stub_list(token, **response) = WebMock.stub_request(:get, list_url).with(headers: { "Authorization" => "Bearer #{token}" }).to_return(response)

  def tokens = { access_token: "gcal_access", refresh_token: "gcal_refresh" }.to_json

  describe "GET /integrations/google_calendar/account_info" do
    def account_info(params = { code: "gcal_code" }) = get("/integrations/google_calendar/account_info", params:, headers: json)

    it "answers the account behind a valid code", parity: true do
      stub_token(**json_response, body: tokens)
      stub_userinfo(**json_response, body: { email: "host@example.com", id: "1" }.to_json)

      account_info

      expect(response.parsed_body).to eq("success" => true, "access_token" => "gcal_access", "refresh_token" => "gcal_refresh", "email" => "host@example.com")
    end

    it "encodes a code that needs escaping", parity: true do
      stub_token(**json_response, body: tokens)
      stub_userinfo(**json_response, body: { email: "host@example.com" }.to_json)

      account_info(code: "4/0A b&c=d+é")

      expect(response.parsed_body["success"]).to be(true)
    end

    it "sends a bare code key when the request has none", parity: true do
      stub_token(status: 400, headers: json_headers, body: { error: "invalid_request" }.to_json)

      account_info({})

      expect(response.parsed_body).to eq("success" => false)
    end

    it "fails when Google refuses the code", parity: true do
      stub_token(status: 400, headers: json_headers, body: { error: "invalid_grant" }.to_json)

      account_info

      expect(response.parsed_body).to eq("success" => false)
    end

    it "fails when the token answer has no refresh token", parity: true do
      stub_token(**json_response, body: { access_token: "gcal_access" }.to_json)

      account_info

      expect(response.parsed_body).to eq("success" => false)
    end

    it "fails when the token answer has no access token", parity: true do
      stub_token(**json_response, body: { refresh_token: "gcal_refresh" }.to_json)

      account_info

      expect(response.parsed_body).to eq("success" => false)
    end

    it "fails when the token answer is a JSON null", parity: true do
      stub_token(**json_response, body: "null")

      account_info

      expect(response.parsed_body).to eq("success" => false)
    end

    it "fails when the token answer is empty", parity: true do
      stub_token(status: 200, body: "")

      account_info

      expect(response.parsed_body).to eq("success" => false)
    end

    it "fails when the user info answer has no email", parity: true do
      stub_token(**json_response, body: tokens)
      stub_userinfo(**json_response, body: { id: "1" }.to_json)

      account_info

      expect(response.parsed_body).to eq("success" => false)
    end

    it "fails when the user info call is refused", parity: true do
      stub_token(**json_response, body: tokens)
      stub_userinfo(status: 401, headers: json_headers, body: { email: "host@example.com" }.to_json)

      account_info

      expect(response.parsed_body).to eq("success" => false)
    end

    it "fails when the user info answer is empty", parity: true do
      stub_token(**json_response, body: tokens)
      stub_userinfo(status: 200, body: "")

      account_info

      expect(response.parsed_body).to eq("success" => false)
    end

    it "hands a code sent as a list to Rails", parity: true do
      stub_token(**json_response, body: tokens)
      stub_userinfo(**json_response, body: { email: "host@example.com" }.to_json)

      get "/integrations/google_calendar/account_info?code[]=a&code[]=b", headers: json

      expect(response.parsed_body).to eq("success" => true, "access_token" => "gcal_access", "refresh_token" => "gcal_refresh", "email" => "host@example.com")
    end
  end

  describe "GET /integrations/google_calendar/calendar_list" do
    let(:items) { [{ id: "primary", summary: "Main", timeZone: "UTC", accessRole: "owner" }, { id: "work@example.com", summary: "Work" }] }

    def calendar_list(params = { access_token: "stale_access", refresh_token: "gcal_refresh" }) = get("/integrations/google_calendar/calendar_list", params:, headers: json)

    it "lists the id and summary of each calendar", parity: true do
      stub_list("stale_access", **json_response, body: { items: }.to_json)

      calendar_list

      expect(response.parsed_body).to eq("success" => true, "calendar_list" => [{ "id" => "primary", "summary" => "Main" }, { "id" => "work@example.com", "summary" => "Work" }])
    end

    it "refreshes an expired access token and lists again", parity: true do
      stub_list("stale_access", status: 401, headers: json_headers, body: { error: { code: 401 } }.to_json)
      stub_token(**json_response, body: { access_token: "fresh_access" }.to_json)
      stub_list("fresh_access", **json_response, body: { items: }.to_json)

      calendar_list

      expect(response.parsed_body["calendar_list"].map { |c| c["id"] }).to eq(["primary", "work@example.com"])
    end

    it "fails when the refresh answer has no access token", parity: true do
      stub_list("stale_access", status: 401, body: "")
      stub_token(**json_response, body: { error: "x" }.to_json)

      calendar_list

      expect(response.parsed_body).to eq("success" => false)
    end

    it "fails when the refresh is refused", parity: true do
      stub_list("stale_access", status: 401, body: "")
      stub_token(status: 400, headers: json_headers, body: { access_token: "fresh_access" }.to_json)

      calendar_list

      expect(response.parsed_body).to eq("success" => false)
    end

    it "fails when the list is still refused after a refresh", parity: true do
      stub_list("stale_access", status: 401, body: "")
      stub_token(**json_response, body: { access_token: "fresh_access" }.to_json)
      stub_list("fresh_access", status: 403, headers: json_headers, body: {}.to_json)

      calendar_list

      expect(response.parsed_body).to eq("success" => false)
    end

    it "fails without refreshing when the list is refused for another reason", parity: true do
      stub_list("stale_access", status: 403, headers: json_headers, body: {}.to_json)

      calendar_list

      expect(response.parsed_body).to eq("success" => false)
    end

    it "sends an empty bearer token when the request has no access token", parity: true do
      WebMock.stub_request(:get, list_url).with(headers: { "Authorization" => /\ABearer\s*\z/ }).to_return(status: 401, body: "")
      stub_token(status: 400, body: "")

      calendar_list({})

      expect(response.parsed_body).to eq("success" => false)
    end
  end
end
