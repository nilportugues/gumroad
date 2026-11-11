# frozen_string_literal: true

require "spec_helper"

# The callbacks of the YouTube, Instagram and TikTok connect flows that carry a code: the token exchange, the profile fetch, the
# SocialConnectVerification and the identity write of User::OmniauthCallbacksController, recorded for the Next.js port (PARITY_RECORD=1)
# and replayed by nextjs/parity/__tests__/social-connect-token-exchange.replay.test.ts. Every provider answer is a WebMock stub, and the
# fixture keeps each outbound call in order: the replay answers them from a stand-in server and asserts what Node sent and in which order.
# The OmniAuth middleware runs for real (test_mode off). An example named "hands ..." is one Node leaves to Rails.
describe "Social connect token exchange", type: :request do
  include Parity::AudienceSignedIn

  let(:user) { create(:named_seller, name: "Social Connector") }
  let(:json) { { "Content-Type" => "application/json" } }
  let(:google_audience) { GOOGLE_CLIENT_ID }

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
  end

  def begin_flow(provider, query = nil)
    post ["/users/auth/#{provider}", query].compact.join("?"), params: { authenticity_token: csrf_token }
    expect(response).to have_http_status(:found)
    Rack::Utils.parse_query(URI(response.location).query)["state"]
  end

  def visit_connections(params = {})
    get("/settings/social_connections", params:)
    inertia_props_of(response)["social_connect_return"]
  end

  def callback(provider, state, code: "code-1")
    get "/users/auth/#{provider}/callback", params: { code:, state: }
  end

  def failed_events(provider) = Event.where(user_id: user.id, event_name: "social_connect_failed", parent_referrer: provider).pluck(:referrer)

  def connected_events(provider) = Event.where(user_id: user.id, event_name: "social_connect_connected", parent_referrer: provider).count

  def id_token(aud: google_audience, iss: "https://accounts.google.com", exp: 4_102_444_800)
    JWT.encode({ iss:, aud:, sub: "google-sub-1", exp: }, "unverified-key", "HS256")
  end

  describe "youtube" do
    let(:token) { "youtube-access-token" }
    let(:channel_item) do
      { "id" => "UC-channel-1", "snippet" => { "customUrl" => "@socialconnector", "publishedAt" => "2015-03-04T10:00:00Z" },
        "statistics" => { "subscriberCount" => "1234", "videoCount" => "56" },
        "contentDetails" => { "relatedPlaylists" => { "uploads" => "UU-uploads-1" } } }
    end

    def stub_google_token(status: 200, body: nil, id_token: self.id_token)
      body ||= { access_token: token, expires_in: 3599, scope: "email profile", token_type: "Bearer", id_token: }
      stub_request(:post, "https://oauth2.googleapis.com/token").to_return(status:, headers: json, body: body.to_json)
    end

    def stub_google_identity(userinfo_status: 200)
      stub_request(:get, "https://www.googleapis.com/oauth2/v3/tokeninfo").with(query: { access_token: token })
        .to_return(status: 200, headers: json, body: { scope: "email profile https://www.googleapis.com/auth/youtube.readonly" }.to_json)
      stub_request(:get, "https://www.googleapis.com/oauth2/v3/userinfo").with(headers: { "Authorization" => "Bearer #{token}" })
        .to_return(status: userinfo_status, headers: json, body: { sub: "google-sub-1", name: "Social Connector", email: "connector@example.com", email_verified: true }.to_json)
    end

    def stub_channel(status: 200, body: { items: [channel_item] })
      stub_request(:get, "https://www.googleapis.com/youtube/v3/channels").with(query: { part: "snippet,statistics,contentDetails", mine: true })
        .to_return(status:, headers: json, body: body.to_json)
    end

    def stub_uploads(status: 200, body: { items: [{ snippet: { publishedAt: "2026-05-01T08:30:00Z" } }] })
      stub_request(:get, "https://www.googleapis.com/youtube/v3/playlistItems").with(query: { part: "snippet", playlistId: "UU-uploads-1", maxResults: 1 })
        .to_return(status:, headers: json, body: body.to_json)
    end

    def stub_success
      stub_google_token
      stub_google_identity
      stub_channel
      stub_uploads
    end

    before { Feature.activate_user(:youtube_connect, user) }

    it "connects a seller's channel", parity: true do
      log_in(user)
      state = begin_flow("youtube")
      stub_success

      callback("youtube", state)

      expect(response).to redirect_to("/settings/social_connections")
      verification = SocialConnectVerification.find_by!(user:, platform: "youtube")
      expect(verification).to have_attributes(uid: "UC-channel-1", handle: "socialconnector", follower_count: 1234, post_count: 56)
      expect(user.reload.youtube_identity).to have_attributes(channel_id: "UC-channel-1", handle: "socialconnector")
      expect(connected_events("youtube")).to eq(1)
    end

    it "sends a seller back to the page the flow started from", parity: true do
      log_in(user)
      return_token = visit_connections(social_connect_origin: "onboarding")
      state = begin_flow("youtube", "social_connect_return=#{return_token}")
      stub_success

      callback("youtube", state)

      expect(response).to redirect_to("/dashboard")
      expect(user.reload.youtube_identity.channel_id).to eq("UC-channel-1")
    end

    it "refreshes the verification of a channel that was already connected", parity: true do
      create(:social_connect_verification, user:, platform: "youtube", uid: "UC-channel-1", handle: "old", follower_count: 10, last_verified_at: 3.days.ago, created_at: 2.weeks.ago, updated_at: 2.weeks.ago)
      create(:user_youtube_identity, user:, channel_id: "UC-channel-1", handle: "old", created_at: 2.weeks.ago, updated_at: 2.weeks.ago)
      log_in(user)
      state = begin_flow("youtube")
      stub_success

      callback("youtube", state)

      expect(SocialConnectVerification.where(user:, platform: "youtube").pluck(:uid, :handle, :follower_count)).to eq([["UC-channel-1", "socialconnector", 1234]])
      expect(user.reload.youtube_identity.handle).to eq("socialconnector")
    end

    it "supersedes the verification of another channel", parity: true do
      create(:social_connect_verification, user:, platform: "youtube", uid: "UC-channel-0", handle: "first", created_at: 2.weeks.ago, updated_at: 2.weeks.ago)
      create(:user_youtube_identity, user:, channel_id: "UC-channel-0", handle: "first", created_at: 2.weeks.ago, updated_at: 2.weeks.ago)
      log_in(user)
      state = begin_flow("youtube")
      stub_success

      callback("youtube", state)

      expect(SocialConnectVerification.where(user:, platform: "youtube").order(:id).pluck(:uid, :superseded_at).map { |uid, at| [uid, at.present?] }).to eq([["UC-channel-0", true], ["UC-channel-1", false]])
      expect(user.reload.youtube_identity.channel_id).to eq("UC-channel-1")
    end

    it "revives the superseded verification of a channel that is connected again", parity: true do
      create(:social_connect_verification, user:, platform: "youtube", uid: "UC-channel-1", handle: "before", superseded_at: 1.week.ago, created_at: 2.weeks.ago, updated_at: 2.weeks.ago)
      create(:social_connect_verification, user:, platform: "youtube", uid: "UC-channel-0", handle: "other", created_at: 2.weeks.ago, updated_at: 2.weeks.ago)
      log_in(user)
      state = begin_flow("youtube")
      stub_success

      callback("youtube", state)

      expect(SocialConnectVerification.where(user:, platform: "youtube").order(:id).pluck(:uid, :superseded_at).map { |uid, at| [uid, at.present?] }).to eq([["UC-channel-1", false], ["UC-channel-0", true]])
    end

    it "connects a channel that has no custom URL and no uploads", parity: true do
      log_in(user)
      state = begin_flow("youtube")
      stub_google_token
      stub_google_identity
      stub_channel(body: { items: [{ id: "UC-channel-1", statistics: { subscriberCount: "", videoCount: "0" } }] })

      callback("youtube", state)

      expect(response).to redirect_to("/settings/social_connections")
      expect(SocialConnectVerification.find_by!(user:, platform: "youtube")).to have_attributes(handle: nil, follower_count: nil, post_count: 0, last_posted_at: nil)
    end

    it "connects a channel whose uploads cannot be read", parity: true do
      log_in(user)
      state = begin_flow("youtube")
      stub_google_token
      stub_google_identity
      stub_channel
      stub_uploads(status: 403, body: { error: { code: 403 } })

      callback("youtube", state)

      expect(SocialConnectVerification.find_by!(user:, platform: "youtube").last_posted_at).to be_nil
    end

    it "tells a seller whose Google account has no channel", parity: true do
      log_in(user)
      state = begin_flow("youtube")
      stub_google_token
      stub_google_identity
      stub_channel(body: { items: [] })

      callback("youtube", state)

      expect(response).to redirect_to("/settings/social_connections")
      expect(flash[:alert]).to eq("Couldn't read a YouTube channel for that Google account.")
      expect(failed_events("youtube")).to eq(["no_channel"])
      expect(SocialConnectVerification.count).to eq(0)
    end

    it "tells a seller when the channel request fails", parity: true do
      log_in(user)
      state = begin_flow("youtube")
      stub_google_token
      stub_google_identity
      stub_channel(status: 500, body: { error: "backend" })

      callback("youtube", state)

      expect(failed_events("youtube")).to eq(["no_channel"])
    end

    it "ends a token request that Google refuses in the failure action", parity: true do
      log_in(user)
      state = begin_flow("youtube")
      stub_google_token(status: 400, body: { error: "invalid_grant", error_description: "Bad Request" })

      callback("youtube", state)

      expect(response).to redirect_to("/settings/social_connections")
      expect(flash[:alert]).to eq("Couldn't connect YouTube. Please try again.")
      expect(failed_events("youtube")).to eq(["invalid_credentials"])
    end

    it "ends a callback whose user info Google refuses in the failure action", parity: true do
      log_in(user)
      state = begin_flow("youtube")
      stub_google_token
      stub_google_identity(userinfo_status: 401)

      callback("youtube", state)

      expect(failed_events("youtube")).to eq(["invalid_credentials"])
    end

    it "ends a callback whose ID token was issued for another client in the failure action", parity: true do
      log_in(user)
      state = begin_flow("youtube")
      stub_google_token(id_token: id_token(aud: "another-client.apps.googleusercontent.com"))
      stub_google_identity

      callback("youtube", state)

      expect(response).to redirect_to("/settings/social_connections")
      expect(failed_events("youtube").size).to eq(1)
    end

    it "ends a callback whose ID token has expired in the failure action", parity: true do
      log_in(user)
      state = begin_flow("youtube")
      stub_google_token(id_token: id_token(exp: 946_684_800))
      stub_google_identity

      callback("youtube", state)

      expect(failed_events("youtube")).to eq(["signaturehasexpired"])
    end

    it "ends a callback whose answer carries no ID token in the failure action", parity: true do
      log_in(user)
      state = begin_flow("youtube")
      stub_google_token(body: { access_token: token, expires_in: 3599, token_type: "Bearer" })
      stub_google_identity

      callback("youtube", state)

      expect(failed_events("youtube")).to eq(["notenoughortoomanysegments"])
    end

    it "sends a visitor who is not signed in to the login page after the exchange", parity: true do
      Feature.activate(:youtube_connect)
      state = begin_flow("youtube")
      stub_success

      callback("youtube", state)

      expect(response).to redirect_to("/login")
      expect(flash[:alert]).to eq("You need to be logged in to link your YouTube account.")
      expect(SocialConnectVerification.count).to eq(0)
    end

    it "hands a callback that names a redirect URI of its own to Rails", parity: true do
      log_in(user)
      state = begin_flow("youtube")
      stub_success

      get "/users/auth/youtube/callback", params: { code: "code-1", state:, redirect_uri: "https://example.com/callback" }

      expect(response).to have_http_status(:found)
    end

    it "hands a callback with an empty code to Rails", parity: true do
      log_in(user)
      state = begin_flow("youtube")
      stub_success

      callback("youtube", state, code: "")

      expect(response).to have_http_status(:found)
    end
  end

  describe "instagram" do
    let(:token) { "instagram-access-token" }

    def stub_instagram_token(status: 200, body: { data: [{ access_token: token, user_id: "17841400000000001", permissions: "instagram_business_basic" }] })
      stub_request(:post, "https://api.instagram.com/oauth/access_token").to_return(status:, headers: json, body: body.to_json)
    end

    def stub_profile(status: 200, body: { data: [{ user_id: "17841400000000099", username: "socialconnector", followers_count: 4321, media_count: 77 }] })
      stub_request(:get, "https://graph.instagram.com/#{INSTAGRAM_API_VERSION}/me").with(query: { fields: "user_id,username,followers_count,media_count" }, headers: { "Authorization" => "Bearer #{token}" })
        .to_return(status:, headers: json, body: body.to_json)
    end

    def stub_media(status: 200, body: { data: [{ timestamp: "2026-04-02T12:00:00+0000" }] }, user_id: "17841400000000099")
      stub_request(:get, "https://graph.instagram.com/#{INSTAGRAM_API_VERSION}/#{user_id}/media").with(query: { fields: "timestamp", limit: 1 }, headers: { "Authorization" => "Bearer #{token}" })
        .to_return(status:, headers: json, body: body.to_json)
    end

    before { Feature.activate_user(:instagram_connect, user) }

    it "connects a seller's professional account", parity: true do
      log_in(user)
      state = begin_flow("instagram")
      stub_instagram_token
      stub_profile
      stub_media

      callback("instagram", state)

      expect(response).to redirect_to("/settings/social_connections")
      expect(SocialConnectVerification.find_by!(user:, platform: "instagram")).to have_attributes(uid: "17841400000000001", handle: "socialconnector", follower_count: 4321, post_count: 77)
      expect(user.reload.instagram_identity).to have_attributes(instagram_user_id: "17841400000000001", handle: "socialconnector")
      expect(connected_events("instagram")).to eq(1)
    end

    it "connects an account the token answer and the profile give flat", parity: true do
      log_in(user)
      state = begin_flow("instagram")
      stub_instagram_token(body: { access_token: token, user_id: 17_841_400_000_000_001 })
      stub_profile(body: { user_id: "17841400000000099", username: "flat", followers_count: "12", media_count: "3" })
      stub_media(body: { data: [] })

      callback("instagram", state)

      expect(SocialConnectVerification.find_by!(user:, platform: "instagram")).to have_attributes(uid: "17841400000000001", handle: "flat", follower_count: 12, post_count: 3, last_posted_at: nil)
    end

    it "supersedes the verification of another account", parity: true do
      create(:social_connect_verification, user:, platform: "instagram", uid: "17841400000000000", handle: "first", created_at: 2.weeks.ago, updated_at: 2.weeks.ago)
      create(:user_instagram_identity, user:, instagram_user_id: "17841400000000000", handle: "first", created_at: 2.weeks.ago, updated_at: 2.weeks.ago)
      log_in(user)
      state = begin_flow("instagram")
      stub_instagram_token
      stub_profile
      stub_media

      callback("instagram", state)

      expect(SocialConnectVerification.where(user:, platform: "instagram").order(:id).pluck(:uid, :superseded_at).map { |uid, at| [uid, at.present?] }).to eq([["17841400000000000", true], ["17841400000000001", false]])
      expect(user.reload.instagram_identity.instagram_user_id).to eq("17841400000000001")
    end

    it "tells a seller whose account has no profile", parity: true do
      log_in(user)
      state = begin_flow("instagram")
      stub_instagram_token
      stub_profile(body: {})

      callback("instagram", state)

      expect(flash[:alert]).to eq("Couldn't read an Instagram professional account.")
      expect(failed_events("instagram")).to eq(["no_profile"])
    end

    it "tells a seller when the media request fails with an error class", parity: true do
      log_in(user)
      state = begin_flow("instagram")
      stub_instagram_token
      stub_profile
      stub_request(:get, "https://graph.instagram.com/#{INSTAGRAM_API_VERSION}/17841400000000099/media").with(query: { fields: "timestamp", limit: 1 })
        .to_return(status: 200, headers: { "Content-Type" => "text/plain" }, body: "unavailable")

      callback("instagram", state)

      expect(flash[:alert]).to eq("Couldn't save your Instagram connection. Please try again.")
      expect(failed_events("instagram")).to eq(["NoMethodError"])
    end

    it "ends a token request that Instagram refuses in the failure action", parity: true do
      log_in(user)
      state = begin_flow("instagram")
      stub_instagram_token(status: 400, body: { error_type: "OAuthException", code: 400, error_message: "Invalid authorization code" })

      callback("instagram", state)

      expect(flash[:alert]).to eq("Couldn't connect Instagram. Please try again.")
      expect(failed_events("instagram")).to eq(["invalid_credentials"])
    end

    it "sends a visitor who is not signed in to the login page after the exchange", parity: true do
      Feature.activate(:instagram_connect)
      state = begin_flow("instagram")
      stub_instagram_token

      callback("instagram", state)

      expect(response).to redirect_to("/login")
      expect(flash[:alert]).to eq("You need to be logged in to link your Instagram account.")
    end
  end

  describe "tiktok" do
    let(:token) { "tiktok-access-token" }
    let(:fields) { "open_id,union_id,avatar_url,display_name,username,profile_web_link,follower_count,video_count" }

    def stub_tiktok_token(status: 200, body: { access_token: token, expires_in: 86_400, open_id: "tiktok-open-1", refresh_token: "tiktok-refresh", scope: "user.info.basic", token_type: "Bearer" })
      stub_request(:post, "https://open.tiktokapis.com/v2/oauth/token/").to_return(status:, headers: json, body: body.to_json)
    end

    def stub_user_info(status: 200, body: { data: { user: { open_id: "tiktok-open-9", display_name: "Social Connector", username: "socialconnector", follower_count: 99, video_count: 7 } }, error: { code: "ok", message: "" } })
      stub_request(:get, "https://open.tiktokapis.com/v2/user/info/").with(query: { fields: }, headers: { "Authorization" => "Bearer #{token}" })
        .to_return(status:, headers: json, body: body.to_json)
    end

    before { Feature.activate_user(:tiktok_connect, user) }

    it "connects a seller's account", parity: true do
      log_in(user)
      state = begin_flow("tiktok")
      stub_tiktok_token
      stub_user_info

      callback("tiktok", state)

      expect(response).to redirect_to("/settings/social_connections")
      expect(SocialConnectVerification.find_by!(user:, platform: "tiktok")).to have_attributes(uid: "tiktok-open-9", handle: "socialconnector", follower_count: 99, post_count: 7)
      expect(user.reload.tiktok_identity).to have_attributes(tiktok_open_id: "tiktok-open-9", handle: "socialconnector")
      expect(connected_events("tiktok")).to eq(1)
    end

    it "takes the handle from the profile link and keeps counts that are not numbers out of the verification", parity: true do
      log_in(user)
      state = begin_flow("tiktok")
      stub_tiktok_token
      stub_user_info(body: { data: { user: { open_id: "tiktok-open-9", display_name: "Display", profile_web_link: "https://www.tiktok.com/@linked?lang=en", follower_count: "many", video_count: " " } }, error: { code: "ok" } })

      callback("tiktok", state)

      expect(SocialConnectVerification.find_by!(user:, platform: "tiktok")).to have_attributes(handle: "linked", follower_count: nil, post_count: nil)
    end

    it "supersedes the verification of another account", parity: true do
      create(:social_connect_verification, user:, platform: "tiktok", uid: "tiktok-open-0", handle: "first", created_at: 2.weeks.ago, updated_at: 2.weeks.ago)
      create(:user_tiktok_identity, user:, tiktok_open_id: "tiktok-open-0", handle: "first", created_at: 2.weeks.ago, updated_at: 2.weeks.ago)
      log_in(user)
      state = begin_flow("tiktok")
      stub_tiktok_token
      stub_user_info

      callback("tiktok", state)

      expect(SocialConnectVerification.where(user:, platform: "tiktok").order(:id).pluck(:uid, :superseded_at).map { |uid, at| [uid, at.present?] }).to eq([["tiktok-open-0", true], ["tiktok-open-9", false]])
    end

    it "tells a seller when TikTok answers with an error code", parity: true do
      log_in(user)
      state = begin_flow("tiktok")
      stub_tiktok_token
      stub_user_info(body: { data: {}, error: { code: "access_token_invalid", message: "expired" } })

      callback("tiktok", state)

      expect(flash[:alert]).to eq("Couldn't read a TikTok account.")
      expect(failed_events("tiktok")).to eq(["no_profile"])
    end

    it "ends a token request that TikTok refuses in the failure action", parity: true do
      log_in(user)
      state = begin_flow("tiktok")
      stub_tiktok_token(status: 400, body: { error: "invalid_grant", error_description: "Authorization code is expired" })

      callback("tiktok", state)

      expect(flash[:alert]).to eq("Couldn't connect TikTok. Please try again.")
      expect(failed_events("tiktok")).to eq(["invalid_credentials"])
    end

    it "sends a visitor who is not signed in to the login page after the exchange", parity: true do
      Feature.activate(:tiktok_connect)
      state = begin_flow("tiktok")
      stub_tiktok_token

      callback("tiktok", state)

      expect(response).to redirect_to("/login")
      expect(flash[:alert]).to eq("You need to be logged in to link your TikTok account.")
    end
  end
end
