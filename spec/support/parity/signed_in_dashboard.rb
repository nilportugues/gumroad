# frozen_string_literal: true

# Real-login helpers for the request specs recorded for the Next.js dashboard pages (PARITY_RECORD=1):
# a browser's session, remember and current_seller_id cookies, with forgery protection on.
module Parity
  module SignedInDashboard
    def self.included(base)
      base.before { host! DOMAIN }
    end

    # Forgery protection is on in the test environment, so a page's token is fetched first. The login
    # page redirects a signed-in visitor, so any page will do.
    def csrf_token
      get help_center_category_path(HelpCenter::Category.first)
      inertia_props_of(response).fetch("authenticity_token")
    end

    def log_in(user)
      post login_path, params: { authenticity_token: csrf_token, user: { login_identifier: user.email, password: user.password } }
      expect(response).to have_http_status(:found)
      expect(set_cookies).to include("remember_user_token=")
    end

    def switch_to(team_membership)
      post sellers_switch_path, params: { authenticity_token: csrf_token, team_membership_id: team_membership.external_id }
      expect(response).to have_http_status(:no_content)
    end

    def inertia_visit(path)
      get path, headers: { "X-Inertia" => "true", "X-Requested-With" => "XMLHttpRequest" }
    end

    def set_cookies = Array(response.headers["Set-Cookie"]).join("\n")

    def inertia_props_of(response)
      page = response.body[/<script[^>]*data-page="[^"]*"[^>]*>(.*?)<\/script>/m, 1] || CGI.unescapeHTML(response.body[/\sdata-page="([^"]*)"/, 1])
      JSON.parse(page)["props"]
    end
  end
end
