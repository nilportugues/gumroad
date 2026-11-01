# frozen_string_literal: true

# Produces nextjs/src/server/models/__fixtures__/social-connect-funnel.golden.json: SocialConnectFunnel.record_offers!
# run by the real service against a scratch database, with every statement it sends. Run it like url-redirect-writes.rb.
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/server/models/__fixtures__/social-connect-funnel.golden.json")
NOW = Time.utc(2025, 11, 1, 12, 30, 45, 123_000)
SEEDED_AT = "2025-01-01 00:00:00"
TABLES = %w[users events].freeze

def user_row(id) = { id:, email: "user#{id}@example.com", username: "user#{id}", flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }

def offered_row(id, provider, surface: "getting_started")
  { id:, user_id: 1, event_name: "social_connect_offered", parent_referrer: provider, view_url: surface, created_at: SEEDED_AT, updated_at: SEEDED_AT }
end

def run(name, seed: {}, &block) = capture(name, now: NOW, tables: TABLES, seed: { users: [user_row(1)] }.merge(seed), &block)

x = { name: "X", connected: false }
youtube = { name: "YouTube", connected: false }
tiktok = { name: "TikTok", connected: true }

cases = []
cases << run("offers every unconnected provider") { SocialConnectFunnel.record_offers!(user: User.find(1), connections: [x, youtube, tiktok], surface: "getting_started") }
cases << run("skips a provider already offered", seed: { events: [offered_row(1, "twitter")] }) do
  SocialConnectFunnel.record_offers!(user: User.find(1), connections: [x, youtube], surface: "getting_started")
end
cases << run("offers again on another surface", seed: { events: [offered_row(1, "twitter", surface: "profile")] }) do
  SocialConnectFunnel.record_offers!(user: User.find(1), connections: [x], surface: "getting_started")
end
cases << run("does nothing when skipped") { SocialConnectFunnel.record_offers!(user: User.find(1), connections: [x], surface: "getting_started", skip: true) }
cases << run("does nothing without connections") { SocialConnectFunnel.record_offers!(user: User.find(1), connections: nil, surface: "getting_started") }
cases << run("ignores a connection without a known provider") do
  SocialConnectFunnel.record_offers!(user: User.find(1), connections: [{ name: "Mastodon", connected: false }], surface: "getting_started")
end

File.write(OUT, JSON.pretty_generate({ "now" => travel_to(NOW, with_usec: true) { Time.now.to_f }, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
