# frozen_string_literal: true

# Calls the v2 API through the full Rack stack the way a client does: a bearer token, on the API host (`/v2/...`) or under
# `/api/v2/...` on the Gumroad domain. Request specs that record fixtures for the Next.js port use it.
module Parity
  module ApiV2Requests
    def api_application
      @api_application ||= create(:oauth_application, owner: create(:user))
    end

    def api_token(owner, scopes: "edit_products", **attributes)
      create("doorkeeper/access_token", application: api_application, resource_owner_id: owner.id, scopes:, **attributes)
    end

    def api_headers(token = nil, extra = {})
      (token ? { "Authorization" => "Bearer #{token.token}" } : {}).merge(extra)
    end

    def api_call(verb, path, token: nil, params: {}, as: nil, headers: {}, api_host: true)
      host! api_host ? API_DOMAIN : DOMAIN
      prefix = api_host ? "/v2" : "/api/v2"
      public_send(verb, "#{prefix}#{path}", params:, headers: api_headers(token, headers), as:)
    end
  end
end
