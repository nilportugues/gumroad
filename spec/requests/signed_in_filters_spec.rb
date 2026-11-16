# frozen_string_literal: true

require "spec_helper"

# ApplicationController's filters that act on a signed-in request before any action runs: check_suspended
# (a suspended user's write is refused) and invalidate_session_if_necessary on a host that is not the
# app's. Recorded for the Next.js port (PARITY_RECORD=1) and replayed in process by
# nextjs/parity/__tests__/signed-in-filters.replay.test.ts, which sends the last request of each example.
describe "Signed-in filters", type: :request do
  include ActiveSupport::Testing::TimeHelpers

  let(:seller) { create(:user, name: "Signed In Seller") }

  before { host! DOMAIN }

  def csrf_token
    get help_center_category_path(HelpCenter::Category.first)
    page = response.body[/<script[^>]*data-page="[^"]*"[^>]*>(.*?)<\/script>/m, 1] || CGI.unescapeHTML(response.body[/\sdata-page="([^"]*)"/, 1])
    JSON.parse(page).dig("props", "authenticity_token")
  end

  def log_in(user)
    post login_path, params: { authenticity_token: csrf_token, user: { login_identifier: user.email, password: user.password } }
    expect(response).to have_http_status(:found)
  end

  # The state alone: suspending through the model also ends the user's sessions, which would sign this
  # request out before check_suspended looks at it.
  def suspend(user)
    user.update_column(:user_risk_state, "suspended_for_fraud")
  end

  describe "check_suspended" do
    let(:switch_params) { { team_membership_id: "none" } }

    # A suspended user's pages are not worth reading a token from, so it is read first.
    let!(:token) do
      log_in(seller)
      csrf_token.tap { suspend(seller) }
    end

    def switch(headers: {}, params: {})
      post sellers_switch_path, params: { authenticity_token: token }.merge(params), headers:
    end

    it "sends a suspended user back where they came from with a warning", parity: true do
      switch(headers: { "Referer" => "http://#{DOMAIN}/dashboard" })

      expect(response).to redirect_to("http://#{DOMAIN}/dashboard")
      expect(flash[:warning]).to eq("You can't perform this action because your account has been suspended.")
    end

    it "sends a suspended user to the home page when there is no referrer", parity: true do
      switch

      expect(response).to redirect_to(root_url)
      expect(flash[:warning]).to eq("You can't perform this action because your account has been suspended.")
    end

    it "does not send a suspended user back to another host", parity: true do
      switch(headers: { "Referer" => "https://example.org/somewhere" })

      expect(response).to redirect_to(root_url)
    end

    it "does not send a suspended user back to a protocol-relative referrer", parity: true do
      switch(headers: { "Referer" => "//example.org/somewhere" })

      expect(response).to redirect_to(root_url)
    end

    it "answers a JSON request with the error", parity: true do
      switch(headers: { "Accept" => "application/json" })

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body).to eq("success" => false, "error_message" => "You can't perform this action because your account has been suspended.")
    end

    it "answers a request with an explicit json format with the error", parity: true do
      post "#{sellers_switch_path}?format=json", params: { authenticity_token: token }

      expect(response.parsed_body["success"]).to eq(false)
    end

    it "answers a request for any other format with an empty 200", parity: true do
      switch(headers: { "Accept" => "text/plain" })

      expect(response).to have_http_status(:ok)
      expect(response.body).to eq("")
    end

    it "answers a request with an unknown format with an empty 200", parity: true do
      post "#{sellers_switch_path}?format=nonsense", params: { authenticity_token: token }

      expect(response).to have_http_status(:ok)
      expect(response.body).to eq("")
    end

    it "redirects an Inertia update with a 303", parity: true do
      put settings_main_path, params: { authenticity_token: token }, headers: { "X-Inertia" => "true", "X-Requested-With" => "XMLHttpRequest", "Referer" => "http://#{DOMAIN}/settings" }

      expect(response).to have_http_status(:see_other)
    end

    it "lets a suspended user read", parity: true do
      get help_center_root_path

      expect(response).to be_successful
    end

    it "lets an impersonating admin write", parity: true do
      admin = create(:admin_user)
      $redis.set(RedisKey.impersonated_user(admin.id), seller.id)
      reset!
      host! DOMAIN
      log_in(admin)

      post sellers_switch_path, params: { authenticity_token: csrf_token, **switch_params }

      expect(response).to have_http_status(:no_content)
    end
  end

  describe "invalidate_session_if_necessary" do
    before { log_in(seller) }

    # A session cookie is scoped to the root domain, so it travels to every subdomain.
    def invalidate_and_visit(subdomain)
      travel_to(2.seconds.from_now) { seller.invalidate_active_sessions! }
      host! "#{subdomain}.#{ROOT_DOMAIN}"
      get "/healthcheck"
    end

    it "signs the user out of a request to another host and carries on", parity: true do
      invalidate_and_visit("api")

      expect(response).to have_http_status(:ok)
      expect(response.body).to eq("healthcheck")
      expect(response.headers["Location"]).to be_nil
      expect(Array(response.headers["Set-Cookie"]).join("\n")).to include("remember_user_token=;")
    end

    it "signs the user out of a request to a seller's subdomain and carries on", parity: true do
      invalidate_and_visit("somebody")

      expect(response).to have_http_status(:ok)
      expect(flash[:warning]).to be_nil
    end

    it "leaves a user whose session is current alone", parity: true do
      host! "api.#{ROOT_DOMAIN}"
      get "/healthcheck"

      expect(response).to have_http_status(:ok)
      expect(Array(response.headers["Set-Cookie"]).join("\n")).not_to include("remember_user_token=;")
    end
  end
end
