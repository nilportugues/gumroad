# frozen_string_literal: true

require "spec_helper"

# The consent endpoints of Oauth::AuthorizationsController (GET, POST and DELETE /oauth/authorize and the connector aliases of GET),
# recorded for the Next.js port (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/oauth-authorizations.replay.test.ts, which sends
# the last request of each example. Requests that pass every check render the consent page or issue a grant: those hand back to Rails.
describe "OAuth authorizations", type: :request do
  include Parity::AudienceSignedIn

  let(:owner) { create(:named_seller, name: "OAuth Owner") }
  let(:buyer) { create(:named_user, name: "OAuth Buyer") }
  let(:redirect_uri) { "https://example.com/callback" }
  let(:application) { create(:oauth_application, owner:, name: "Client app", redirect_uri:, confidential: false, scopes: "view_public edit_products") }

  before do
    host! DOMAIN
    stub_vite_layout_helpers
  end

  def authorize_params(overrides = {})
    { response_type: "code", client_id: application.uid, redirect_uri:, scope: "view_public", state: "xyz" }.merge(overrides).compact
  end

  def form_request(method, path, params)
    public_send(method, path, params: params.merge(authenticity_token: csrf_token))
  end

  def stub_vite_layout_helpers
    allow(ViteRuby.instance.manifest).to receive(:resolve_entries).and_return({ stylesheets: ["/vite-test.css"] })
    allow_any_instance_of(ActionView::Base).to receive(:vite_client_tag).and_return("")
    allow_any_instance_of(ActionView::Base).to receive(:vite_react_refresh_tag).and_return("")
    allow_any_instance_of(ActionView::Base).to receive(:vite_typescript_tag).and_return("")
  end

  describe "when signed out" do
    it "sends the visitor to the login page and back", parity: true do
      get "/oauth/authorize", params: authorize_params

      expect(response).to have_http_status(:found)
      expect(response.location).to start_with("http://#{DOMAIN}/oauth/login?next=")
    end

    it "keeps the connector path in the login redirect", parity: true do
      get "/claude/v1/oauth2/authorize", params: authorize_params(scope: "view public&more", state: "a b")

      expect(response).to have_http_status(:found)
      expect(response.location).to include("/oauth/login?next=%2Fclaude%2Fv1%2Foauth2%2Fauthorize%3F")
    end

    it "sends the visitor of the Notion alias to the login page and back", parity: true do
      get "/notion/oauth2/authorize", params: authorize_params(code: "notion-code")

      expect(response).to have_http_status(:found)
      expect(response.location).to include("/oauth/login?next=%2Fnotion%2Foauth2%2Fauthorize%3F")
    end

    it "sends the visitor of a connector code page to the login page and back", parity: true do
      get "/muse/v1/oauth2/authorize/abc123"

      expect(response).to have_http_status(:found)
      expect(response.location).to eq("http://#{DOMAIN}/oauth/login?next=%2Fmuse%2Fv1%2Foauth2%2Fauthorize%2Fabc123")
    end

    it "sends the visitor of the IFTTT code page to the login page and back", parity: true do
      get "/ifttt/v1/oauth2/authorize/abc123", params: { state: "a b" }

      expect(response).to have_http_status(:found)
      expect(response.location).to include("/oauth/login?next=%2Fifttt%2Fv1%2Foauth2%2Fauthorize%2Fabc123%3Fstate%3Da")
    end
  end

  describe "GET /oauth/authorize" do
    before { log_in(buyer) }

    it "hands a valid request for the consent page to Rails", parity: true do
      get "/oauth/authorize", params: authorize_params

      expect(response).to have_http_status(:ok)
      expect(response.body).to include("Authorize")
    end

    it "hands an unknown scope's error page to Rails", parity: true do
      get "/oauth/authorize", params: authorize_params(scope: "view_public not_a_scope")

      expect(response).to have_http_status(:bad_request)
    end

    it "hands an unknown client's error page to Rails", parity: true do
      get "/oauth/authorize", params: authorize_params(client_id: "unknown-client")

      expect(response).to have_http_status(:unauthorized)
    end

    it "hands the code page of a signed-in visitor to Rails", parity: true do
      get "/claude/v1/oauth2/authorize/abc123"

      expect(response).to have_http_status(:ok)
    end

    it "hands the Notion alias of a signed-in visitor to Rails", parity: true do
      allow_any_instance_of(NotionApi).to receive(:get_bot_token)
      get "/notion/oauth2/authorize", params: authorize_params

      expect(response).to have_http_status(:ok)
    end

    it "hands the connector alias to Rails", parity: true do
      get "/muse/v1/oauth2/authorize", params: authorize_params

      expect(response).to have_http_status(:ok)
    end
  end

  describe "POST /oauth/authorize" do
    before { log_in(buyer) }

    it "redirects the error of an implicit request in the fragment", parity: true do
      form_request(:post, "/oauth/authorize", authorize_params(response_type: "token", state: "a b*~"))

      expect(response).to have_http_status(:found)
      expect(response.location).to eq("#{redirect_uri}#error=unsupported_response_type&error_description=The+authorization+server+does+not+support+this+response+type.&state=a+b*%7E")
    end

    it "redirects an unsupported response type", parity: true do
      form_request(:post, "/oauth/authorize", authorize_params(response_type: "bogus", state: nil))

      expect(response).to have_http_status(:found)
      expect(response.location).to start_with("#{redirect_uri}?error=unsupported_response_type")
    end

    it "redirects a scope the client did not register", parity: true do
      form_request(:post, "/oauth/authorize", authorize_params(scope: "view_sales"))

      expect(response).to have_http_status(:found)
      expect(response.location).to include("error=invalid_scope")
    end

    it "redirects a blank scope the client has no default for", parity: true do
      limited = create(:oauth_application, owner:, redirect_uri:, confidential: false, scopes: "edit_products")

      form_request(:post, "/oauth/authorize", authorize_params(client_id: limited.uid, scope: nil))

      expect(response).to have_http_status(:found)
      expect(response.location).to include("error=invalid_scope")
    end

    it "redirects a code challenge method that is neither plain nor S256", parity: true do
      form_request(:post, "/oauth/authorize", authorize_params(code_challenge: "abc", code_challenge_method: "S512"))

      expect(response).to have_http_status(:found)
      expect(response.location).to include("error=invalid_code_challenge_method")
    end

    it "hands a loopback redirect URI to Rails", parity: true do
      loopback = create(:oauth_application, owner:, redirect_uri: "http://127.0.0.1/callback", confidential: false, scopes: "view_public")

      form_request(:post, "/oauth/authorize", authorize_params(client_id: loopback.uid, redirect_uri: "http://127.0.0.1:5555/callback", scope: "nope"))

      expect(response).to have_http_status(:found)
    end

    it "hands a dynamically registered client to Rails", parity: true do
      dynamic = create(:oauth_application, owner:, redirect_uri:, confidential: false, scopes: "view_public", mcp_dynamic_client: true)

      form_request(:post, "/oauth/authorize", authorize_params(client_id: dynamic.uid))

      expect(response).to have_http_status(:found)
    end

    it "answers 401 JSON for an unknown client", parity: true do
      form_request(:post, "/oauth/authorize", authorize_params(client_id: "unknown-client"))

      expect(response).to have_http_status(:unauthorized)
      expect(response.parsed_body).to include("error" => "invalid_client", "state" => "xyz")
    end

    it "answers 400 JSON when the client id is missing", parity: true do
      form_request(:post, "/oauth/authorize", authorize_params(client_id: nil))

      expect(response).to have_http_status(:bad_request)
      expect(response.parsed_body).to eq("error" => "invalid_request", "error_description" => "Missing required parameter: client_id.", "state" => "xyz")
    end

    it "answers 400 JSON for a redirect URI the client did not register", parity: true do
      form_request(:post, "/oauth/authorize", authorize_params(redirect_uri: "https://example.org/callback", state: nil))

      expect(response).to have_http_status(:bad_request)
      expect(response.parsed_body).to include("error" => "invalid_redirect_uri")
    end

    it "redirects an unknown scope back to the client", parity: true do
      form_request(:post, "/oauth/authorize", authorize_params(scope: "nope"))

      expect(response).to have_http_status(:found)
      expect(response.location).to include("error=invalid_scope")
      expect(application.access_grants.count).to eq(0)
    end

    it "redirects an error of a client whose application was deleted", parity: true do
      application.update_column(:deleted_at, Time.current)

      form_request(:post, "/oauth/authorize", authorize_params(scope: "nope"))

      expect(response).to have_http_status(:found)
      expect(response.location).to include("error=invalid_scope")
    end

    it "hands an authorization to Rails", parity: true do
      form_request(:post, "/oauth/authorize", authorize_params)

      expect(response).to have_http_status(:found)
      expect(application.access_grants.count).to eq(1)
    end
  end

  describe "DELETE /oauth/authorize" do
    before { log_in(buyer) }

    it "denies the request and redirects to the client", parity: true do
      form_request(:delete, "/oauth/authorize", authorize_params)

      expect(response).to have_http_status(:found)
      expect(response.location).to eq("#{redirect_uri}?error=access_denied&error_description=The+resource+owner+or+authorization+server+denied+the+request.&state=xyz")
      expect(response.headers["X-Robots-Tag"]).to eq("noindex")
    end

    it "denies a request whose client is unknown", parity: true do
      form_request(:delete, "/oauth/authorize", authorize_params(client_id: "unknown-client", state: nil))

      expect(response).to have_http_status(:found)
      expect(response.location).to start_with("#{redirect_uri}?error=access_denied")
    end

    it "puts the denial of an implicit request in the fragment", parity: true do
      form_request(:delete, "/oauth/authorize", authorize_params(response_type: "token"))

      expect(response).to have_http_status(:found)
      expect(response.location).to start_with("#{redirect_uri}#error=access_denied")
    end

    it "hands a response type with no strategy to Rails", parity: true do
      form_request(:delete, "/oauth/authorize", authorize_params(response_type: "bogus"))

      expect(response).to have_http_status(:ok)
    end

    it "hands a redirect URI with a custom scheme to Rails", parity: true do
      form_request(:delete, "/oauth/authorize", authorize_params(redirect_uri: "myapp://callback"))

      expect(response).to have_http_status(:found)
      expect(response.location).to start_with("myapp://callback?error=access_denied")
    end
  end
end
