# frozen_string_literal: true

# Produces nextjs/src/server/models/__fixtures__/send-authentication-token.golden.json: the real
# User#send_authentication_token! (app/models/concerns/two_factor_authentication.rb), which picks the
# email provider from EmailRouterFallbackService and queues the TwoFactorAuthenticationMailer job. Run
# it like user-writes.rb, adding USE_DB_WORKER_REPLICAS=true.
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/server/models/__fixtures__/send-authentication-token.golden.json")
NOW = Time.utc(2025, 11, 1, 12, 30, 45, 123_000)
SEEDED_AT = "2025-01-01 00:00:00"
FEATURE = :resend_fallback_for_auth_emails

$uuid_seq = 0
SecureRandom.singleton_class.prepend(Module.new do
  def uuid
    $uuid_seq += 1
    format("00000000-0000-4000-8000-%012d", $uuid_seq)
  end
end)
ActiveJob::Base.queue_adapter = :sidekiq
ActiveJob::Base.logger = Logger.new(nil)
ActionMailer::Base.deliver_later_queue_name = :default

def user_row(id, **overrides)
  {
    id:, email: "user#{id}@example.com", username: "user#{id}", external_id: (1000 + id).to_s, recommendation_type: "own_products",
    user_risk_state: "compliant", flags: 0, json_data: nil, confirmed_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT
  }.merge(overrides)
end

def run(name, user: user_row(5), feature: false, fallback_key: false)
  $uuid_seq = 0
  loaded = nil
  setup = lambda do
    Feature.activate(FEATURE) if feature
    $redis.set(RedisKey.email_router_fallback(5), "recorded") if fallback_key
    loaded = User.find(5)
  end
  capture(name, now: NOW, tables: %w[users], seed: { users: [user] }, setup:, sidekiq: true, feature:, fallback_key:, email: user[:email]) do
    loaded.send_authentication_token!
  end
end

cases = []
cases << run("the fallback feature is off")
cases << run("the feature is off and a fallback key exists", fallback_key: true)
cases << run("the feature is on and nothing was sent yet", feature: true)
cases << run("the feature is on and an email was sent a moment ago", feature: true, fallback_key: true)
cases << run("a web.de address stays on the default provider", user: user_row(5, email: "member@web.de"), feature: true, fallback_key: true)
cases << run("a GMX address with surrounding spaces stays on the default provider", user: user_row(5, email: " Member <member@GMX.net> "), feature: true, fallback_key: true)
cases << run("a user without an email", user: user_row(5, email: nil), feature: true, fallback_key: true)

now_f = travel_to(NOW, with_usec: true) { Time.now.to_f }
File.write(OUT, JSON.pretty_generate({ "now" => now_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
