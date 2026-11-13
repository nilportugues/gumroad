# frozen_string_literal: true

require "spec_helper"

# POST /:client/v1/oauth2/register (Api::V2::McpController#register, dynamic client registration), recorded for the Next.js port
# (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/api-v2-ws17c.replay.test.ts. Node answers the refusals and counts the request in
# Rack::Attack's `oauth_dynamic_registration/ip` throttle; an example named "hands ..." is one it cannot prove (the row it would insert has a
# random client id and secret), which must reach Rails whole and leave no count behind.
describe "MCP dynamic client registration", type: :request do
  let(:headers) { { "Content-Type" => "application/json" } }
  let(:counted_headers) { headers.merge("CF-Connecting-IP" => "203.0.113.55") }
  let(:redirect_uri) { "https://client.example.com/callback" }

  before do
    host! DOMAIN
    Rack::Attack.cache.store.flushdb
  end

  after { Rack::Attack.cache.store.flushdb }

  def register(body, client: "claude", extra_headers: headers)
    post "/#{client}/v1/oauth2/register", params: body.is_a?(String) ? body : body.to_json, headers: extra_headers
  end

  def expect_refusal(message)
    expect(response).to have_http_status(:bad_request)
    expect(response.parsed_body).to eq("error" => "invalid_client_metadata", "error_description" => message)
  end

  # A JSON content type fails in Rails' parameter parser before the action runs; the action's own rescue is for other content types.
  it "hands a text body that is not JSON to Rails", parity: true do
    register("{not json", extra_headers: { "Content-Type" => "text/plain" })

    expect_refusal("JSON parse error")
  end

  %w[muse chatgpt].each do |client|
    it "answers the #{client} connector like the claude one", parity: true do
      register({ redirect_uris: ["/callback"] }, client:)

      expect_refusal("redirect_uris must be absolute http(s) URLs")
    end
  end

  it "requires redirect_uris for a blank body", parity: true do
    register("")

    expect_refusal("redirect_uris is required")
  end

  it "requires redirect_uris when the body is a JSON scalar", parity: true do
    register("5")

    expect_refusal("redirect_uris is required")
  end

  it "requires redirect_uris when the list is blank", parity: true do
    register({ redirect_uris: ["  ", ""] })

    expect_refusal("redirect_uris is required")
  end

  it "hands a list with a null in it to Rails", parity: true do
    register({ redirect_uris: ["  ", nil, ""] })

    expect_refusal("redirect_uris is required")
  end

  it "reads the singular redirect_uri when redirect_uris is absent", parity: true do
    register({ redirect_uri: "http://example.com/callback" })

    expect_refusal("redirect_uris must be https (or http on localhost)")
  end

  it "refuses more than ten redirect URIs", parity: true do
    register({ redirect_uris: (1..11).map { |i| "https://client.example.com/#{i}" } })

    expect_refusal("redirect_uris must contain at most 10 entries")
  end

  it "refuses a wildcard", parity: true do
    register({ redirect_uris: ["https://*.example.com/callback"] })

    expect_refusal("redirect_uris must not contain wildcards")
  end

  it "refuses a URL Ruby cannot parse", parity: true do
    register({ redirect_uris: ["https://client.example.com/a b"] })

    expect_refusal("redirect_uris must be valid URLs")
  end

  it "refuses a relative URL", parity: true do
    register({ redirect_uris: ["/callback"] })

    expect_refusal("redirect_uris must be absolute http(s) URLs")
  end

  it "refuses a number in the list", parity: true do
    register({ redirect_uris: [5] })

    expect_refusal("redirect_uris must be absolute http(s) URLs")
  end

  it "refuses a fragment", parity: true do
    register({ redirect_uris: ["https://client.example.com/callback#done"] })

    expect_refusal("redirect_uris must not include a fragment")
  end

  it "refuses plain http away from localhost", parity: true do
    register({ redirect_uris: ["http://client.example.com/callback"] })

    expect_refusal("redirect_uris must be https (or http on localhost)")
  end

  it "refuses a scheme that is not http(s)", parity: true do
    register({ redirect_uris: ["ftp://client.example.com/callback"] })

    expect_refusal("redirect_uris must be https (or http on localhost)")
  end

  it "reports the first invalid URL of the list", parity: true do
    register({ redirect_uris: [redirect_uri, "http://client.example.com/b", "/c"] })

    expect_refusal("redirect_uris must be https (or http on localhost)")
  end

  it "refuses redirect URIs longer than 255 characters combined", parity: true do
    register({ redirect_uris: ["https://client.example.com/#{"a" * 130}", "https://client.example.com/#{"b" * 130}"] })

    expect_refusal("redirect_uris must be at most 255 characters combined")
  end

  it "refuses an unsupported token endpoint auth method", parity: true do
    register({ redirect_uris: [redirect_uri], token_endpoint_auth_method: "private_key_jwt" })

    expect_refusal("unsupported token_endpoint_auth_method")
  end

  it "refuses a scope list with nothing supported", parity: true do
    register({ redirect_uris: [redirect_uri], scope: "edit_emails  nonsense" })

    expect_refusal("no supported scopes requested")
  end

  it "checks the authentication method before the scopes", parity: true do
    register({ redirect_uris: [redirect_uri], token_endpoint_auth_method: "bogus", scope: "nonsense" })

    expect_refusal("unsupported token_endpoint_auth_method")
  end

  it "counts a refusal in the per-IP throttle", parity: true do
    register({ redirect_uris: ["/callback"] }, extra_headers: counted_headers)

    expect_refusal("redirect_uris must be absolute http(s) URLs")
    expect(Rack::Attack.cache.store.keys("rack::attack:*:oauth_dynamic_registration/ip:203.0.113.55").size).to eq(1)
  end

  # The client id and secret are random: the replay masks them and asserts their shape, and the row they land in.
  def registered(body = {}, extra_headers: headers)
    register({ redirect_uris: [redirect_uri] }.merge(body), extra_headers:)
    expect(response).to have_http_status(:created)
    response.parsed_body
  end

  it "registers a public client and counts it in the per-IP throttle", parity: true do
    body = registered({ client_name: "Example" }, extra_headers: counted_headers)

    expect(body).to include("redirect_uris" => [redirect_uri], "token_endpoint_auth_method" => "none", "scope" => Mcp::OauthClientRegistration::MCP_SCOPES.join(" "))
    expect(body).not_to have_key("client_secret")
    expect(Rack::Attack.cache.store.keys("rack::attack:*:oauth_dynamic_registration/ip:203.0.113.55").size).to eq(1)
  end

  it "registers a confidential client and returns its secret", parity: true do
    body = registered({ token_endpoint_auth_method: "client_secret_post", scope: "view_public account" })

    expect(body).to include("client_secret" => be_present, "scope" => "view_public account", "token_endpoint_auth_method" => "client_secret_post")
  end

  it "registers a client that authenticates with a basic header", parity: true do
    expect(registered({ token_endpoint_auth_method: "client_secret_basic" })).to include("client_secret" => be_present)
  end

  it "gives the client the scopes it asked for in the order it asked, dropping the ones it cannot have", parity: true do
    expect(registered({ scope: "account  edit_emails\tview_public view_public" })["scope"]).to eq("account view_public")
  end

  it "names the client after the connector and strips the name it sent", parity: true do
    registered({ client_name: "  Example client \n" })
  end

  it "names a client without a name", parity: true do
    registered({ client_name: "   " })
  end

  it "names a client whose name is only a no-break space", parity: true do
    registered({ client_name: " 　" })
  end

  it "shortens a long client name to 80 characters", parity: true do
    registered({ client_name: "é" * 100 })
  end

  it "keeps a name of exactly 80 characters", parity: true do
    registered({ client_name: "n" * 76 })
  end

  it "joins several redirect URIs, dropping duplicates and blanks", parity: true do
    other = "http://localhost:8080/callback"
    body = registered({ redirect_uris: [redirect_uri, " #{other} ", "", redirect_uri, "http://127.0.0.1/cb"] })

    expect(body["redirect_uris"]).to eq([redirect_uri, other, "http://127.0.0.1/cb"])
  end

  it "registers the singular redirect_uri", parity: true do
    register({ redirect_uri: redirect_uri })

    expect(response).to have_http_status(:created)
    expect(response.parsed_body["redirect_uris"]).to eq([redirect_uri])
  end

  it "keeps the query of a redirect URI", parity: true do
    registered({ redirect_uris: ["#{redirect_uri}?tenant=1&a=b"] })
  end

  it "registers a client for the muse connector", parity: true do
    register({ redirect_uris: [redirect_uri] }, client: "muse")

    expect(response).to have_http_status(:created)
  end

  it "registers a client whose redirect URIs fill the 255 characters", parity: true do
    registered({ redirect_uris: ["https://client.example.com/#{"a" * 100}", "https://client.example.com/#{"b" * 100}"] })
  end

  it "answers 429 past the per-IP limit", parity: true do
    20.times do
      Rack::Attack.configuration.throttled?(
        Rack::Attack::Request.new(Rack::MockRequest.env_for("/claude/v1/oauth2/register", method: "POST", input: "", "HTTP_CF_CONNECTING_IP" => "203.0.113.55"))
      )
    end

    register({ redirect_uris: [redirect_uri] }, extra_headers: counted_headers)

    expect(response).to have_http_status(:too_many_requests)
    expect(response.body).to eq("Retry later\n")
    expect(response.headers["Retry-After"]).to be_present
  end
end
