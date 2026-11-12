# frozen_string_literal: true

require "spec_helper"

# The OAuth device flow, recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/oauth-device-flow.replay.test.ts: POST /oauth/device/code, the device-code grant of POST /oauth/token, and the
# signed-out sides of GET and POST /oauth/device. The codes are random, so the replay checks their digests against the row. An example
# named "hands ..." is one Node leaves to Rails: the confirmation page is an ERB view in the application layout.
describe "OAuth device flow", type: :request do
  include Parity::SignedInDashboard

  before { stub_vite_layout_helpers }

  def stub_vite_layout_helpers
    allow(ViteRuby.instance.manifest).to receive(:resolve_entries).and_return({ stylesheets: ["/vite-test.css"] })
    allow_any_instance_of(ActionView::Base).to receive(:vite_client_tag).and_return("")
    allow_any_instance_of(ActionView::Base).to receive(:vite_react_refresh_tag).and_return("")
    allow_any_instance_of(ActionView::Base).to receive(:vite_typescript_tag).and_return("")
  end

  let(:owner) { create(:user) }
  let(:resource_owner) { create(:user) }
  let(:grant_type) { OauthDeviceAuthorization::GRANT_TYPE }
  let(:device_app) { create(:oauth_application, owner:, name: "Gumroad CLI", scopes: "view_profile edit_products", confidential: false, device_authorization_enabled: true) }
  let(:confidential_device_app) { create(:oauth_application, owner:, scopes: "view_profile edit_products", confidential: true, device_authorization_enabled: true) }

  def basic(application)
    { "Authorization" => ActionController::HttpAuthentication::Basic.encode_credentials(application.uid, application.secret) }
  end

  def pending_authorization(application = device_app, scopes: "view_profile")
    OauthDeviceAuthorization.create_for!(oauth_application: application, scopes:, ip_address: "203.0.113.10", user_agent: "Gumroad CLI")
  end

  def approved_authorization(application = device_app, scopes: "view_profile", **attributes)
    authorization, device_code, user_code = pending_authorization(application, scopes:)
    authorization.update_columns(status: "approved", resource_owner_id: resource_owner.id, approved_at: Time.current, **attributes)
    [authorization, device_code, user_code]
  end

  # The replay's HTTP client would otherwise stamp its own User-Agent on the poll, which the code records.
  def poll_headers(headers = {})
    { "User-Agent" => "Gumroad CLI" }.merge(headers)
  end

  # A fixed client address and User-Agent: the code records both, and the replay's HTTP client would stamp its own.
  def code_headers(headers = {})
    { "REMOTE_ADDR" => "203.0.113.10", "HTTP_USER_AGENT" => "Gumroad CLI" }.merge(headers)
  end

  def poll(application, device_code, **extra)
    post "/oauth/token", params: { grant_type:, client_id: application.uid, device_code:, **extra }, headers: poll_headers
  end

  describe "POST /oauth/device/code" do
    it "creates a pending authorization and answers with the device flow payload", parity: true do
      post "/oauth/device/code", params: { client_id: device_app.uid, scope: "view_profile" }, headers: code_headers

      body = response.parsed_body
      expect(response).to have_http_status(:ok)
      expect(body.keys).to match_array(%w[device_code user_code verification_uri verification_uri_complete expires_in interval])
      expect(body["user_code"]).to match(/\AGRD-[A-Z0-9]{4}-[A-Z0-9]{4}\z/)
      expect(body).to include("expires_in" => 600, "interval" => 30)
      expect(body["verification_uri_complete"]).to eq("#{body["verification_uri"]}?user_code=#{body["user_code"]}")
      authorization = OauthDeviceAuthorization.last
      expect(authorization).to have_attributes(oauth_application_id: device_app.id, scopes: "view_profile", status: "pending", poll_interval_seconds: 30, poll_count: 0)
      expect(authorization.device_code_digest).to eq(OauthDeviceAuthorization.digest(body["device_code"]))
      expect(authorization.user_code_digest).to eq(OauthDeviceAuthorization.digest(OauthDeviceAuthorization.normalize_user_code(body["user_code"])))
    end

    it "stores the scope string as sent", parity: true do
      post "/oauth/device/code", params: { client_id: device_app.uid, scope: "view_profile  edit_products" }, headers: code_headers

      expect(response).to have_http_status(:ok)
      expect(OauthDeviceAuthorization.last.scopes).to eq("view_profile  edit_products")
    end

    it "uses the scopes of the application when none are asked for", parity: true do
      post "/oauth/device/code", params: { client_id: device_app.uid }, headers: code_headers

      expect(OauthDeviceAuthorization.last.scopes).to eq("view_profile edit_products")
    end

    it "uses the scopes of the application for a blank scope", parity: true do
      post "/oauth/device/code", params: { client_id: device_app.uid, scope: "" }, headers: code_headers

      expect(OauthDeviceAuthorization.last.scopes).to eq("view_profile edit_products")
    end

    it "authenticates a confidential client with a Basic header", parity: true do
      post "/oauth/device/code", params: { scope: "view_profile" }, headers: code_headers(basic(confidential_device_app))

      expect(response).to have_http_status(:ok)
    end

    it "authenticates a confidential client with its secret as a parameter", parity: true do
      post "/oauth/device/code", params: { client_id: confidential_device_app.uid, client_secret: confidential_device_app.secret }, headers: code_headers

      expect(response).to have_http_status(:ok)
    end

    it "asks for a client id", parity: true do
      post "/oauth/device/code", params: { scope: "view_profile" }, headers: code_headers

      expect(response).to have_http_status(:bad_request)
      expect(response.parsed_body).to eq("error" => "invalid_request", "error_description" => "client_id is required")
      expect(response.headers["WWW-Authenticate"]).to be_nil
    end

    it "answers invalid_client for an unknown client", parity: true do
      post "/oauth/device/code", params: { client_id: "unknown" }, headers: code_headers

      expect(response).to have_http_status(:unauthorized)
      expect(response.parsed_body).to eq("error" => "invalid_client", "error_description" => "Client authentication failed due to unknown client")
      expect(response.headers["Cache-Control"]).to include("no-store")
    end

    it "challenges a Basic header that names an unknown client", parity: true do
      post "/oauth/device/code", headers: code_headers({ "Authorization" => ActionController::HttpAuthentication::Basic.encode_credentials("unknown", "secret") })

      expect(response).to have_http_status(:unauthorized)
      expect(response.headers["WWW-Authenticate"]).to eq('Basic realm="Doorkeeper"')
    end

    it "answers invalid_client for a confidential client with the wrong secret", parity: true do
      post "/oauth/device/code", params: { client_id: confidential_device_app.uid, client_secret: "wrong" }, headers: code_headers

      expect(response).to have_http_status(:unauthorized)
      expect(response.parsed_body["error_description"]).to eq("Client authentication failed")
    end

    it "answers invalid_client for a confidential client with no secret", parity: true do
      post "/oauth/device/code", params: { client_id: confidential_device_app.uid }, headers: code_headers

      expect(response).to have_http_status(:unauthorized)
    end

    it "answers invalid_client for a deleted application", parity: true do
      device_app.mark_deleted!

      post "/oauth/device/code", params: { client_id: device_app.uid }, headers: code_headers

      expect(response).to have_http_status(:unauthorized)
    end

    it "refuses an application that has not opted in to device authorization", parity: true do
      app = create(:oauth_application, owner:, scopes: "view_profile", confidential: false, device_authorization_enabled: false)

      post "/oauth/device/code", params: { client_id: app.uid }, headers: code_headers

      expect(response).to have_http_status(:bad_request)
      expect(response.parsed_body).to eq("error" => "unauthorized_client", "error_description" => "Client is not allowed to use device authorization")
      expect(OauthDeviceAuthorization.count).to eq(0)
    end

    it "answers invalid_scope for a scope the application lacks", parity: true do
      post "/oauth/device/code", params: { client_id: device_app.uid, scope: "mobile_api" }, headers: code_headers

      expect(response).to have_http_status(:bad_request)
      expect(response.parsed_body).to eq("error" => "invalid_scope", "error_description" => "The requested scope is invalid")
      expect(OauthDeviceAuthorization.count).to eq(0)
    end

    it "answers invalid_scope for a scope list with one scope the application lacks", parity: true do
      post "/oauth/device/code", params: { client_id: device_app.uid, scope: "view_profile mobile_api" }, headers: code_headers

      expect(response.parsed_body["error"]).to eq("invalid_scope")
    end

    it "answers invalid_scope for a scope that is not a string", parity: true do
      post "/oauth/device/code", params: { client_id: device_app.uid, scope: { bad: "1" } }, headers: code_headers

      expect(response.parsed_body["error"]).to eq("invalid_scope")
    end

    it "answers invalid_scope for a scope containing a tab", parity: true do
      post "/oauth/device/code", params: { client_id: device_app.uid, scope: "view_profile\tedit_products" }, headers: code_headers

      expect(response.parsed_body["error"]).to eq("invalid_scope")
    end
  end

  describe "POST /oauth/token with the device_code grant" do
    it "answers authorization_pending for a code nobody approved yet", parity: true do
      _authorization, device_code, = pending_authorization

      poll(device_app, device_code, scope: "ignored")

      expect(response).to have_http_status(:bad_request)
      expect(response.parsed_body).to eq("error" => "authorization_pending", "error_description" => "Authorization is pending")
    end

    it "records the poll", parity: true do
      authorization, device_code, = pending_authorization

      poll(device_app, device_code)

      expect(authorization.reload).to have_attributes(poll_count: 1, last_poll_ip_address: "127.0.0.1")
      expect(authorization.last_polled_at).to be_present
    end

    it "asks the client to slow down when it polls again within the interval", parity: true do
      _authorization, device_code, = pending_authorization
      poll(device_app, device_code)
      expect(response.parsed_body["error"]).to eq("authorization_pending")

      poll(device_app, device_code)

      expect(response).to have_http_status(:bad_request)
      expect(response.parsed_body).to eq("error" => "slow_down", "error_description" => "Polling too quickly", "interval" => 35)
    end

    it "issues a token once the code is approved and consumes the code", parity: true do
      authorization, device_code, = approved_authorization(scopes: "view_profile edit_products")

      poll(device_app, device_code)

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body.keys).to match_array(%w[access_token token_type refresh_token scope created_at])
      expect(response.parsed_body["scope"]).to eq("view_profile edit_products")
      token = Doorkeeper::AccessToken.find_by!(token: response.parsed_body["access_token"])
      expect(token).to have_attributes(application_id: device_app.id, resource_owner_id: resource_owner.id, expires_in: nil, refresh_token: response.parsed_body["refresh_token"])
      expect(authorization.reload).to have_attributes(status: "consumed", access_token_id: token.id)
      expect(authorization.consumed_at).to be_present
      expect(Doorkeeper::AccessGrant.where(application_id: device_app.id, resource_owner_id: resource_owner.id, redirect_uri: OauthDeviceAuthorization::DEVICE_REDIRECT_URI).count).to eq(1)
    end

    it "reuses the access grant of an earlier device authorization", parity: true do
      Doorkeeper::AccessGrant.create!(application: device_app, resource_owner_id: resource_owner.id, scopes: "view_profile", redirect_uri: OauthDeviceAuthorization::DEVICE_REDIRECT_URI, expires_in: 60.years)
      _authorization, device_code, = approved_authorization

      poll(device_app, device_code)

      expect(response).to have_http_status(:ok)
      expect(Doorkeeper::AccessGrant.count).to eq(1)
    end

    it "issues a token to a confidential client that authenticates with a Basic header", parity: true do
      _authorization, device_code, = approved_authorization(confidential_device_app)

      post "/oauth/token", params: { grant_type:, device_code: }, headers: poll_headers(basic(confidential_device_app))

      expect(response).to have_http_status(:ok)
    end

    it "issues a token in the grace period after the code expired", parity: true do
      _authorization, device_code, = approved_authorization(expires_at: 5.seconds.ago, approved_at: 1.minute.ago)

      poll(device_app, device_code)

      expect(response).to have_http_status(:ok)
    end

    it "answers expired_token for a code that expired", parity: true do
      authorization, device_code, = pending_authorization
      authorization.update_columns(expires_at: 1.minute.ago)

      poll(device_app, device_code)

      expect(response.parsed_body).to eq("error" => "expired_token", "error_description" => "Device code is invalid or expired")
    end

    it "answers expired_token for a code that was already consumed", parity: true do
      authorization, device_code, = approved_authorization
      authorization.update_columns(status: "consumed")

      poll(device_app, device_code)

      expect(response.parsed_body["error"]).to eq("expired_token")
    end

    it "answers expired_token for a device code that does not exist", parity: true do
      poll(device_app, "unknown")

      expect(response).to have_http_status(:bad_request)
      expect(response.parsed_body).to eq("error" => "expired_token", "error_description" => "Device code is invalid or expired")
    end

    it "answers expired_token for the device code of another application", parity: true do
      other = create(:oauth_application, owner:, scopes: "view_profile", confidential: false, device_authorization_enabled: true)
      _authorization, device_code, = pending_authorization(other)

      poll(device_app, device_code)

      expect(response.parsed_body["error"]).to eq("expired_token")
    end

    it "answers access_denied for a code that was denied", parity: true do
      authorization, device_code, = pending_authorization
      authorization.update_columns(status: "denied", resource_owner_id: resource_owner.id, denied_at: Time.current)

      poll(device_app, device_code)

      expect(response.parsed_body).to eq("error" => "access_denied", "error_description" => "Access was denied")
    end

    it "denies an approved code whose owner has closed the account", parity: true do
      authorization, device_code, = approved_authorization
      resource_owner.update_columns(deleted_at: Time.current)

      poll(device_app, device_code)

      expect(response.parsed_body["error"]).to eq("access_denied")
      expect(authorization.reload.status).to eq("denied")
      expect(Doorkeeper::AccessToken.count).to eq(0)
    end

    it "denies an approved code when the owner revoked all access after it was created", parity: true do
      authorization, device_code, = approved_authorization
      Doorkeeper::AccessToken.create!(application: device_app, resource_owner_id: resource_owner.id, scopes: "view_profile", revoked_at: Time.current)

      poll(device_app, device_code)

      expect(response.parsed_body["error"]).to eq("access_denied")
      expect(authorization.reload.status).to eq("denied")
    end

    it "asks for a device code", parity: true do
      poll(device_app, "")

      expect(response).to have_http_status(:bad_request)
      expect(response.parsed_body).to eq("error" => "invalid_request", "error_description" => "device_code is required")
    end

    it "answers invalid_client for an unknown client", parity: true do
      post "/oauth/token", params: { grant_type:, client_id: "unknown", device_code: "x" }, headers: poll_headers

      expect(response).to have_http_status(:unauthorized)
      expect(response.parsed_body["error"]).to eq("invalid_client")
    end

    it "refuses an application that has not opted in to device authorization", parity: true do
      app = create(:oauth_application, owner:, scopes: "view_profile", confidential: false, device_authorization_enabled: false)

      post "/oauth/token", params: { grant_type:, client_id: app.uid, device_code: "x" }, headers: poll_headers

      expect(response.parsed_body).to eq("error" => "unauthorized_client", "error_description" => "Client is not allowed to use device authorization")
    end

    it "does not offer the grant on the connector aliases", parity: true do
      post "/claude/v1/oauth2/token", params: { grant_type:, client_id: device_app.uid, device_code: "x" }

      expect(response.parsed_body["error"]).to eq("unsupported_grant_type")
    end

    it "hands a device code that is not a string back to Rails", parity: true do
      post "/oauth/token", params: { grant_type:, client_id: device_app.uid, device_code: ["x"] }, headers: poll_headers

      expect(response).to have_http_status(:bad_request)
    end
  end

  describe "GET /oauth/device" do
    it "sends a signed-out visitor with a pending code to the login page and keeps the code in the session", parity: true do
      _authorization, _device_code, user_code = pending_authorization

      get "/oauth/device", params: { user_code: }

      expect(response).to have_http_status(:found)
      expect(response.location).to match(%r{\Ahttp://#{DOMAIN}/login\?next=%2Foauth%2Fdevice%3Fhandoff%3D[\w-]+\z}o)
      expect(response.headers["X-Robots-Tag"]).to eq("noindex")
    end

    it "accepts the code in lower case without dashes", parity: true do
      _authorization, _device_code, user_code = pending_authorization

      get "/oauth/device", params: { user_code: user_code.delete("-").downcase }

      expect(response).to have_http_status(:found)
    end

    it "replaces the handoff of the same code when the visitor comes back", parity: true do
      _authorization, _device_code, user_code = pending_authorization
      get "/oauth/device", params: { user_code: }
      expect(response).to have_http_status(:found)

      get "/oauth/device", params: { user_code: }

      expect(response).to have_http_status(:found)
    end

    it "keeps the handoffs of other codes", parity: true do
      _first, _first_code, first_user_code = pending_authorization
      _second, _second_code, second_user_code = pending_authorization
      get "/oauth/device", params: { user_code: first_user_code }
      expect(response).to have_http_status(:found)

      get "/oauth/device", params: { user_code: second_user_code }

      expect(response).to have_http_status(:found)
    end

    it "hands a visit with no code back to Rails", parity: true do
      get "/oauth/device"

      expect(response).to have_http_status(:ok)
    end

    it "hands an unknown code back to Rails", parity: true do
      get "/oauth/device", params: { user_code: "GRD-AAAA-BBBB" }

      expect(response).to have_http_status(:ok)
    end

    it "hands an expired code back to Rails", parity: true do
      authorization, _device_code, user_code = pending_authorization
      authorization.update_columns(expires_at: 1.minute.ago)

      get "/oauth/device", params: { user_code: }

      expect(response).to have_http_status(:ok)
    end

    it "hands the code of an application that closed device authorization back to Rails", parity: true do
      _authorization, _device_code, user_code = pending_authorization
      device_app.update_columns(device_authorization_enabled: false)

      get "/oauth/device", params: { user_code: }

      expect(response).to have_http_status(:ok)
    end

    it "hands a signed-in visitor back to Rails", parity: true do
      _authorization, _device_code, user_code = pending_authorization
      log_in(resource_owner)

      get "/oauth/device", params: { user_code: }

      expect(response).to have_http_status(:ok)
    end
  end

  describe "POST /oauth/device" do
    it "sends a signed-out visitor to the login page", parity: true do
      _authorization, _device_code, user_code = pending_authorization

      post "/oauth/device", params: { authenticity_token: csrf_token, user_code:, decision: "approve" }

      expect(response).to have_http_status(:found)
      expect(response.location).to eq("http://#{DOMAIN}/login?next=%2Foauth%2Fdevice")
      expect(response.headers["X-Robots-Tag"]).to eq("noindex")
    end

    it "answers a signed-out JSON request with the 404 JSON of authenticate_user!", parity: true do
      post "/oauth/device", params: { authenticity_token: csrf_token, decision: "approve" }, as: :json

      expect(response).to have_http_status(:not_found)
    end

    it "hands a signed-in decision back to Rails", parity: true do
      authorization, _device_code, user_code = pending_authorization
      log_in(resource_owner)

      post "/oauth/device", params: { authenticity_token: csrf_token, user_code:, decision: "approve" }

      expect(response).to have_http_status(:ok)
      expect(authorization.reload.status).to eq("approved")
    end
  end
end
