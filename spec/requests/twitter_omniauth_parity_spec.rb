# frozen_string_literal: true

require "spec_helper"

# The OAuth 1.0a flow of the Twitter (X) strategy: the request token call and the redirect to Twitter, and the callback that trades the
# verifier for an access token, verifies the credentials and links the account of a signed-in seller. Recorded for the Next.js port
# (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/twitter-omniauth.replay.test.ts against a stand-in server that holds Node to
# the recorded calls, in order, with the same OAuth Authorization header. The header is only reproducible because the nonce and the
# timestamp are fixed here and in the replay. The OmniAuth middleware runs for real (test_mode off); every Twitter answer is a WebMock stub.
# An example named "hands ..." is one Node leaves to Rails: the verifier is spent by the token call, so what Node cannot finish after it
# (a login or signup, a profile picture to download, the async window page) is handed back before anything is asked of Twitter.
describe "Twitter OAuth", type: :request do
  include Parity::AudienceSignedIn

  let(:nonce) { "c25dfixednonce" }
  let(:timestamp) { "1798070400" }
  let(:twitter) { "https://api.twitter.com" }
  let(:credentials_path) { "/1.1/account/verify_credentials.json" }
  let(:user) { create(:named_seller, name: "Twitter Connector") }
  let(:html) { { "Content-Type" => "text/html; charset=utf-8" } }
  let(:json) { { "Content-Type" => "application/json; charset=utf-8" } }
  let(:raw_info) do
    { "id" => 4_242_424_242, "id_str" => "4242424242", "name" => "Twitter: Connector", "screen_name" => "twitterconnector",
      "description" => "Building things at https://t.co/abc123", "email" => "connector@example.com",
      "entities" => { "description" => { "urls" => [{ "url" => "https://t.co/abc123", "display_url" => "example.com/build" }] } },
      "followers_count" => 321, "statuses_count" => 45, "created_at" => "Wed Mar 04 10:00:00 +0000 2015",
      "status" => { "created_at" => "Fri May 01 08:30:00 +0000 2026" } }
  end

  around do |example|
    previous = OmniAuth.config.test_mode
    OmniAuth.config.test_mode = false
    example.run
  ensure
    OmniAuth.config.test_mode = previous
  end

  before do
    host! DOMAIN
    allow(ViteRuby.instance.manifest).to receive(:resolve_entries).and_return({ stylesheets: ["/vite-test.css"] })
    allow_any_instance_of(ActionView::Base).to receive(:vite_client_tag).and_return("")
    allow_any_instance_of(ActionView::Base).to receive(:vite_react_refresh_tag).and_return("")
    allow_any_instance_of(ActionView::Base).to receive(:vite_typescript_tag).and_return("")
    allow_any_instance_of(OAuth::Client::Helper).to receive(:generate_key).and_return(nonce)
    allow_any_instance_of(OAuth::Client::Helper).to receive(:generate_timestamp).and_return(timestamp)
    # The profile picture download of a login or a seller with no avatar (User#twitter_picture_url), which fails quietly.
    stub_request(:post, %r{api\.twitter\.com/oauth2/token}).to_return(status: 200, headers: json, body: { token_type: "bearer", access_token: "app-only" }.to_json)
    stub_request(:get, %r{api\.twitter\.com/1\.1/users/show}).to_return(status: 404, headers: json, body: "{}")
  end

  def attach_avatar(seller)
    blob = ActiveStorage::Blob.create!(key: "c25d-avatar-#{seller.id}", filename: "avatar.png", content_type: "image/png", metadata: { "analyzed" => true },
                                       byte_size: 10, checksum: "c25dchecksum", service_name: ActiveStorage::Blob.service.name)
    # attach(blob) would ask the storage service about the file; the row is all `avatar.attached?` reads.
    ActiveStorage::Attachment.insert({ name: "avatar", record_type: "User", record_id: seller.id, blob_id: blob.id, created_at: Time.current })
  end

  def stub_request_token(status: 200, body: "oauth_token=request-token-1&oauth_token_secret=request-secret-1&oauth_callback_confirmed=true")
    stub_request(:post, "#{twitter}/oauth/request_token").to_return(status:, headers: html, body:)
  end

  def stub_access_token(status: 200, body: "oauth_token=access-token-1&oauth_token_secret=access-secret-1&user_id=4242424242&screen_name=twitterconnector")
    stub_request(:post, "#{twitter}/oauth/access_token").to_return(status:, headers: html, body:)
  end

  def stub_credentials(body: raw_info)
    stub_request(:get, "#{twitter}#{credentials_path}").with(query: { include_entities: false, skip_status: true, include_email: true })
      .to_return(status: 200, headers: json, body: body.to_json)
  end

  def begin_flow(query = nil, params: {}, headers: {})
    stub_request_token
    post ["/users/auth/twitter", query].compact.join("?"), params: { authenticity_token: csrf_token }.merge(params), headers: headers
    expect(response).to have_http_status(:found)
  end

  def callback(query = { oauth_token: "request-token-1", oauth_verifier: "verifier-1" })
    get "/users/auth/twitter/callback", params: query
  end

  def visit_connections(params = {})
    get("/settings/social_connections", params:)
    inertia_props_of(response)["social_connect_return"]
  end

  def events(stage) = Event.where(user_id: user.id, event_name: "social_connect_#{stage}", parent_referrer: "twitter").pluck(:view_url, :referrer)

  describe "POST /users/auth/twitter" do
    it "sends a visitor to Twitter with the request token the signed call returned", parity: true do
      stub_request_token
      post "/users/auth/twitter", params: { authenticity_token: csrf_token }

      expect(response).to redirect_to("#{twitter}/oauth/authenticate?oauth_token=request-token-1")
      expect(WebMock).to have_requested(:post, "#{twitter}/oauth/request_token").with { |request| request.headers["Authorization"].include?("oauth_nonce=\"#{nonce}\"") }
    end

    it "passes the login hints of the request on to Twitter", parity: true do
      stub_request_token
      post "/users/auth/twitter", params: { authenticity_token: csrf_token, force_login: "true", lang: "fr", screen_name: "gumroad" }

      expect(response.location).to eq("#{twitter}/oauth/authenticate?force_login=true&lang=fr&screen_name=gumroad&oauth_token=request-token-1")
    end

    it "asks for the authorize page and signs the access type it sends in the body", parity: true do
      stub_request_token
      post "/users/auth/twitter", params: { authenticity_token: csrf_token, use_authorize: "true", x_auth_access_type: "read" }

      expect(response.location).to eq("#{twitter}/oauth/authorize?oauth_token=request-token-1")
      expect(a_request(:post, "#{twitter}/oauth/request_token").with(body: "x_auth_access_type=read")).to have_been_made
    end

    it "does not carry the options of one request over to the next", parity: true do
      stub_request_token
      post "/users/auth/twitter", params: { authenticity_token: csrf_token, force_login: "true", x_auth_access_type: "write" }
      post "/users/auth/twitter", params: { authenticity_token: csrf_token }

      expect(response.location).to eq("#{twitter}/oauth/authenticate?oauth_token=request-token-1")
    end

    it "puts the query string of a link request in the callback and records the attempt of a signed-in seller", parity: true do
      log_in(user)
      stub_request_token

      post "/users/auth/twitter?state=link_twitter_account", params: { authenticity_token: csrf_token }

      expect(response.location).to eq("#{twitter}/oauth/authenticate?oauth_token=request-token-1")
      expect(a_request(:post, "#{twitter}/oauth/request_token")).to have_been_made
      expect(events("attempted")).to eq([["omniauth", nil]])
    end

    it "does not record an attempt for a login request of a signed-in seller", parity: true do
      log_in(user)
      stub_request_token

      post "/users/auth/twitter", params: { authenticity_token: csrf_token }

      expect(response).to have_http_status(:found)
      expect(events("attempted")).to eq([])
    end

    it "keeps the page a visitor came from", parity: true do
      stub_request_token
      post "/users/auth/twitter", params: { authenticity_token: csrf_token }, headers: { "Referer" => "http://#{DOMAIN}/pricing" }

      expect(response).to have_http_status(:found)
    end

    it "hands a request to Rails when Twitter is unavailable", parity: true do
      stub_request_token(status: 503, body: "Over capacity")
      post "/users/auth/twitter", params: { authenticity_token: csrf_token }

      expect(response).to redirect_to("/users/sign_in")
      expect(flash[:alert]).to eq("Could not authenticate you from Twitter because \"Service unavailable\".")
    end

    it "hands a link request of a signed-in seller to Rails when Twitter is unavailable", parity: true do
      log_in(user)
      stub_request_token(status: 503, body: "Over capacity")

      post "/users/auth/twitter?state=link_twitter_account", params: { authenticity_token: csrf_token }

      expect(response).to redirect_to("/users/sign_in")
      expect(events("failed")).to eq([["omniauth", "service_unavailable"]])
    end

    it "hands a request that names a callback URL of its own to Rails", parity: true do
      stub_request_token
      post "/users/auth/twitter", params: { authenticity_token: csrf_token, callback_url: "http://#{DOMAIN}/users/auth/twitter/callback" }

      expect(response).to have_http_status(:found)
    end

    it "hands a request with a wrong authenticity token to Rails", parity: true do
      post "/users/auth/twitter", params: { authenticity_token: "wrong" }

      expect(response).to have_http_status(:found)
    end
  end

  describe "GET /users/auth/twitter/callback" do
    before { attach_avatar(user) }

    def link!
      log_in(user)
      begin_flow("state=link_twitter_account")
      stub_access_token
      stub_credentials
      user.update_columns(updated_at: 1.hour.ago)
    end

    it "links the account of a signed-in seller", parity: true do
      link!

      callback

      expect(response).to redirect_to("/settings/social_connections")
      user.reload
      expect(user).to have_attributes(twitter_user_id: "4242424242", twitter_handle: "twitterconnector", twitter_oauth_token: "access-token-1", twitter_oauth_secret: "access-secret-1")
      expect(user.bio).to eq("Building things at example.com/build")
      expect(SocialConnectVerification.find_by!(user:, platform: "twitter")).to have_attributes(uid: "4242424242", handle: "twitterconnector", follower_count: 321, post_count: 45)
      expect(events("connected")).to eq([["omniauth", nil]])
      expect(WebMock).to have_requested(:get, "#{twitter}#{credentials_path}").with(query: { include_entities: false, skip_status: true, include_email: true })
    end

    it "fills the name, the username and the bio a seller does not have", parity: true do
      user.update_columns(name: nil, username: nil, bio: nil)
      link!

      callback

      expect(user.reload).to have_attributes(name: "Twitter Connector", bio: "Building things at example.com/build")
      expect(user.read_attribute(:username)).to eq("twitterconnector")
    end

    it "keeps the name and the bio a seller wrote", parity: true do
      user.update!(name: "Chosen Name", bio: "My own bio")
      link!

      callback

      expect(user.reload).to have_attributes(name: "Chosen Name", bio: "My own bio", twitter_handle: "twitterconnector")
    end

    it "drops a username that is no longer valid", parity: true do
      user.update_columns(username: nil)
      create(:user, username: "twitterconnector")
      link!

      callback

      expect(user.reload.read_attribute(:username)).to be_nil
      expect(user.twitter_handle).to eq("twitterconnector")
    end

    it "supersedes the verification of another X account and refreshes the same one", parity: true do
      create(:social_connect_verification, user:, platform: "twitter", uid: "1111", handle: "first", created_at: 2.weeks.ago, updated_at: 2.weeks.ago)
      link!

      callback

      expect(SocialConnectVerification.where(user:, platform: "twitter").order(:id).pluck(:uid, :superseded_at).map { |uid, superseded| [uid, superseded.present?] }).to eq([["1111", true], ["4242424242", false]])
    end

    it "clears the reconnect notice of a seller whose X posts were waiting for write permission", parity: true do
      waiting = create(:marketing_action, user:, link: create(:product), error_code: Marketing::Action::X_WRITE_PERMISSION_MISSING)
      posted = create(:marketing_action, user:, link: create(:product), error_code: Marketing::Action::X_WRITE_PERMISSION_MISSING, status: "posted")
      link!
      [waiting, posted].each { |action| action.update_columns(updated_at: 1.hour.ago) }

      callback

      expect(waiting.reload.error_code).to be_nil
      expect(posted.reload.error_code).to eq(Marketing::Action::X_WRITE_PERMISSION_MISSING)
    end

    it "sends a seller back to the page the flow started from", parity: true do
      log_in(user)
      return_token = visit_connections(social_connect_origin: "onboarding")
      begin_flow("state=link_twitter_account&social_connect_return=#{return_token}")
      stub_access_token
      stub_credentials

      callback

      expect(response).to redirect_to("/dashboard")
      expect(user.reload.twitter_handle).to eq("twitterconnector")
    end

    it "sends a visitor who is not signed in to the login page after the account was verified", parity: true do
      begin_flow("state=link_twitter_account")
      stub_access_token
      stub_credentials

      callback

      expect(response).to redirect_to("/login")
      expect(flash[:alert]).to eq("You need to be logged in to link your X account.")
    end

    it "returns a signed-in seller to the social connections when Twitter refuses the verifier", parity: true do
      log_in(user)
      begin_flow("state=link_twitter_account")
      stub_access_token(status: 401, body: "Invalid / expired Token")

      callback(denied: "request-token-1")

      expect(response).to redirect_to("/settings/social_connections")
      expect(flash[:alert]).to eq("Couldn't connect X. Please try again.")
      expect(SocialConnectVerification.where(user:)).to be_empty
    end

    it "hands a login callback to Rails when Twitter refuses the request token", parity: true do
      begin_flow
      stub_access_token(status: 401, body: "Invalid / expired Token")

      callback

      expect(response).to redirect_to("/users/sign_in")
      expect(flash[:alert]).to eq("Could not authenticate you from Twitter because \"Invalid credentials\".")
    end

    it "sends a visitor whose session has no request token to the login page", parity: true do
      callback

      expect(response).to redirect_to("/users/sign_in")
      expect(flash[:alert]).to eq("Could not authenticate you from Twitter because \"Session expired\".")
    end

    it "hands a login callback to Rails when the access token call fails", parity: true do
      begin_flow
      stub_access_token(status: 502, body: "Bad gateway")

      callback

      expect(response).to redirect_to("/users/sign_in")
      expect(flash[:alert]).to eq("Could not authenticate you from Twitter because \"Service unavailable\".")
    end

    it "hands a login callback to Rails", parity: true do
      begin_flow
      stub_access_token
      stub_credentials

      callback

      expect(response).to have_http_status(:found)
    end

    it "hands a callback of the async link to Rails", parity: true do
      log_in(user)
      begin_flow("state=async_link_twitter_account")
      stub_access_token
      stub_credentials

      callback

      expect(response).to have_http_status(:ok)
    end

    it "hands a callback of a seller with no avatar to Rails", parity: true do
      ActiveStorage::Attachment.where(record_type: "User", record_id: user.id, name: "avatar").delete_all
      link!

      callback

      expect(response).to redirect_to("/settings/social_connections")
    end
  end
end
