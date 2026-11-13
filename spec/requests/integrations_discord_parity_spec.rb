# frozen_string_literal: true

require "spec_helper"

# Integrations::DiscordController's join_server, leave_server and oauth_redirect, recorded for the Next.js port (PARITY_RECORD=1)
# through the full Rack stack and replayed by nextjs/parity/__tests__/integrations-discord.replay.test.ts, which sends the last
# request of each example. Node answers the guards, the state redirect and, against a stand-in that answers the Discord calls the recording
# saw, the whole of join_server and leave_server; what it cannot prove is handed to Rails, which the replay checks by the example's name
# ("hands a ..."). server_info is Discord's OAuth exchange end to end. The empty page
# oauth_redirect renders when the state names no seller is in integrations_discord_oauth_redirect_page_parity_spec.rb.
describe "Integrations::DiscordController", type: :request do
  include Parity::SignedInDashboard

  let(:buyer) { create(:user) }
  let(:integration) { create(:discord_integration) }
  let(:product) { create(:product, active_integrations: [integration]) }
  let(:purchase) { create(:free_purchase, link: product, purchaser: buyer) }
  let(:discord_user_id) { "user-0" }

  def join(**params)
    get join_server_integrations_discord_index_path, params:
  end

  def leave(**params)
    get leave_server_integrations_discord_index_path, params:
  end

  def stub_discord_oauth_failure
    WebMock.stub_request(:post, DISCORD_OAUTH_TOKEN_URL).to_return(status: 500)
  end

  def stub_discord_removal(status: 204, body: "")
    WebMock.stub_request(:delete, "#{Discordrb::API.api_base}/guilds/0/members/#{discord_user_id}").to_return(status:, body:, headers: json_headers)
  end

  def json_headers = { "Content-Type" => "application/json" }

  def stub_discord_oauth(body: { access_token: "discord_access" }.to_json)
    WebMock.stub_request(:post, DISCORD_OAUTH_TOKEN_URL).to_return(status: 200, body:, headers: json_headers)
  end

  def stub_discord_profile(status: 200, body: { id: "42", username: "buyer_one" }.to_json)
    WebMock.stub_request(:get, "#{Discordrb::API.api_base}/users/@me").to_return(status:, body:, headers: json_headers)
  end

  def stub_discord_add_member(status: 201, body: "")
    WebMock.stub_request(:put, "#{Discordrb::API.api_base}/guilds/0/members/42").to_return(status:, body:, headers: json_headers)
  end

  def state(user, **extra)
    { seller_id: ObfuscateIds.encrypt(user.id), **extra }.to_json
  end

  describe "GET /integrations/discord/oauth_redirect" do
    let(:seller) { create(:user, username: "discordseller") }

    def redirect(**params)
      get oauth_redirect_integrations_discord_index_path, params:
    end

    it "hands a state that is not JSON to Rails", parity: true do
      redirect(state: "test")

      expect(response).to have_http_status(:bad_request)
    end

    it "answers a seller id that does not decrypt with a 404", parity: true do
      redirect(code: "test_code", state: { seller_id: "not-an-id" }.to_json)

      expect(response).to have_http_status(:not_found)
    end

    it "answers the id of a seller that does not exist with a 404", parity: true do
      redirect(code: "test_code", state: { seller_id: ObfuscateIds.encrypt(User.maximum(:id).to_i + 1000) }.to_json)

      expect(response).to have_http_status(:not_found)
    end

    it "redirects to the seller's subdomain with the code", parity: true do
      redirect(code: "test_code", state: state(seller, is_custom_domain: false))

      expect(response).to redirect_to(oauth_redirect_integrations_discord_index_url(host: seller.subdomain, params: { code: "test_code" }))
    end

    it "escapes the code the way a query string does", parity: true do
      redirect(code: "a b&c=d/é", state: state(seller))

      expect(response).to redirect_to(oauth_redirect_integrations_discord_index_url(host: seller.subdomain, params: { code: "a b&c=d/é" }))
    end

    it "redirects without a code when the request has none", parity: true do
      redirect(state: state(seller))

      expect(response).to redirect_to(oauth_redirect_integrations_discord_index_url(host: seller.subdomain, params: {}))
    end

    it "keeps an empty code", parity: true do
      redirect(code: "", state: state(seller))

      expect(response).to redirect_to(oauth_redirect_integrations_discord_index_url(host: seller.subdomain, params: { code: "" }))
    end

    it "treats any value but false and null as a custom domain", parity: true do
      custom_domain = CustomDomain.create(user: seller, domain: "www.discord-custom.example.com")

      redirect(code: "test_code", state: state(seller, is_custom_domain: 0))

      expect(response).to redirect_to(oauth_redirect_integrations_discord_index_url(host: custom_domain.domain, params: { code: "test_code" }))
    end

    it "redirects to the seller's custom domain when the state says so", parity: true do
      custom_domain = CustomDomain.create(user: seller, domain: "www.discord-custom.example.com")

      redirect(code: "test_code", state: state(seller, is_custom_domain: true))

      expect(response).to redirect_to(oauth_redirect_integrations_discord_index_url(host: custom_domain.domain, params: { code: "test_code" }))
    end

    it "ignores a custom domain that was deleted when the state asks for the subdomain", parity: true do
      CustomDomain.create(user: seller, domain: "www.discord-custom.example.com").mark_deleted!

      redirect(code: "test_code", state: state(seller, is_custom_domain: false))

      expect(response).to redirect_to(oauth_redirect_integrations_discord_index_url(host: seller.subdomain, params: { code: "test_code" }))
    end

    it "hands a state sent as a list to Rails", parity: true do
      get "#{oauth_redirect_integrations_discord_index_path}?state[]=test"

      expect(response).to have_http_status(:bad_request)
    end

    it "hands a seller without a username to Rails", parity: true do
      seller.update_columns(username: nil)

      redirect(code: "test_code", state: state(seller))

      expect(response).to have_http_status(:found)
    end
  end

  describe "GET /integrations/discord/join_server" do
    it "reports failure without a code", parity: true do
      log_in(buyer)

      join(purchase_id: purchase.external_id)

      expect(response.parsed_body).to eq("success" => false)
    end

    it "reports failure without a purchase", parity: true do
      log_in(buyer)

      join(code: "test_code")

      expect(response.parsed_body).to eq("success" => false)
    end

    it "reports failure for a blank code", parity: true do
      log_in(buyer)

      join(code: " ", purchase_id: purchase.external_id)

      expect(response.parsed_body).to eq("success" => false)
    end

    it "reports failure for a purchase that does not exist", parity: true do
      log_in(buyer)

      join(code: "test_code", purchase_id: "unknown")

      expect(response.parsed_body).to eq("success" => false)
    end

    it "rejects a signed-out visitor without a download token", parity: true do
      join(code: "test_code", purchase_id: purchase.external_id)

      expect(response.parsed_body).to eq("success" => false)
    end

    it "rejects a signed-in user joining a purchase they do not own", parity: true do
      other_purchase = create(:free_purchase, link: product, purchaser: create(:user))
      log_in(buyer)

      join(code: "test_code", purchase_id: other_purchase.external_id)

      expect(response.parsed_body).to eq("success" => false)
    end

    it "rejects a download token that belongs to another purchase", parity: true do
      other_purchase = create(:free_purchase, link: product, purchaser: create(:user))
      redirect = create(:url_redirect, purchase: other_purchase)

      join(code: "test_code", purchase_id: purchase.external_id, token: redirect.token)

      expect(response.parsed_body).to eq("success" => false)
    end

    it "rejects a blank download token", parity: true do
      create(:url_redirect, purchase:)

      join(code: "test_code", purchase_id: purchase.external_id, token: "")

      expect(response.parsed_body).to eq("success" => false)
    end

    it "rejects a refunded purchase", parity: true do
      purchase.update_columns(stripe_refunded: true)
      log_in(buyer)

      join(code: "test_code", purchase_id: purchase.external_id)

      expect(response.parsed_body).to eq("success" => false)
    end

    it "rejects a refunded purchase even with its download token", parity: true do
      purchase.update_columns(stripe_refunded: true)
      redirect = create(:url_redirect, purchase:)

      join(code: "test_code", purchase_id: purchase.external_id, token: redirect.token)

      expect(response.parsed_body).to eq("success" => false)
    end

    it "rejects a charged back purchase", parity: true do
      purchase.update_columns(chargeback_date: 1.day.ago)
      log_in(buyer)

      join(code: "test_code", purchase_id: purchase.external_id)

      expect(response.parsed_body).to eq("success" => false)
    end

    it "rejects a purchase whose access was revoked", parity: true do
      purchase.update_attribute(:is_access_revoked, true)
      log_in(buyer)

      join(code: "test_code", purchase_id: purchase.external_id)

      expect(response.parsed_body).to eq("success" => false)
    end

    it "rejects a purchase of a lapsed membership", parity: true do
      subscription = create(:subscription, link: product, user: buyer, failed_at: Time.current)
      product.update_attribute(:block_access_after_membership_cancellation, true)
      purchase.update_columns(subscription_id: subscription.id)
      log_in(buyer)

      join(code: "test_code", purchase_id: purchase.external_id)

      expect(response.parsed_body).to eq("success" => false)
    end

    it "fails when Discord refuses the code of a purchaser", parity: true do
      stub_discord_oauth_failure
      log_in(buyer)

      join(code: "test_code", purchase_id: purchase.external_id)

      expect(response.parsed_body).to eq("success" => false)
    end

    it "fails when Discord refuses the code of a download token holder", parity: true do
      stub_discord_oauth_failure
      redirect = create(:url_redirect, purchase:)

      join(code: "test_code", purchase_id: purchase.external_id, token: redirect.token)

      expect(response.parsed_body).to eq("success" => false)
    end

    it "fails when Discord refuses the code of a membership that still grants access", parity: true do
      stub_discord_oauth_failure
      subscription = create(:subscription, link: product, user: buyer)
      purchase.update_columns(subscription_id: subscription.id)
      log_in(buyer)

      join(code: "test_code", purchase_id: purchase.external_id)

      expect(response.parsed_body).to eq("success" => false)
    end

    it "adds the purchaser to the server and records the membership", parity: true do
      stub_discord_oauth
      stub_discord_profile
      stub_discord_add_member
      log_in(buyer)

      join(code: "test_code", purchase_id: purchase.external_id)

      expect(response.parsed_body).to eq("success" => true, "server_name" => "Gaming")
      expect(purchase.live_purchase_integrations.pluck(:discord_user_id)).to eq(["42"])
    end

    it "accepts a 204 from the member add for a download token holder", parity: true do
      stub_discord_oauth
      stub_discord_profile
      stub_discord_add_member(status: 204)
      redirect = create(:url_redirect, purchase:)

      join(code: "test_code", purchase_id: purchase.external_id, token: redirect.token)

      expect(response.parsed_body).to eq("success" => true, "server_name" => "Gaming")
    end

    it "fails without a membership when the member add answers another success status", parity: true do
      stub_discord_oauth
      stub_discord_profile
      stub_discord_add_member(status: 200)
      log_in(buyer)

      join(code: "test_code", purchase_id: purchase.external_id)

      expect(response.parsed_body).to eq("success" => false)
    end

    it "fails when the token answer carries no access token", parity: true do
      stub_discord_oauth(body: { error: "x" }.to_json)
      log_in(buyer)

      join(code: "test_code", purchase_id: purchase.external_id)

      expect(response.parsed_body).to eq("success" => false)
    end

    it "fails when the profile request is refused", parity: true do
      stub_discord_oauth
      stub_discord_profile(status: 401, body: { code: 0, message: "401: Unauthorized" }.to_json)
      log_in(buyer)

      join(code: "test_code", purchase_id: purchase.external_id)

      expect(response.parsed_body).to eq("success" => false)
    end

    it "fails when the profile is not JSON", parity: true do
      stub_discord_oauth
      stub_discord_profile(body: "not json")
      log_in(buyer)

      join(code: "test_code", purchase_id: purchase.external_id)

      expect(response.parsed_body).to eq("success" => false)
    end

    it "fails when the bot lacks permission to add the member", parity: true do
      stub_discord_oauth
      stub_discord_profile
      stub_discord_add_member(status: 403, body: { code: 50013, message: "Missing Permissions" }.to_json)
      log_in(buyer)

      join(code: "test_code", purchase_id: purchase.external_id)

      expect(response.parsed_body).to eq("success" => false)
    end

    it "fails when Discord reports the server as unknown on the member add", parity: true do
      stub_discord_oauth
      stub_discord_profile
      stub_discord_add_member(status: 404, body: { code: 10_004, message: "Unknown Guild" }.to_json)
      log_in(buyer)

      join(code: "test_code", purchase_id: purchase.external_id)

      expect(response.parsed_body).to eq("success" => false)
    end

    it "fails for a purchase that already joined the server", parity: true do
      create(:purchase_integration, integration:, purchase:, discord_user_id: "42")
      stub_discord_oauth
      stub_discord_profile
      stub_discord_add_member
      log_in(buyer)

      join(code: "test_code", purchase_id: purchase.external_id)

      expect(response.parsed_body).to eq("success" => false)
    end

    it "fails for a product without a Discord integration", parity: true do
      other_product = create(:product)
      other_purchase = create(:free_purchase, link: other_product, purchaser: buyer)
      stub_discord_oauth
      stub_discord_profile
      log_in(buyer)

      join(code: "test_code", purchase_id: other_purchase.external_id)

      expect(response.parsed_body).to eq("success" => false)
    end

    it "hands a token sent as a hash to Rails", parity: true do
      get "#{join_server_integrations_discord_index_path}?code=test_code&purchase_id=#{CGI.escape(purchase.external_id)}&token[x]=y"

      expect(response.parsed_body).to eq("success" => false)
    end
  end

  describe "GET /integrations/discord/leave_server" do
    before { create(:purchase_integration, integration:, purchase:, discord_user_id:) }

    it "reports failure without a purchase", parity: true do
      log_in(buyer)

      leave

      expect(response.parsed_body).to eq("success" => false)
    end

    it "reports failure for a purchase that does not exist", parity: true do
      log_in(buyer)

      leave(purchase_id: "unknown")

      expect(response.parsed_body).to eq("success" => false)
    end

    it "rejects a signed-out visitor without a download token", parity: true do
      leave(purchase_id: purchase.external_id)

      expect(response.parsed_body).to eq("success" => false)
    end

    it "rejects a signed-in user leaving a purchase they do not own", parity: true do
      log_in(create(:user))

      leave(purchase_id: purchase.external_id)

      expect(response.parsed_body).to eq("success" => false)
    end

    it "rejects a download token that belongs to another purchase", parity: true do
      redirect = create(:url_redirect, purchase: create(:free_purchase, link: product, purchaser: create(:user)))

      leave(purchase_id: purchase.external_id, token: redirect.token)

      expect(response.parsed_body).to eq("success" => false)
    end

    it "rejects a refunded purchase", parity: true do
      purchase.update_columns(stripe_refunded: true)
      log_in(buyer)

      leave(purchase_id: purchase.external_id)

      expect(response.parsed_body).to eq("success" => false)
    end

    it "rejects a purchase whose access was revoked", parity: true do
      purchase.update_attribute(:is_access_revoked, true)
      log_in(buyer)

      leave(purchase_id: purchase.external_id)

      expect(response.parsed_body).to eq("success" => false)
    end

    it "reports failure for a purchase that never joined the server", parity: true do
      other_purchase = create(:free_purchase, link: product, purchaser: buyer)
      log_in(buyer)

      leave(purchase_id: other_purchase.external_id)

      expect(response.parsed_body).to eq("success" => false)
    end

    it "reports failure for a purchase whose membership was deleted", parity: true do
      purchase.live_purchase_integrations.first.mark_deleted!
      log_in(buyer)

      leave(purchase_id: purchase.external_id)

      expect(response.parsed_body).to eq("success" => false)
    end

    it "removes a purchaser who joined the server and deletes the membership", parity: true do
      stub_discord_removal
      log_in(buyer)

      leave(purchase_id: purchase.external_id)

      expect(response.parsed_body).to eq("success" => true, "server_name" => "Gaming")
    end

    it "removes a download token holder who joined the server", parity: true do
      stub_discord_removal
      redirect = create(:url_redirect, purchase:)

      leave(purchase_id: purchase.external_id, token: redirect.token)

      expect(response.parsed_body).to eq("success" => true, "server_name" => "Gaming")
    end
    it "deletes the membership when Discord reports the server as unknown", parity: true do
      stub_discord_removal(status: 404, body: { code: 10_004, message: "Unknown Guild" }.to_json)
      log_in(buyer)

      leave(purchase_id: purchase.external_id)

      expect(response.parsed_body).to eq("success" => true, "server_name" => "Gaming")
      expect(purchase.live_purchase_integrations).to be_empty
    end

    it "keeps the membership when the bot lacks permission to remove it", parity: true do
      stub_discord_removal(status: 403, body: { code: 50013, message: "Missing Permissions" }.to_json)
      log_in(buyer)

      leave(purchase_id: purchase.external_id)

      expect(response.parsed_body).to eq("success" => false)
    end

    it "keeps the membership when the removal answers another success status", parity: true do
      stub_discord_removal(status: 200)
      log_in(buyer)

      leave(purchase_id: purchase.external_id)

      expect(response.parsed_body).to eq("success" => false)
    end
  end
end
