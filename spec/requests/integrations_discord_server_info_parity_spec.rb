# frozen_string_literal: true

require "spec_helper"

# Integrations::DiscordController#server_info as the integration form calls it, recorded for the Next.js port (PARITY_RECORD=1) with Discord
# stubbed by WebMock: the fixture keeps each call Rails made (the OAuth exchange, then Discordrb's profile request), and
# nextjs/parity/__tests__/integrations-providers.replay.test.ts replays the last request of each example against a stand-in that answers
# them in order and compares the calls Node makes. The test environment has no Discord client id or secret; the recording sets them.
describe "Discord server info", type: :request do
  include Parity::AudienceSignedIn

  let(:user) { create(:user, name: "Discord Seller", username: "discordseller", created_at: Time.utc(2025, 1, 1)) }
  let(:json_headers) { { "Content-Type" => "application/json" } }
  let(:json_response) { { status: 200, headers: json_headers } }
  let(:profile_url) { "https://discord.com/api/v9/users/@me" }
  let(:guild) { { id: "7001", name: "Gumroad Friends", icon: nil } }

  before do
    host! DOMAIN
    log_in(user)
  end

  def stub_token(**response) = WebMock.stub_request(:post, DISCORD_OAUTH_TOKEN_URL).to_return(response)

  def stub_profile(**response) = WebMock.stub_request(:get, profile_url).with(headers: { "Authorization" => "Bearer discord_access" }).to_return(response)

  def exchange_body = { access_token: "discord_access", token_type: "Bearer", guild: }.to_json

  def server_info(params = { code: "discord_code" }) = get("/integrations/discord/server_info", params:, headers: { "Accept" => "application/json" })

  it "answers the server and the username behind a valid code", parity: true do
    stub_token(**json_response, body: exchange_body)
    stub_profile(**json_response, body: { id: "42", username: "buyer_one" }.to_json)

    server_info

    expect(response.parsed_body).to eq("success" => true, "server_id" => "7001", "server_name" => "Gumroad Friends", "username" => "buyer_one")
  end

  it "answers a null username when the profile has none", parity: true do
    stub_token(**json_response, body: exchange_body)
    stub_profile(**json_response, body: { id: "42" }.to_json)

    server_info

    expect(response.parsed_body).to eq("success" => true, "server_id" => "7001", "server_name" => "Gumroad Friends", "username" => nil)
  end

  it "encodes a code that needs escaping and sends the redirect URI of the request", parity: true do
    stub_token(**json_response, body: exchange_body)
    stub_profile(**json_response, body: { username: "buyer_one" }.to_json)

    server_info(code: "a b&c=d+é/")

    expect(response.parsed_body["success"]).to be(true)
  end

  it "sends a bare code key when the request has none", parity: true do
    stub_token(status: 400, headers: json_headers, body: { error: "invalid_request" }.to_json)

    server_info({})

    expect(response.parsed_body).to eq("success" => false)
  end

  it "fails when Discord refuses the code", parity: true do
    stub_token(status: 400, headers: json_headers, body: { error: "invalid_grant" }.to_json)

    server_info

    expect(response.parsed_body).to eq("success" => false)
  end

  it "fails when the token answer carries no guild", parity: true do
    stub_token(**json_response, body: { access_token: "discord_access" }.to_json)

    server_info

    expect(response.parsed_body).to eq("success" => false)
  end

  it "fails when the guild is an empty object", parity: true do
    stub_token(**json_response, body: { access_token: "discord_access", guild: {} }.to_json)

    server_info

    expect(response.parsed_body).to eq("success" => false)
  end

  it "fails when the token answer carries no access token", parity: true do
    stub_token(**json_response, body: { guild: }.to_json)

    server_info

    expect(response.parsed_body).to eq("success" => false)
  end

  it "fails when the token answer is a JSON list", parity: true do
    stub_token(**json_response, body: [guild].to_json)

    server_info

    expect(response.parsed_body).to eq("success" => false)
  end

  it "fails when the token answer is not JSON", parity: true do
    stub_token(status: 200, headers: { "Content-Type" => "text/plain" }, body: "nope")

    server_info

    expect(response.parsed_body).to eq("success" => false)
  end

  it "fails when the profile call answers a Discord error", parity: true do
    stub_token(**json_response, body: exchange_body)
    stub_profile(status: 401, headers: json_headers, body: { message: "401: Unauthorized", code: 0 }.to_json)

    server_info

    expect(response.parsed_body).to eq("success" => false)
  end

  it "fails when the profile call answers an error that is not JSON", parity: true do
    stub_token(**json_response, body: exchange_body)
    stub_profile(status: 500, body: "boom")

    server_info

    expect(response.parsed_body).to eq("success" => false)
  end

  it "fails when the profile answer is not JSON", parity: true do
    stub_token(**json_response, body: exchange_body)
    stub_profile(**json_response, body: "not json")

    server_info

    expect(response.parsed_body).to eq("success" => false)
  end

  it "waits out a rate limit and asks for the profile again", parity: true do
    stub_token(**json_response, body: exchange_body)
    WebMock.stub_request(:get, profile_url).with(headers: { "Authorization" => "Bearer discord_access" })
      .to_return({ status: 429, headers: json_headers, body: { message: "You are being rate limited.", retry_after: 0.01, global: false }.to_json },
                 { **json_response, body: { username: "buyer_one" }.to_json })

    server_info

    expect(response.parsed_body).to eq("success" => true, "server_id" => "7001", "server_name" => "Gumroad Friends", "username" => "buyer_one")
  end
end
