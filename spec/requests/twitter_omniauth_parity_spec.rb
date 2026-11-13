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
  PNG_7X5 = "iVBORw0KGgoAAAANSUhEUgAAAAcAAAAFAQMAAACzVGSbAAAABGdBTUEAALGPC/xhBQAAACBjSFJNAAB6JgAAgIQAAPoAAACA6AAAdTAAAOpgAAA6mAAAF3CculE8AAAABlBMVEX/AAD///9BHTQRAAAAAWJLR0QB/wIt3gAAAAd0SU1FB+oLDAUCF/EjOUMAAAALSURBVAjXY2CAAQAACgAB5/ja+gAAACV0RVh0ZGF0ZTpjcmVhdGUAMjAyNi0xMS0xMlQwNTowMjoyMyswMDowMKb5F4IAAAAldEVYdGRhdGU6bW9kaWZ5ADIwMjYtMTEtMTJUMDU6MDI6MjMrMDA6MDDXpK8+AAAAAElFTkSuQmCC"
  JPEG_9X4 = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAAEAAkDAREAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFgEBAQEAAAAAAAAAAAAAAAAAAAYJ/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8Anu1TQ4D/2Q=="
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
    $twitter.bearer_token = nil
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

  # Devise routes the callback to the same action for a form POST, under `protect_from_forgery`: a valid authenticity token runs the same
  # action; without one Rails runs it with a null session.
  describe "POST /users/auth/twitter/callback" do
    before { attach_avatar(user) }

    def post_callback(token: csrf_token, **params)
      post "/users/auth/twitter/callback", params: { authenticity_token: token, oauth_token: "request-token-1", oauth_verifier: "verifier-1" }.merge(params)
    end

    it "links the account of a signed-in seller", parity: true do
      log_in(user)
      begin_flow("state=link_twitter_account")
      stub_access_token
      stub_credentials
      user.update_columns(updated_at: 1.hour.ago)

      # The replay holds its clock at the instant the other examples of this file were recorded at (PARITY_NOW), which the profile dates are measured from.
      travel_to(Time.utc(2026, 5, 1, 8, 30) + 4677.hours)
      post_callback

      expect(response).to redirect_to("/settings/social_connections")
      expect(user.reload).to have_attributes(twitter_user_id: "4242424242", twitter_oauth_token: "access-token-1")
      expect(events("connected")).to eq([["omniauth", nil]])
    end

    it "sends a login callback to the sign-in page when Twitter refuses the request token", parity: true do
      begin_flow
      stub_access_token(status: 401, body: "Invalid / expired Token")

      post_callback

      expect(response).to redirect_to("/users/sign_in")
      expect(flash[:alert]).to eq("Could not authenticate you from Twitter because \"Invalid credentials\".")
    end

    it "sends a visitor whose session has no request token to the login page", parity: true do
      post_callback

      expect(response).to redirect_to("/users/sign_in")
      expect(flash[:alert]).to eq("Could not authenticate you from Twitter because \"Session expired\".")
    end

    it "hands a callback without an authenticity token to Rails", parity: true do
      log_in(user)
      begin_flow("state=link_twitter_account")
      stub_access_token
      stub_credentials

      post "/users/auth/twitter/callback", params: { oauth_token: "request-token-1", oauth_verifier: "verifier-1" }

      expect(response).to have_http_status(:found)
    end

    describe "a login or signup" do
      def login_post_callback
        # The seed row is written a moment before the request: a save in the same second would not show as a change.
        User.where(twitter_user_id: "4242424242").update_all(updated_at: 1.hour.ago)
        begin_flow
        stub_access_token
        stub_credentials
        # The replay holds its clock at PARITY_NOW, which the profile dates are measured from.
        travel_to(Time.utc(2026, 5, 1, 8, 30) + 4677.hours)
        post_callback
      end

      it "signs a new Twitter visitor up and asks for an email address", parity: true do
        login_post_callback

        expect(response).to redirect_to("/settings")
        expect(flash[:warning]).to eq("Please enter an email address!")
        expect(User.find_by!(twitter_user_id: "4242424242")).to have_attributes(provider: "twitter", twitter_handle: "twitterconnector", email: nil)
      end

      it "signs in a returning Twitter user who has an email address", parity: true do
        returning = create(:user, name: "Returning Twitter", email: "returning.twitter@example.com", twitter_user_id: "4242424242", provider: "twitter")

        login_post_callback

        expect(response).to redirect_to("/two-factor?next=/dashboard")
        expect(returning.reload).to have_attributes(twitter_oauth_token: "access-token-1", twitter_handle: "twitterconnector")
      end
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
      # The replay holds its clock at PARITY_NOW; the whole flow runs at that instant so the return token it mints is still fresh at the callback.
      travel_to(Time.utc(2026, 5, 1, 8, 30) + 4677.hours)
      user.update_columns(updated_at: 1.hour.ago)
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

    it "sends a login callback to the sign-in page when Twitter refuses the request token", parity: true do
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

    it "sends a login callback to the sign-in page when the access token call fails", parity: true do
      begin_flow
      stub_access_token(status: 502, body: "Bad gateway")

      callback

      expect(response).to redirect_to("/users/sign_in")
      expect(flash[:alert]).to eq("Could not authenticate you from Twitter because \"Service unavailable\".")
    end

    describe "a login or signup" do
      let(:twitter_user) { create(:user, name: "Returning Twitter", email: "returning.twitter@example.com", twitter_user_id: "4242424242", provider: "twitter") }

      def login_callback
        # The seed row is written a moment before the request: a save in the same second would not show as a change.
        User.where(twitter_user_id: "4242424242").update_all(updated_at: 1.hour.ago)
        begin_flow
        stub_access_token
        stub_credentials
        callback
      end

      it "signs a new Twitter visitor up and asks for an email address", parity: true do
        login_callback

        expect(response).to redirect_to("/settings")
        expect(flash[:warning]).to eq("Please enter an email address!")
        created = User.find_by!(twitter_user_id: "4242424242")
        expect(created).to have_attributes(provider: "twitter", twitter_handle: "twitterconnector", username: "twitterconnector", name: "Twitter Connector",
                                           twitter_oauth_token: "access-token-1", twitter_oauth_secret: "access-secret-1", email: nil)
        expect(created.confirmed_at).to be_present
        expect(SignupEvent.where(user_id: created.id).count).to eq(1)
        expect(SocialConnectVerification.find_by!(user: created, platform: "twitter").uid).to eq("4242424242")
        expect(Event.where(user_id: created.id, event_name: "social_connect_connected")).to be_empty
        expect(a_request(:get, "#{twitter}/1.1/users/show.json").with(query: { user_id: 4_242_424_242 })).to have_been_made
      end

      it "signs in a returning Twitter user who has an email address", parity: true do
        twitter_user

        login_callback

        expect(response).to redirect_to("/two-factor?next=/dashboard")
        expect(twitter_user.reload).to have_attributes(twitter_oauth_token: "access-token-1", twitter_oauth_secret: "access-secret-1", twitter_handle: "twitterconnector")
        expect(SignupEvent.count).to eq(0)
      end

      it "asks a returning Twitter user with two-factor authentication for the code", parity: true do
        twitter_user.update!(two_factor_authentication_enabled: true)

        login_callback

        expect(response).to redirect_to("/two-factor?next=/dashboard")
        expect(session[:verify_two_factor_auth_for]).to eq(twitter_user.id)
      end

      it "refuses to sign a team member in with Twitter", parity: true do
        twitter_user.update!(is_team_member: true)

        login_callback

        expect(response).to redirect_to("/login")
        expect(flash[:alert]).to eq("You're an admin, you can't login with Twitter.")
      end

      it "refuses a deleted account", parity: true do
        twitter_user.update_columns(deleted_at: Time.current)

        login_callback

        expect(response).to redirect_to("/login")
        expect(flash[:alert]).to eq(User::DELETED_ACCOUNT_LOGIN_ERROR)
      end

      it "signs a user in who has only an address to confirm", parity: true do
        twitter_user.update_columns(email: nil, unconfirmed_email: "pending.twitter@example.com")

        login_callback

        expect(response).to redirect_to("/settings")
        expect(flash[:warning]).to eq("Please confirm your email address")
        expect(SignupEvent.count).to eq(0)
      end

      it "hands a login callback of a visitor who is signed in to Rails", parity: true do
        log_in(user)
        login_callback

        expect(response).to have_http_status(:found)
      end
    end

    it "hands a callback of the async link to Rails", parity: true do
      log_in(user)
      begin_flow("state=async_link_twitter_account")
      stub_access_token
      stub_credentials

      callback

      expect(response).to have_http_status(:ok)
    end

    describe "a seller with no avatar" do
      let(:photo_url) { "http://pbs.twimg.com/profile_images/4242424242/photo" }
      let(:png) { Base64.decode64(PNG_7X5) }

      before do
        ActiveStorage::Attachment.where(record_type: "User", record_id: user.id, name: "avatar").delete_all
        # `avatar_url` renders the 400x400 variant, whose bytes are ImageMagick's re-encoding of the picture: the port leaves it to the first render
        # that needs it, so the recording does not hold the variant rows and files either.
        allow_any_instance_of(User).to receive(:avatar_url).and_return("avatar-url")
        link!
      end

      def stub_profile(url: "#{photo_url}_normal.png")
        stub_request(:get, %r{api\.twitter\.com/1\.1/users/show}).to_return(status: 200, headers: json, body: { id: 4_242_424_242, profile_image_url_https: url.sub("http:", "https:") }.to_json)
      end

      def stub_photo(path: "#{photo_url}_400x400.png", status: 200, type: "image/png", body: png)
        stub_request(:get, path).to_return(status:, headers: { "Content-Type" => type }, body:)
      end

      it "downloads the profile picture at its larger size and attaches it", parity: true do
        stub_profile
        stub_photo

        callback

        expect(response).to redirect_to("/settings/social_connections")
        blob = user.reload.avatar.blob
        expect(blob).to have_attributes(filename: ActiveStorage::Filename.new("photo_400x400.png"), content_type: "image/png", byte_size: png.bytesize,
                                        checksum: Digest::MD5.base64digest(png), service_name: "test")
        expect(blob.metadata).to include("identified" => true, "analyzed" => true, "width" => 7, "height" => 5)
        expect(ActiveStorage::Blob.service.exist?(blob.key)).to be(true)
        # The test adapter keeps the ActiveJob that production hands to Sidekiq; the replay checks Node pushed the same one.
        analyze = ActiveJob::Base.queue_adapter.enqueued_jobs.select { |job| job["job_class"] == "ActiveStorage::AnalyzeJob" || job[:job] == ActiveStorage::AnalyzeJob }
        expect(analyze.map { |job| [job[:queue], job[:args]] }).to eq([["default", [{ "_aj_globalid" => "gid://gumroad/ActiveStorage::Blob/#{blob.id}" }]]])
      end

      it "attaches a jpeg picture", parity: true do
        stub_profile(url: "#{photo_url}_normal.jpg")
        stub_photo(path: "#{photo_url}_400x400.jpg", type: "image/jpeg", body: Base64.decode64(JPEG_9X4))

        callback

        expect(user.reload.avatar.blob).to have_attributes(content_type: "image/jpeg")
        expect(user.avatar.blob.metadata).to include("width" => 9, "height" => 4)
      end

      it "leaves the seller without a picture when the profile cannot be read", parity: true do
        callback

        expect(response).to redirect_to("/settings/social_connections")
        expect(user.reload.avatar).not_to be_attached
      end

      it "leaves the seller without a picture when the download is refused", parity: true do
        stub_profile
        stub_photo(status: 404, body: "")

        callback

        expect(response).to redirect_to("/settings/social_connections")
        expect(user.reload.avatar).not_to be_attached
      end
    end
  end
end
