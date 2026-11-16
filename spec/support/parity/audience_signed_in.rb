# frozen_string_literal: true

module Parity
  # Request spec helpers for the signed-in audience pages (workflows, emails, followers, UTM links)
  # recorded for the Next.js port: a real login through POST /login, so the session and remember
  # cookies in the fixture are the ones a browser holds.
  module AudienceSignedIn
    # Forgery protection is on in the test environment, so a page's token is fetched first. The login
    # page redirects a signed-in visitor, so any public page will do.
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

    def set_cookies = Array(response.headers["Set-Cookie"]).join("\n")

    def inertia_page_of(response)
      page = response.body[/<script[^>]*data-page="[^"]*"[^>]*>(.*?)<\/script>/m, 1] || CGI.unescapeHTML(response.body[/\sdata-page="([^"]*)"/, 1])
      JSON.parse(page)
    end

    def inertia_props_of(response) = inertia_page_of(response)["props"]
  end
end
