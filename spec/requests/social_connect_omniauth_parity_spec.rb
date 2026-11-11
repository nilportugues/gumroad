# frozen_string_literal: true

require "spec_helper"

# The YouTube, Instagram and TikTok connect flows of User::OmniauthCallbacksController that end before a provider is asked for a token (the
# request phase, the flag-off answer of each strategy, the callback checks that end in the failure action), recorded for the Next.js port
# (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/social-connect-omniauth.replay.test.ts, which sends the last request of each example.
# The OmniAuth middleware runs for real (test_mode off). A callback that carries a code is in social_connect_token_exchange_parity_spec.rb.
describe "Social connect OmniAuth phases", type: :request do
  include Parity::AudienceSignedIn

  let(:user) { create(:named_seller, name: "Social Connector") }
  let(:authorize_hosts) do
    { "youtube" => "https://accounts.google.com/o/oauth2/auth?", "instagram" => "https://www.instagram.com/oauth/authorize?",
      "tiktok" => "https://www.tiktok.com/v2/auth/authorize/?" }
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

  %w[youtube instagram tiktok].each do |provider|
    name = { "youtube" => "YouTube", "instagram" => "Instagram", "tiktok" => "TikTok" }.fetch(provider)

    describe provider do
      describe "POST /users/auth/#{provider}" do
        it "sends a seller with the flag on to #{name}", parity: true do
          Feature.activate_user(:"#{provider}_connect", user)
          log_in(user)

          post "/users/auth/#{provider}", params: { authenticity_token: csrf_token }

          expect(response).to have_http_status(:found)
          expect(response.location).to start_with(authorize_hosts.fetch(provider))
          expect(Event.where(user_id: user.id, event_name: "social_connect_attempted", parent_referrer: provider).count).to eq(1)
        end

        it "keeps the origin of the page and the query of the request in the session for the callback", parity: true do
          Feature.activate_user(:"#{provider}_connect", user)
          log_in(user)

          post "/users/auth/#{provider}?social_connect_return=abc", params: { authenticity_token: csrf_token, origin: "/settings/social_connections" }

          expect(response.location).to start_with(authorize_hosts.fetch(provider))
        end

        it "sends a seller without the flag to the social connections settings", parity: true do
          log_in(user)

          post "/users/auth/#{provider}", params: { authenticity_token: csrf_token }

          expect(response).to redirect_to("/settings/social_connections")
          expect(Event.where(user_id: user.id, event_name: "social_connect_attempted", parent_referrer: provider).count).to eq(1)
        end

        it "sends a visitor who is not signed in to the login page", parity: true do
          post "/users/auth/#{provider}", params: { authenticity_token: csrf_token }

          expect(response).to redirect_to("/login")
        end

        it "sends a visitor who is not signed in to #{name} when the connect is on for everyone", parity: true do
          Feature.activate(:"#{provider}_connect")

          post "/users/auth/#{provider}", params: { authenticity_token: csrf_token }

          expect(response.location).to start_with(authorize_hosts.fetch(provider))
          expect(Event.where(event_name: "social_connect_attempted").count).to eq(0)
        end

        it "hands a request without the flag that carries a return token to Rails", parity: true do
          log_in(user)
          token = visit_connections(social_connect_origin: "onboarding")

          post "/users/auth/#{provider}?social_connect_return=#{token}", params: { authenticity_token: csrf_token }

          expect(response).to redirect_to("http://#{DOMAIN}/dashboard")
          expect(flash[:alert]).to eq("Couldn't connect #{name}. Please try again.")
          expect(Event.where(user_id: user.id, event_name: "social_connect_failed", parent_referrer: provider).pluck(:referrer)).to eq(["social_connect_unavailable"])
        end

        it "hands a request with a wrong authenticity token to Rails", parity: true do
          Feature.activate_user(:"#{provider}_connect", user)
          log_in(user)
          csrf_token

          post "/users/auth/#{provider}", params: { authenticity_token: "forged" }

          expect(response).to have_http_status(:found)
        end
      end

      describe "GET /users/auth/#{provider}/callback" do
        it "ends a callback whose state is not the one that was sent in the failure action", parity: true do
          Feature.activate_user(:"#{provider}_connect", user)
          log_in(user)
          begin_flow(provider)

          get "/users/auth/#{provider}/callback", params: { code: "code-1", state: "forged" }

          expect(response).to redirect_to("http://#{DOMAIN}/settings/social_connections")
          expect(flash[:alert]).to eq("Couldn't connect #{name}. Please try again.")
          expect(Event.where(user_id: user.id, event_name: "social_connect_failed", parent_referrer: provider).pluck(:referrer)).to eq(["csrf_detected"])
        end

        it "tells a seller who denied access that the connection failed", parity: true do
          Feature.activate_user(:"#{provider}_connect", user)
          log_in(user)
          state = begin_flow(provider)

          get "/users/auth/#{provider}/callback", params: { error: "access_denied", state: }

          expect(response).to redirect_to("http://#{DOMAIN}/settings/social_connections")
          expect(Event.where(user_id: user.id, event_name: "social_connect_failed", parent_referrer: provider).pluck(:referrer)).to eq(["access_denied"])
        end

        it "sends a seller back to the page the flow started from", parity: true do
          Feature.activate_user(:"#{provider}_connect", user)
          log_in(user)
          token = visit_connections(social_connect_origin: "onboarding")
          state = begin_flow(provider, "social_connect_return=#{token}")

          get "/users/auth/#{provider}/callback", params: { error: "access_denied", state: }

          expect(response).to redirect_to("http://#{DOMAIN}/dashboard")
        end

        it "sends a visitor who is not signed in to the login page", parity: true do
          begin_flow(provider)

          get "/users/auth/#{provider}/callback", params: { error: "access_denied" }

          expect(response).to redirect_to("http://#{DOMAIN}/login")
        end

        it "sends a seller without the flag to the social connections settings", parity: true do
          log_in(user)

          get "/users/auth/#{provider}/callback", params: { code: "code-1", state: "x" }

          expect(response).to redirect_to("/settings/social_connections")
        end

        it "ends a callback of a connect that became unavailable on the way in the failure action", parity: true do
          Feature.activate_user(:"#{provider}_connect", user)
          log_in(user)
          token = visit_connections(social_connect_origin: "onboarding")
          state = begin_flow(provider, "social_connect_return=#{token}")
          Feature.deactivate_user(:"#{provider}_connect", user)

          get "/users/auth/#{provider}/callback", params: { code: "code-1", state: }

          expect(response).to redirect_to("http://#{DOMAIN}/dashboard")
          expect(Event.where(user_id: user.id, event_name: "social_connect_failed", parent_referrer: provider).pluck(:referrer)).to eq(["social_connect_unavailable"])
        end

        it "sends a visitor who is not signed in to the login page when the connect is on for everyone", parity: true do
          Feature.activate(:"#{provider}_connect")
          state = begin_flow(provider)

          get "/users/auth/#{provider}/callback", params: { error: "access_denied", state: }

          expect(response).to redirect_to("http://#{DOMAIN}/login")
          expect(Event.where(event_name: "social_connect_failed").count).to eq(0)
        end

        it "keeps an error code with characters outside the allowed set out of the funnel event", parity: true do
          Feature.activate_user(:"#{provider}_connect", user)
          log_in(user)
          state = begin_flow(provider)

          get "/users/auth/#{provider}/callback", params: { error: "Access Denied!<b>", state: }

          expect(Event.where(user_id: user.id, event_name: "social_connect_failed", parent_referrer: provider).pluck(:referrer)).to eq(["accessdeniedb"])
        end
      end
    end
  end
end
