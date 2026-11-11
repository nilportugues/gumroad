# frozen_string_literal: true

require "spec_helper"

# Integrations::DiscordController's join_server, leave_server and oauth_redirect, recorded for the Next.js port (PARITY_RECORD=1)
# through the full Rack stack and replayed by nextjs/parity/__tests__/integrations-discord.replay.test.ts, which sends the last
# request of each example. Node answers the guards and the state redirect; anything that would reach Discord is handed to Rails,
# which the replay checks by the example's name ("hands a ..."). server_info is Discord's OAuth exchange end to end.
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

  def stub_discord_removal
    WebMock.stub_request(:delete, "#{Discordrb::API.api_base}/guilds/0/members/#{discord_user_id}").to_return(status: 204)
  end

  def state(user, **extra)
    { seller_id: ObfuscateIds.encrypt(user.id), **extra }.to_json
  end

  describe "GET /integrations/discord/oauth_redirect" do
    let(:seller) { create(:user, username: "discordseller") }

    def redirect(**params)
      get oauth_redirect_integrations_discord_index_path, params:
    end

    it "hands a code without a state to Rails", parity: true do
      redirect(code: "test_code")

      expect(response).to have_http_status(:ok)
    end

    it "hands a request without a code to Rails", parity: true do
      redirect

      expect(response).to have_http_status(:bad_request)
    end

    it "hands a state that is not JSON to Rails", parity: true do
      redirect(state: "test")

      expect(response).to have_http_status(:bad_request)
    end

    it "hands a state that is not a JSON object to Rails", parity: true do
      redirect(code: "test_code", state: "123")

      expect(response).to have_http_status(:ok)
    end

    it "hands a state without a seller id to Rails", parity: true do
      redirect(state: { is_custom_domain: false }.to_json)

      expect(response).to have_http_status(:bad_request)
    end

    it "hands a blank seller id to Rails", parity: true do
      redirect(code: "test_code", state: { seller_id: "  " }.to_json)

      expect(response).to have_http_status(:ok)
    end

    it "hands a seller id that is not text to Rails", parity: true do
      redirect(state: { seller_id: 12 }.to_json)

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

    it "hands a purchaser's request to Rails", parity: true do
      stub_discord_oauth_failure
      log_in(buyer)

      join(code: "test_code", purchase_id: purchase.external_id)

      expect(response.parsed_body).to eq("success" => false)
    end

    it "hands a download token holder's request to Rails", parity: true do
      stub_discord_oauth_failure
      redirect = create(:url_redirect, purchase:)

      join(code: "test_code", purchase_id: purchase.external_id, token: redirect.token)

      expect(response.parsed_body).to eq("success" => false)
    end

    it "hands a purchase of a membership that still grants access to Rails", parity: true do
      stub_discord_oauth_failure
      subscription = create(:subscription, link: product, user: buyer)
      purchase.update_columns(subscription_id: subscription.id)
      log_in(buyer)

      join(code: "test_code", purchase_id: purchase.external_id)

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

    it "hands a purchaser who joined the server to Rails", parity: true do
      stub_discord_removal
      log_in(buyer)

      leave(purchase_id: purchase.external_id)

      expect(response.parsed_body).to eq("success" => true, "server_name" => "Gaming")
    end

    it "hands a download token holder who joined the server to Rails", parity: true do
      stub_discord_removal
      redirect = create(:url_redirect, purchase:)

      leave(purchase_id: purchase.external_id, token: redirect.token)

      expect(response.parsed_body).to eq("success" => true, "server_name" => "Gaming")
    end
  end
end
