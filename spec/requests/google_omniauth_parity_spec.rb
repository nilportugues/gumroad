# frozen_string_literal: true

require "spec_helper"

# The Google login and signup callback (User::OmniauthCallbacksController#google_oauth2 over User.find_or_create_for_google_oauth2), recorded for
# the Next.js port (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/google-omniauth.replay.test.ts. Every provider answer is a WebMock
# stub (the token exchange, tokeninfo, userinfo, the picture host); the fixture keeps each outbound call in order and the replay answers them from
# a stand-in that holds Node to the same calls. The OmniAuth middleware runs for real (test_mode off). An example named "hands ..." is one Node
# leaves to Rails before Google's single-use code is spent.
describe "Google OAuth2 login and signup", type: :request do
  include Parity::AudienceSignedIn

  let(:png_7x5) { "iVBORw0KGgoAAAANSUhEUgAAAAcAAAAFAQMAAACzVGSbAAAABGdBTUEAALGPC/xhBQAAACBjSFJNAAB6JgAAgIQAAPoAAACA6AAAdTAAAOpgAAA6mAAAF3CculE8AAAABlBMVEX/AAD///9BHTQRAAAAAWJLR0QB/wIt3gAAAAd0SU1FB+oLDAUCF/EjOUMAAAALSURBVAjXY2CAAQAACgAB5/ja+gAAACV0RVh0ZGF0ZTpjcmVhdGUAMjAyNi0xMS0xMlQwNTowMjoyMyswMDowMKb5F4IAAAAldEVYdGRhdGU6bW9kaWZ5ADIwMjYtMTEtMTJUMDU6MDI6MjMrMDA6MDDXpK8+AAAAAElFTkSuQmCC" }
  let(:jpeg_9x4) { "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAAEAAkDAREAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFgEBAQEAAAAAAAAAAAAAAAAAAAYJ/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8Anu1TQ4D/2Q==" }
  let(:json) { { "Content-Type" => "application/json; charset=utf-8" } }
  let(:google_sub) { "google-sub-4242" }
  let(:access_token) { "google-access-token" }
  let(:photo) { "https://lh3.googleusercontent.com/a/photo-id" }
  let(:user) { create(:named_seller, name: "Google Visitor", email: "google.user@example.com", google_uid: google_sub, provider: "google_oauth2") }

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
    # `avatar_url` renders the 400x400 variant, whose bytes are ImageMagick's re-encoding of the picture: the port leaves it to the first render
    # that needs it, so the recording does not hold the variant rows and files either.
    allow_any_instance_of(User).to receive(:avatar_url).and_return("avatar-url")
  end

  def begin_flow(query = nil, **params)
    post ["/users/auth/google_oauth2", query].compact.join("?"), params: { authenticity_token: csrf_token }.merge(params)
    expect(response).to have_http_status(:found)
    Rack::Utils.parse_query(URI(response.location).query)["state"]
  end

  def id_token(aud: GOOGLE_CLIENT_ID, iss: "https://accounts.google.com", exp: 4_102_444_800)
    JWT.encode({ iss:, aud:, sub: google_sub, exp: }, "unverified-key", "HS256")
  end

  def userinfo(**overrides)
    { sub: google_sub, name: "Google Person", email: "google.user@example.com", email_verified: true }.merge(overrides).compact
  end

  def stub_google(userinfo: self.userinfo, token_status: 200, token_body: nil, id_token: self.id_token, userinfo_status: 200)
    token_body ||= { access_token:, expires_in: 3599, scope: "email profile openid", token_type: "Bearer", id_token: }
    stub_request(:post, "https://oauth2.googleapis.com/token").to_return(status: token_status, headers: json, body: token_body.to_json)
    stub_request(:get, "https://www.googleapis.com/oauth2/v3/tokeninfo").with(query: { access_token: })
      .to_return(status: 200, headers: json, body: { scope: "email profile openid" }.to_json)
    stub_request(:get, "https://www.googleapis.com/oauth2/v3/userinfo").with(headers: { "Authorization" => "Bearer #{access_token}" })
      .to_return(status: userinfo_status, headers: json, body: userinfo.to_json)
  end

  def stub_photo(path: "#{photo}=s400-c", status: 200, type: "image/png", body: Base64.decode64(png_7x5))
    stub_request(:get, path).to_return(status:, headers: { "Content-Type" => type }, body:)
  end

  def callback(state, **params)
    get "/users/auth/google_oauth2/callback", params: { code: "google-code-1", state: }.merge(params)
  end

  def sign_in_with_google(query = nil, **callback_params)
    state = begin_flow(query)
    callback(state, **callback_params)
  end

  def aged(record) = record.tap { |row| row.update_columns(updated_at: 1.hour.ago) }

  def closed_account(**attrs)
    create(:user, deleted_at: Time.current, google_uid: google_sub, provider: "google_oauth2", **attrs).tap { |row| row.update_columns(updated_at: 1.hour.ago) }
  end

  describe "a user who signed in with Google before" do
    before { aged(user) }

    it "signs the user in", parity: true do
      stub_google

      sign_in_with_google

      expect(response).to redirect_to("/dashboard")
      expect(user.reload.sign_in_count).to eq(1)
      expect(a_request(:post, "https://oauth2.googleapis.com/token").with { |request| request.body.include?("code=google-code-1") && request.body.include?("grant_type=authorization_code") }).to have_been_made
    end

    it "sends the user back to the page the sign-in started from", parity: true do
      stub_google

      sign_in_with_google("referer=/library")

      expect(response).to redirect_to("/library")
    end

    it "keeps the name and the address the user already has", parity: true do
      stub_google(userinfo: userinfo(name: "A New Name", email: "changed.at.google@example.com"))

      sign_in_with_google

      expect(user.reload).to have_attributes(name: "Google Visitor", email: "google.user@example.com")
    end

    it "gives a user with no name the one Google reports, without the characters mail cannot carry", parity: true do
      user.update_columns(name: nil)
      stub_google(userinfo: userinfo(name: "Google: Person"))

      sign_in_with_google

      expect(user.reload.name).to eq("Google Person")
    end

    it "confirms an address the user changed only when it is not waiting for its link", parity: true do
      user.update_columns(confirmed_at: nil, confirmation_token: "pending-token", unconfirmed_email: nil)
      stub_google

      sign_in_with_google

      expect(user.reload.confirmed_at).to be_present
    end

    it "leaves a pending address change waiting for its link", parity: true do
      user.update_columns(unconfirmed_email: "changed@example.com", confirmation_token: "pending-token")
      stub_google

      sign_in_with_google

      expect(response).to redirect_to("/dashboard")
      expect(user.reload.unconfirmed_email).to eq("changed@example.com")
    end

    it "does not let in a deleted account", parity: true do
      user.update_columns(deleted_at: Time.current)
      stub_google

      sign_in_with_google

      expect(response).to redirect_to("/login")
      expect(flash[:alert]).to eq(User::DELETED_ACCOUNT_LOGIN_ERROR)
    end

    it "prefers the live account when a deleted row holds the same uid", parity: true do
      older = create(:user, deleted_at: Time.current, google_uid: google_sub, provider: "google_oauth2", email: "older.row@example.com")
      older.update_columns(updated_at: 1.hour.ago)
      stub_google

      sign_in_with_google

      expect(response).to redirect_to("/dashboard")
      expect(user.reload.sign_in_count).to eq(1)
    end
  end

  describe "an account closed by support" do
    let!(:closed) { closed_account(email: "freed.1@deleted.invalid") }

    it "signs in the live account that holds the Google address", parity: true do
      live = aged(create(:user, email: "google.user@example.com", name: "Live Owner"))
      stub_google

      sign_in_with_google

      expect(response).to redirect_to("/dashboard")
      expect(live.reload).to have_attributes(sign_in_count: 1, google_uid: google_sub)
    end

    it "refuses the closed account when no live account holds the Google address", parity: true do
      stub_google

      sign_in_with_google

      expect(response).to redirect_to("/login")
      expect(flash[:alert]).to eq(User::DELETED_ACCOUNT_LOGIN_ERROR)
      expect(User.where(email: "google.user@example.com")).to be_empty
    end

    it "refuses the closed account when Google has not verified the address", parity: true do
      aged(create(:user, email: "google.user@example.com"))
      stub_google(userinfo: userinfo(email_verified: false))

      sign_in_with_google

      expect(response).to redirect_to("/login")
      expect(flash[:alert]).to eq(User::DELETED_ACCOUNT_LOGIN_ERROR)
    end
  end

  describe "a Google user with no account yet" do
    it "creates an account with a random password and signs in", parity: true do
      stub_google

      sign_in_with_google

      created = User.find_by!(google_uid: google_sub)
      expect(response).to redirect_to("/dashboard")
      expect(created).to have_attributes(provider: "google_oauth2", email: "google.user@example.com", name: "Google Person")
      expect(created.confirmed_at).to be_present
      expect(created.sign_in_count).to eq(1)
    end

    it "creates an account with no address when Google reports none", parity: true do
      stub_google(userinfo: userinfo(email: nil, email_verified: nil))

      sign_in_with_google

      expect(response).to redirect_to("/dashboard")
      expect(User.find_by!(google_uid: google_sub).email).to be_blank
    end

    it "does not create an account for an address Google has not verified", parity: true do
      stub_google(userinfo: userinfo(email_verified: false))

      sign_in_with_google

      expect(response).to redirect_to("/signup")
      expect(flash[:alert]).to eq("Sorry, something went wrong. Please try again.")
      expect(User.where(google_uid: google_sub)).to be_empty
    end

    it "does not create an account for a disposable address", parity: true do
      stub_google(userinfo: userinfo(email: "visitor@mailinator.com"))

      sign_in_with_google

      expect(response).to redirect_to("/signup")
      expect(flash[:alert]).to eq("Sorry, something went wrong. Please try again.")
      expect(User.where(google_uid: google_sub)).to be_empty
    end

    it "does not create an account from an answer with no subject", parity: true do
      stub_google(userinfo: userinfo(sub: nil))

      sign_in_with_google

      expect(response).to redirect_to("/signup")
      expect(flash[:alert]).to eq("Sorry, something went wrong. Please try again.")
    end

    it "links a confirmed password account that has the same address and replaces its password", parity: true do
      password_user = aged(create(:user, email: "google.user@example.com", name: "Password Owner"))
      old_digest = password_user.encrypted_password
      stub_google

      sign_in_with_google

      expect(response).to redirect_to("/dashboard")
      expect(password_user.reload.encrypted_password).not_to eq(old_digest)
      expect(password_user).to have_attributes(google_uid: google_sub, name: "Password Owner")
      expect(password_user.last_active_sessions_invalidated_at).to be_present
    end

    it "links an account that signed up with another provider without touching its password", parity: true do
      other = aged(create(:user, email: "google.user@example.com", provider: "twitter"))
      old_digest = other.encrypted_password
      stub_google

      sign_in_with_google

      expect(response).to redirect_to("/dashboard")
      expect(other.reload.encrypted_password).to eq(old_digest)
      expect(other.google_uid).to eq(google_sub)
      expect(other.last_active_sessions_invalidated_at).to be_nil
    end

    it "adopts an unconfirmed password account and confirms it", parity: true do
      unconfirmed = create(:unconfirmed_user, name: "Password Owner", email: "google.user@example.com", password: "signup-password-1")
      unconfirmed.update_columns(confirmation_token: "pending-token", unconfirmed_email: "other@example.com", updated_at: 1.hour.ago)
      stub_google

      sign_in_with_google

      expect(response).to redirect_to("/dashboard")
      expect(unconfirmed.reload).to have_attributes(unconfirmed_email: nil, google_uid: google_sub)
      expect(unconfirmed.confirmed_at).to be_present
    end
  end

  describe "guest purchases of the address of a new account" do
    def guest_purchase(**attrs)
      build(:purchase, email: "google.user@example.com", purchaser: nil, purchase_state: "successful", **attrs).tap do |purchase|
        purchase.save!(validate: false)
        purchase.update_columns(updated_at: 1.hour.ago)
      end
    end

    let(:created) { User.find_by!(google_uid: google_sub) }

    before { stub_google }

    it "attaches the guest purchases of the address to the account", parity: true do
      older = guest_purchase
      newer = guest_purchase
      other = guest_purchase(email: "someone.else@example.com")
      claimed = guest_purchase(purchaser: create(:user))

      sign_in_with_google

      expect(response).to redirect_to("/library")
      expect([older, newer].map { _1.reload.purchaser_id }).to eq([created.id, created.id])
      expect(other.reload.purchaser_id).to be_nil
      expect(claimed.reload.purchaser_id).not_to eq(created.id)
    end

    it "leaves a reassignment-locked guest purchase with no account", parity: true do
      locked = guest_purchase(is_reassignment_locked: true)
      open = guest_purchase

      sign_in_with_google

      expect(locked.reload.purchaser_id).to be_nil
      expect(open.reload.purchaser_id).to eq(created.id)
    end

    it "attaches a guest bundle purchase and the unclaimed purchases of its products whose address matches", parity: true do
      product = create(:product)
      bundle = guest_purchase(is_bundle_purchase: true, link: product)
      member = guest_purchase(link: product)
      differing = guest_purchase(email: "Someone.Else@example.com", link: product)
      uppercase = guest_purchase(email: "GOOGLE.USER@example.com", link: product)
      locked = guest_purchase(is_reassignment_locked: true, link: product)
      failed = guest_purchase(purchase_state: "failed", link: product)
      claimed = guest_purchase(purchaser: create(:user), link: product)
      [member, differing, uppercase, locked, failed, claimed].each { |row| BundleProductPurchase.create!(bundle_purchase: bundle, product_purchase: row) }

      sign_in_with_google

      expect(bundle.reload.purchaser_id).to eq(created.id)
      expect([member, uppercase, failed].map { _1.reload.purchaser_id }).to eq([created.id, created.id, created.id])
      expect([differing, locked].map { _1.reload.purchaser_id }).to eq([nil, nil])
      expect(claimed.reload.purchaser_id).not_to eq(created.id)
    end

    it "attaches the unclaimed purchases of a bundle bought after its products to the account", parity: true do
      product = create(:product)
      member = guest_purchase(link: product)
      other_member = guest_purchase(email: "Someone.Else@example.com", link: product)
      bundle = guest_purchase(is_bundle_purchase: true, link: product)
      [member, other_member].each { |row| BundleProductPurchase.create!(bundle_purchase: bundle, product_purchase: row) }

      sign_in_with_google

      expect([bundle, member].map { _1.reload.purchaser_id }).to eq([created.id, created.id])
      expect(other_member.reload.purchaser_id).to be_nil
    end

    it "attaches a guest preorder purchase and its preorder", parity: true do
      preorder = create(:preorder)
      purchase = guest_purchase
      purchase.update_columns(preorder_id: preorder.id)

      sign_in_with_google

      expect(purchase.reload.purchaser_id).to eq(created.id)
      expect(preorder.reload.purchaser_id).to eq(created.id)
    end

    it "attaches a guest subscription purchase and its subscription", parity: true do
      subscription = create(:subscription, user: nil)
      purchase = guest_purchase
      purchase.update_columns(subscription_id: subscription.id)

      sign_in_with_google

      expect(purchase.reload.purchaser_id).to eq(created.id)
      expect(subscription.reload.user_id).to eq(created.id)
    end

    it "leaves the subscription of a gift sender's purchase with its owner", parity: true do
      subscription = create(:subscription, user: nil)
      purchase = guest_purchase(is_gift_sender_purchase: true)
      purchase.update_columns(subscription_id: subscription.id)

      sign_in_with_google

      expect(purchase.reload.purchaser_id).to eq(created.id)
      expect(subscription.reload.user_id).to be_nil
    end
  end

  describe "the picture of the account" do
    let(:avatar) { -> { User.find_by!(google_uid: google_sub).avatar } }
    let(:analyze_jobs) do
      ActiveJob::Base.queue_adapter.enqueued_jobs.select { |job| job["job_class"] == "ActiveStorage::AnalyzeJob" || job[:job] == ActiveStorage::AnalyzeJob }
    end

    def expect_attached(content_type: "image/png", width: nil, height: nil, filename: nil)
      blob = avatar.call.blob
      expect(blob).to have_attributes(content_type:, service_name: "test")
      expect(blob.filename.to_s).to eq(filename) if filename
      expect(blob.metadata).to include("width" => width, "height" => height) if width
      expect(ActiveStorage::Blob.service.exist?(blob.key)).to be(true)
      expect(analyze_jobs.map { |job| [job[:queue], job[:args]] }).to eq([["default", [{ "_aj_globalid" => "gid://gumroad/ActiveStorage::Blob/#{blob.id}" }]]])
    end

    it "is downloaded at its larger size for a new account", parity: true do
      stub_google(userinfo: userinfo(picture: "#{photo}=s96-c"))
      stub_photo

      sign_in_with_google

      expect(response).to redirect_to("/dashboard")
      expect_attached(filename: "photo-id=s400-c")
    end

    it "is attached when it is a jpeg", parity: true do
      stub_google(userinfo: userinfo(picture: "#{photo}.jpg"))
      stub_photo(path: "#{photo}.jpg", type: "image/jpeg", body: Base64.decode64(jpeg_9x4))

      sign_in_with_google

      expect_attached(content_type: "image/jpeg")
    end

    it "drops the size parameter and keeps the others", parity: true do
      stub_google(userinfo: userinfo(picture: "#{photo}?sz=50&a=b%20c&a=d"))
      stub_photo(path: "#{photo}?a=b%20c&a=d")

      sign_in_with_google

      expect_attached
    end

    it "repairs a doubled scheme", parity: true do
      stub_google(userinfo: userinfo(picture: "https:#{photo}"))
      stub_photo(path: photo)

      sign_in_with_google

      expect_attached
    end

    it "is attached to an account found by its address, which the sign-in changes", parity: true do
      aged(create(:user, email: "google.user@example.com", name: "Password Owner"))
      stub_google(userinfo: userinfo(picture: "#{photo}=s96-c"))
      stub_photo

      sign_in_with_google

      expect(response).to redirect_to("/dashboard")
      expect_attached
    end

    it "is attached to a returning user the sign-in changes nothing else for", parity: true do
      aged(user)
      stub_google(userinfo: userinfo(picture: "#{photo}=s96-c"))
      stub_photo

      sign_in_with_google

      expect(response).to redirect_to("/dashboard")
      expect_attached
    end

    it "is not downloaded when the user has a picture", parity: true do
      aged(user)
      blob = ActiveStorage::Blob.create!(key: "c22j-avatar-#{user.id}", filename: "avatar.png", content_type: "image/png", metadata: { "analyzed" => true },
                                         byte_size: 10, checksum: "c22jchecksum", service_name: ActiveStorage::Blob.service.name)
      ActiveStorage::Attachment.insert({ name: "avatar", record_type: "User", record_id: user.id, blob_id: blob.id, created_at: Time.current })
      stub_google(userinfo: userinfo(picture: "#{photo}=s96-c"))

      sign_in_with_google

      expect(response).to redirect_to("/dashboard")
      expect(user.reload.avatar.blob.id).to eq(blob.id)
    end

    it "leaves the account without one when the download is refused", parity: true do
      stub_google(userinfo: userinfo(picture: photo))
      stub_photo(path: photo, status: 404, body: "")

      sign_in_with_google

      expect(response).to redirect_to("/dashboard")
      expect(avatar.call).not_to be_attached
    end

    it "leaves the account without one when the file is not an image type", parity: true do
      stub_google(userinfo: userinfo(picture: photo))
      stub_photo(path: photo, type: "text/html", body: "<html></html>")

      sign_in_with_google

      expect(avatar.call).not_to be_attached
    end

    it "refuses the sign-up and keeps the blob when the file is a gif sent as a png", parity: true do
      stub_google(userinfo: userinfo(picture: photo))
      stub_photo(path: photo, type: "image/png", body: Base64.decode64("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"))

      sign_in_with_google

      expect(response).to redirect_to("/signup")
      expect(flash[:alert]).to eq("Sorry, something went wrong. Please try again.")
      expect(User.where(google_uid: google_sub)).to be_empty
      expect(ActiveStorage::Blob.pluck(:content_type)).to eq(["image/gif"])
      expect(ActiveStorage::Attachment.count).to eq(0)
    end

    it "ends in the failure action when the address of the picture is not a URI", parity: true do
      stub_google(userinfo: userinfo(picture: "https://lh3.googleusercontent.com/a b"))

      sign_in_with_google

      expect(response).to redirect_to("http://#{DOMAIN}/users/sign_in")
      expect(flash[:alert]).to start_with("Could not authenticate you from GoogleOauth2 because \"Bad uri")
      expect(User.where(google_uid: google_sub)).to be_empty
    end

    it "ends in the failure action when the picture is not text", parity: true do
      stub_google(userinfo: userinfo(picture: 4242))

      sign_in_with_google

      expect(response).to redirect_to("http://#{DOMAIN}/users/sign_in")
      expect(User.where(google_uid: google_sub)).to be_empty
    end
  end

  describe "an exchange that fails" do
    it "ends in the failure action when Google refuses the code", parity: true do
      stub_google(token_status: 400, token_body: { error: "invalid_grant", error_description: "Bad Request" })

      sign_in_with_google

      expect(response).to redirect_to("http://#{DOMAIN}/users/sign_in")
      expect(flash[:alert]).to eq("Could not authenticate you from GoogleOauth2 because \"Invalid credentials\".")
    end

    it "ends in the failure action when the ID token was issued for another client", parity: true do
      stub_google(id_token: id_token(aud: "another-client"))

      sign_in_with_google

      expect(response).to redirect_to("http://#{DOMAIN}/users/sign_in")
      expect(User.where(google_uid: google_sub)).to be_empty
    end

    it "ends in the failure action when the user info is refused", parity: true do
      stub_google(userinfo_status: 401)

      sign_in_with_google

      expect(response).to redirect_to("http://#{DOMAIN}/users/sign_in")
      expect(flash[:alert]).to eq("Could not authenticate you from GoogleOauth2 because \"Invalid credentials\".")
    end
  end

  describe "a callback Node leaves to Rails" do
    it "hands a callback of a visitor who is already signed in to Rails", parity: true do
      log_in(user)
      state = begin_flow
      stub_google

      callback(state)

      expect(response).to have_http_status(:found)
    end

    it "hands an XHR callback to Rails", parity: true do
      state = begin_flow
      stub_google

      get "/users/auth/google_oauth2/callback", params: { code: "google-code-1", state: }, headers: { "X-Requested-With" => "XMLHttpRequest" }

      expect(response).to have_http_status(:found)
    end

    it "hands a callback that names a redirect URI to Rails", parity: true do
      state = begin_flow
      stub_google

      callback(state, redirect_uri: "postmessage")

      expect(response).to have_http_status(:found)
    end

    it "hands a callback that carries an error description beside its code to Rails", parity: true do
      state = begin_flow
      stub_google

      callback(state, error_description: "Something happened")

      expect(response).to have_http_status(:found)
    end

    it "hands a callback of the async Twitter link state to Rails", parity: true do
      state = begin_flow("state=async_link_twitter_account")
      stub_google(token_status: 400, token_body: { error: "invalid_grant" })

      callback(state)

      expect(response).to have_http_status(:ok)
    end
  end
end
