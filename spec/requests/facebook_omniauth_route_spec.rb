# frozen_string_literal: true

require "spec_helper"

# config/initializers/rack_attack.rb throttles `/users/auth/facebook`, but no Facebook strategy is configured in devise.rb and the routes file
# has no such route, so the path is a 404 in Rails and nothing in Node (nextjs/src/server/controllers/rack-attack.ts keeps the single counter
# for it). If a strategy is ever added, this spec fails and the port needs a request phase to go with the counter.
describe "Facebook sign-in route", type: :request do
  it "is not an OmniAuth provider" do
    expect(User.omniauth_providers).to match_array(%i[twitter stripe_connect google_oauth2 youtube instagram tiktok apple])
  end

  it "answers a GET with the 404 page of the catch-all route" do
    %w[/users/auth/facebook /users/auth/facebook/callback].each do |path|
      expect(Rails.application.routes.recognize_path(path)).to include(controller: "application", action: "e404_page")
    end
  end

  it "has no route for a POST" do
    %w[/users/auth/facebook /users/auth/facebook/callback].each do |path|
      expect { Rails.application.routes.recognize_path(path, method: "POST") }.to raise_error(ActionController::RoutingError)
    end
  end
end
