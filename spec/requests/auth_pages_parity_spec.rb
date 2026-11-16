# frozen_string_literal: true

require "spec_helper"

# The GET renders of the authentication pages (login, signup, two-factor, secure redirect), recorded
# for the Next.js port (PARITY_RECORD=1) through the full Rack stack, signed out and signed in. Replayed
# by nextjs/parity/__tests__/auth-pages.replay.test.ts, which sends the last request of each example.
describe "Authentication pages", type: :request do
  let(:seller) { create(:user, name: "Signed In Seller") }
  let(:header_login_path) { login_path }

  before { host! DOMAIN }

  # Forgery protection is on in the test environment, so a page's token is fetched first. Any
  # signed-out page will do.
  def csrf_token
    get help_center_category_path(HelpCenter::Category.first)
    inertia_props_of(response).fetch("authenticity_token")
  end

  def log_in(user)
    post login_path, params: { authenticity_token: csrf_token, user: { login_identifier: user.email, password: user.password } }
    expect(response).to have_http_status(:found)
  end

  def set_cookies = Array(response.headers["Set-Cookie"]).join("\n")

  def inertia_props_of(response)
    page = response.body[/<script[^>]*data-page="[^"]*"[^>]*>(.*?)<\/script>/m, 1] || CGI.unescapeHTML(response.body[/\sdata-page="([^"]*)"/, 1])
    JSON.parse(page)["props"]
  end

  describe "GET /login" do
    it "renders the login page", parity: true do
      get login_path

      expect(response).to be_successful
      expect(inertia_props_of(response)).to include("email" => nil, "application_name" => nil, "is_gumroad_mobile_app" => false)
    end

    it "prefills the email from the query", parity: true do
      get login_path(email: "buyer@example.com")

      expect(response).to be_successful
      expect(inertia_props_of(response)["email"]).to eq("buyer@example.com")
    end

    it "names the OAuth application and asks search engines to skip the page", parity: true do
      application = create(:oauth_application, name: "Parity Connect")
      get login_path(next: oauth_authorization_path(client_id: application.uid, redirect_uri: application.redirect_uri, scope: "edit_products"))

      expect(response).to be_successful
      expect(response.headers["X-Robots-Tag"]).to eq("noindex")
      expect(inertia_props_of(response)["application_name"]).to eq("Parity Connect")
    end

    it "skips the application name when the client is unknown", parity: true do
      get login_path(next: "/oauth/authorize?client_id=does-not-exist&scope=edit_products")

      expect(response).to be_successful
      expect(response.headers["X-Robots-Tag"]).to eq("noindex")
      expect(inertia_props_of(response)["application_name"]).to be_nil
    end

    it "ignores a deleted OAuth application", parity: true do
      application = create(:oauth_application, name: "Parity Deleted", deleted_at: Time.current)
      get login_path(next: "/oauth/authorize?client_id=#{application.uid}")

      expect(response).to be_successful
      expect(inertia_props_of(response)["application_name"]).to be_nil
    end

    it "prefills the email of a team invitation", parity: true do
      get login_path(next: "/settings/team/invitations/abc/accept?email=invitee%40example.com")

      expect(response).to be_successful
      expect(inertia_props_of(response)["email"]).to eq("invitee@example.com")
    end

    it "does not prefill the email of any other next path", parity: true do
      get login_path(next: "/dashboard?email=invitee%40example.com")

      expect(response).to be_successful
      expect(inertia_props_of(response)["email"]).to be_nil
    end

    it "prefers the email param over the invitation's", parity: true do
      get login_path(email: "typed@example.com", next: "/settings/team/invitations/abc/accept?email=invitee%40example.com")

      expect(inertia_props_of(response)["email"]).to eq("typed@example.com")
    end

    it "sends a visitor who came from another page back with that page as next", parity: true do
      get login_path, headers: { "Referer" => "http://#{DOMAIN}/products/new" }

      expect(response).to redirect_to(login_path(next: "http://#{DOMAIN}/products/new"))
    end

    it "renders when the referrer is the home page", parity: true do
      get login_path, headers: { "Referer" => "http://#{DOMAIN}/" }

      expect(response).to be_successful
    end

    it "renders when the referrer is the signup page", parity: true do
      get login_path, headers: { "Referer" => signup_url }

      expect(response).to be_successful
    end

    it "renders when the referrer is the login page", parity: true do
      get login_path, headers: { "Referer" => login_url(next: "/dashboard") }

      expect(response).to be_successful
    end

    it "renders when the referrer is the two-factor page", parity: true do
      get login_path, headers: { "Referer" => two_factor_authentication_url }

      expect(response).to be_successful
    end

    it "does not redirect on a referrer when next is given", parity: true do
      get login_path(next: "/library"), headers: { "Referer" => "http://#{DOMAIN}/products/new" }

      expect(response).to be_successful
    end

    it "flags the mobile app from its cookie", parity: true do
      cookies[:is_gumroad_mobile_app] = "true"
      get login_path

      expect(inertia_props_of(response)["is_gumroad_mobile_app"]).to eq(true)
    end

    it "redirects an unparseable next back to a bare login page", parity: true do
      get login_path(next: "http://bad host/path")

      expect(response).to redirect_to(login_path)
    end

    it "serves the OAuth login alias", parity: true do
      get "/oauth/login"

      expect(response).to be_successful
    end

    it "shows the flash set by a failed login", parity: true do
      post login_path, params: { authenticity_token: csrf_token, user: { login_identifier: "nobody@example.com", password: "wrong" } }
      expect(response).to have_http_status(:see_other)

      get login_path

      expect(response).to be_successful
      expect(inertia_props_of(response)["flash"]).to eq("message" => "An account does not exist with that email.", "status" => "warning")
    end

    it "answers an Inertia visit with the page as JSON", parity: true do
      get login_path, headers: { "X-Inertia" => "true", "X-Requested-With" => "XMLHttpRequest", "Accept" => "text/html, application/xhtml+xml" }

      expect(response).to be_successful
      expect(response.parsed_body["component"]).to eq("Logins/New")
    end

    it "answers an Inertia visit carrying a stale asset version with the 409", parity: true do
      get login_path, headers: { "X-Inertia" => "true", "X-Inertia-Version" => "stale", "X-Requested-With" => "XMLHttpRequest", "Accept" => "text/html, application/xhtml+xml" }

      expect(response).to have_http_status(:conflict)
      expect(response.headers["X-Inertia-Location"]).to eq(login_url)
    end

    it "answers a signed-in Inertia visit with a stale asset version with the 409", parity: true do
      log_in(seller)

      get login_path, headers: { "X-Inertia" => "true", "X-Inertia-Version" => "stale", "X-Requested-With" => "XMLHttpRequest", "Accept" => "text/html, application/xhtml+xml" }

      expect(response).to have_http_status(:conflict)
    end

    it "refuses a JSON request", parity: true do
      get "/login", headers: { "Accept" => "application/json" }

      expect(response).to have_http_status(:bad_request)
    end

    it "sends a signed-in seller to the dashboard", parity: true do
      log_in(seller)

      get login_path

      expect(response).to redirect_to(dashboard_path)
    end

    it "sends a signed-in buyer to the library", parity: true do
      buyer = create(:user)
      create(:free_purchase, purchaser: buyer)
      log_in(buyer)

      get login_path

      expect(response).to redirect_to(library_path)
    end

    it "sends a signed-in visitor to next", parity: true do
      log_in(seller)

      get login_path(next: "/products")

      expect(response).to redirect_to("/products")
    end

    it "keeps a signed-in visitor off an external next", parity: true do
      log_in(seller)

      get login_path(next: "https://evil.example.com/steal")

      expect(response).to redirect_to("/steal")
    end

    it "sends a signed-in visitor to the OAuth login alias target", parity: true do
      log_in(seller)

      get "/oauth/login"

      expect(response).to redirect_to(dashboard_path)
    end
  end

  describe "GET /signup" do
    it "renders the signup page with the platform stats", parity: true do
      $redis.set(RedisKey.number_of_creators, "1234")
      $redis.set(RedisKey.total_made, "5678900")
      get signup_path

      expect(response).to be_successful
      expect(inertia_props_of(response)["stats"]).to eq("number_of_creators" => 1234, "total_made" => 5_678_900)
    end

    it "renders zeros when the stats were never computed", parity: true do
      get signup_path

      expect(inertia_props_of(response)["stats"]).to eq("number_of_creators" => 0, "total_made" => 0)
    end

    it "names the referrer", parity: true do
      referrer = create(:user, username: "parityreferrer", name: "Parity Referrer")
      get signup_path(referrer: referrer.username)

      expect(inertia_props_of(response)["referrer"]).to eq("id" => referrer.external_id, "name" => "Parity Referrer")
    end

    it "ignores an unknown referrer", parity: true do
      get signup_path(referrer: "no-such-user")

      expect(inertia_props_of(response)["referrer"]).to be_nil
    end

    it "names the OAuth application", parity: true do
      application = create(:oauth_application, name: "Parity Connect")
      get signup_path(next: "/oauth/authorize?client_id=#{application.uid}&scope=edit_products")

      expect(response.headers["X-Robots-Tag"]).to eq("noindex")
      expect(inertia_props_of(response)["application_name"]).to eq("Parity Connect")
    end

    it "prefills the email and flags the mobile app", parity: true do
      cookies[:is_gumroad_mobile_app] = "true"
      get signup_path(email: "new@example.com")

      expect(inertia_props_of(response)).to include("email" => "new@example.com", "is_gumroad_mobile_app" => true)
    end

    it "remembers an external referrer for the signup", parity: true do
      get signup_path, headers: { "Referer" => "https://blog.example.org/post" }

      expect(response).to be_successful
    end

    it "answers an Inertia visit with the page as JSON", parity: true do
      get signup_path, headers: { "X-Inertia" => "true", "X-Requested-With" => "XMLHttpRequest", "Accept" => "text/html, application/xhtml+xml" }

      expect(response).to be_successful
      expect(response.parsed_body["component"]).to eq("Signup/New")
    end

    it "redirects an unparseable next to the login page", parity: true do
      get signup_path(next: "http://bad host/path")

      expect(response).to redirect_to(login_path)
    end

    it "shows the flash set by a failed signup", parity: true do
      post signup_path, params: { authenticity_token: csrf_token, user: { email: "", password: "" } }
      expect(response).to have_http_status(:see_other)

      get signup_path

      expect(inertia_props_of(response)["flash"]).to eq("message" => "Please provide a valid email address.", "status" => "warning")
    end

    it "sends a signed-in seller to the dashboard", parity: true do
      log_in(seller)

      get signup_path

      expect(response).to redirect_to(dashboard_path)
    end

    it "sends a signed-in visitor to next", parity: true do
      log_in(seller)

      get signup_path(next: "/products")

      expect(response).to redirect_to("/products")
    end
  end

  describe "GET /two-factor" do
    let(:user) { create(:user, two_factor_authentication_enabled: true) }

    def start_two_factor_login
      post login_path, params: { authenticity_token: csrf_token, user: { login_identifier: user.email, password: user.password } }
      expect(response.location).to start_with(two_factor_authentication_url)
    end

    it "sends a visitor without a pending login to the login page", parity: true do
      get two_factor_authentication_path

      expect(response).to have_http_status(:see_other)
      expect(response).to redirect_to(login_path(next: "/two-factor"))
      expect(flash[:warning]).to eq("Your login session expired. Please sign in again.")
    end

    it "keeps the query in the next param of that redirect", parity: true do
      get "/two-factor?next=/dashboard"

      expect(response).to redirect_to(login_path(next: "/two-factor?next=/dashboard"))
    end

    it "renders the challenge for a pending email login", parity: true do
      start_two_factor_login

      get two_factor_authentication_path

      expect(response).to be_successful
      props = inertia_props_of(response)
      expect(props).to include("user_id" => user.encrypted_external_id, "email" => user.email, "two_factor_method" => "email")
      expect(props["token_sent_at"]).to be_a(Integer)
    end

    it "renders the challenge for a pending authenticator login", parity: true do
      create(:totp_credential, :confirmed, user:)
      start_two_factor_login

      get two_factor_authentication_path

      expect(response).to be_successful
    end

    it "shows the flash of a rejected token", parity: true do
      start_two_factor_login
      post two_factor_authentication_path(user_id: user.encrypted_external_id), params: { authenticity_token: csrf_token, token: "123457" }
      expect(response).to redirect_to(two_factor_authentication_path)

      get two_factor_authentication_path

      expect(inertia_props_of(response)["flash"]).to eq("message" => "Invalid token, please try again.", "status" => "warning")
    end

    it "shows the recovery step", parity: true do
      start_two_factor_login
      post switch_to_recovery_two_factor_path(user_id: user.encrypted_external_id), params: { authenticity_token: csrf_token }

      get two_factor_authentication_path

      expect(inertia_props_of(response)["two_factor_method"]).to eq("recovery")
    end

    it "shows the resend cooldown after the token was resent", parity: true do
      start_two_factor_login
      post resend_authentication_token_path(user_id: user.encrypted_external_id), params: { authenticity_token: csrf_token }

      get two_factor_authentication_path

      expect(inertia_props_of(response)["flash"]).to include("status" => "success")
    end

    it "answers an Inertia visit with the page as JSON", parity: true do
      start_two_factor_login

      get two_factor_authentication_path, headers: { "X-Inertia" => "true", "X-Requested-With" => "XMLHttpRequest", "Accept" => "text/html, application/xhtml+xml" }

      expect(response).to be_successful
      expect(response.parsed_body["component"]).to eq("TwoFactorAuthentication/Show")
    end

    it "sends a signed-in visitor on", parity: true do
      log_in(seller)

      get two_factor_authentication_path

      expect(response).to have_http_status(:see_other)
      expect(response).to redirect_to(dashboard_path)
    end
  end

  describe "GET /secure_url_redirect" do
    let(:payload) { "opaque-encrypted-payload" }

    it "sends a visitor without a payload to the home page", parity: true do
      get secure_url_redirect_path

      expect(response).to redirect_to(root_path)
    end

    it "renders with the default copy", parity: true do
      get secure_url_redirect_path(encrypted_payload: payload)

      expect(response).to be_successful
      expect(inertia_props_of(response)).to include(
        "message" => "Please enter the confirmation text to continue to your destination.",
        "field_name" => "Confirmation text",
        "error_message" => "Confirmation text does not match",
        "encrypted_payload" => payload
      )
    end

    it "renders with the given copy", parity: true do
      get secure_url_redirect_path(encrypted_payload: payload, message: "Enter your email", field_name: "Email", error_message: "Wrong email")

      expect(inertia_props_of(response)).to include("message" => "Enter your email", "field_name" => "Email", "error_message" => "Wrong email")
    end

    it "falls back to the default copy for blank params", parity: true do
      get secure_url_redirect_path(encrypted_payload: payload, message: "", field_name: "", error_message: "")

      expect(inertia_props_of(response)["field_name"]).to eq("Confirmation text")
    end

    it "shows the alert of a failed confirmation", parity: true do
      get secure_url_redirect_path(encrypted_payload: payload)
      post secure_url_redirect_path, params: { authenticity_token: inertia_props_of(response).fetch("authenticity_token"), encrypted_payload: payload, confirmation_text: "" }
      expect(response).to have_http_status(:found)

      get secure_url_redirect_path(encrypted_payload: payload)

      expect(inertia_props_of(response)["flash"]).to eq("message" => "Please enter the confirmation text", "status" => "danger")
    end

    it "answers an Inertia visit with the page as JSON", parity: true do
      get secure_url_redirect_path(encrypted_payload: payload), headers: { "X-Inertia" => "true", "X-Requested-With" => "XMLHttpRequest", "Accept" => "text/html, application/xhtml+xml" }

      expect(response).to be_successful
      expect(response.parsed_body["props"]).to include("encrypted_payload" => payload)
    end

    it "answers a stale Inertia visit that a filter would redirect with the 409", parity: true do
      get secure_url_redirect_path, headers: { "X-Inertia" => "true", "X-Inertia-Version" => "stale", "X-Requested-With" => "XMLHttpRequest", "Accept" => "text/html, application/xhtml+xml" }

      expect(response).to have_http_status(:conflict)
    end

    it "renders for a signed-in seller", parity: true do
      log_in(seller)

      get secure_url_redirect_path(encrypted_payload: payload)

      expect(response).to be_successful
      expect(inertia_props_of(response)["logged_in_user"]).to include("email" => seller.email)
    end

    it "sends a signed-in visitor without a payload to the home page", parity: true do
      log_in(seller)

      get secure_url_redirect_path

      expect(response).to redirect_to(root_path)
    end
  end
end
