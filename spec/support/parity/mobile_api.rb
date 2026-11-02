# frozen_string_literal: true

module Parity
  # Request spec helpers for the mobile API on the API host (Api::Mobile::*Controller), recorded for the Next.js port.
  module MobileApi
    def self.included(base)
      base.before { host! API_DOMAIN }
    end

    def mobile_token = Api::Mobile::BaseController::MOBILE_TOKEN

    def mobile_application
      @mobile_application ||= create(:oauth_application, owner: create(:user))
    end

    def token_for(owner, scopes: "mobile_api", **attributes)
      create("doorkeeper/access_token", application: mobile_application, resource_owner_id: owner.id, scopes:, **attributes).token
    end

    def auth(owner, **options)
      { mobile_token:, access_token: token_for(owner, **options) }
    end

    # The purchase factories charge a card through Stripe; the row is all these endpoints read.
    def purchase_row(factory = :purchase, **attributes)
      build(factory, **attributes).tap { |row| row.save!(validate: false) }
    end
  end
end
