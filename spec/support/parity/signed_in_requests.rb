# frozen_string_literal: true

# Logs a user in through POST /login so request specs record the cookies a browser holds.
# Forgery protection is on in the test environment, so a page's token is fetched first.
module Parity::SignedInRequests
  def csrf_token_from(path)
    get path
    inertia_props_of(response).fetch("authenticity_token")
  end

  def log_in(user, token_path:)
    post login_path, params: { authenticity_token: csrf_token_from(token_path), user: { login_identifier: user.email, password: user.password } }
    expect(response).to have_http_status(:found)
    expect(set_cookies).to include("remember_user_token=")
  end

  def set_cookies = Array(response.headers["Set-Cookie"]).join("\n")

  def inertia_props_of(response)
    page = response.body[/<script[^>]*data-page="[^"]*"[^>]*>(.*?)<\/script>/m, 1] || CGI.unescapeHTML(response.body[/\sdata-page="([^"]*)"/, 1])
    JSON.parse(page)["props"]
  end
end
