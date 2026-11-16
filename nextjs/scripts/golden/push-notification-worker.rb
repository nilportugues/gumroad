# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/push-notification-worker.golden.json: PushNotificationWorker run by the real app against a
# scratch database as a Sidekiq job (support/sidekiq_executor.rb). The first iOS or Android device reaches PushNotificationService
# (APNs, FCM), which Node hands back to Rails; those cases are recorded up to the call, which a marker exception stands in for. Run it
# like pdf-unstampable-notifier-job.rb (env as in publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/push-notification-worker.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[users devices team_memberships].freeze

Rails.logger = ActiveSupport::Logger.new(nil)

class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

[PushNotificationService::Ios, PushNotificationService::Android].each do |service|
  service.prepend(Module.new do
    def process = raise(HandBackMarker)
  end)
end

def user_row(id, **overrides)
  { id:, email: "seller#{id}@example.com", username: "seller#{id}", external_id: (1000 + id).to_s, recommendation_type: "own_products",
    user_risk_state: "compliant", flags: 0, confirmed_at: nil, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def device_row(id, user_id: 1, **overrides)
  { id:, token: "token#{id}", app_version: "1.0.#{id}", device_type: "ios", user_id:, app_type: "consumer", created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def run(name, args, users: [user_row(1)], devices: [])
  hands_back = false
  result = capture(name, now: NOW, tables: TABLES, seed: { users:, devices: }, sidekiq: true, job: "PushNotificationWorker", args:) do
    PushNotificationWorker.new.perform(*args)
  rescue HandBackMarker
    hands_back = true
  end
  result.delete("rows")
  result.delete("seed")
  result.merge("hands_back" => hands_back)
end

cases = []
cases << run("a receiver that does not exist", [9, "consumer", "Title"])
cases << run("a receiver with no device", [1, "consumer", "Title"])
cases << run("a receiver with an iOS device", [1, "consumer", "Title"], devices: [device_row(1)])
cases << run("a receiver with an Android device", [1, "consumer", "Title"], devices: [device_row(1, device_type: "android")])
cases << run("a receiver with a device of another type", [1, "consumer", "Title"], devices: [device_row(1, device_type: "web")])
cases << run("a receiver with only devices of other types", [1, "consumer", "Title"], devices: [device_row(1, device_type: "web"), device_row(2, device_type: "")])
cases << run("a receiver with a device of another type before an iOS one", [1, "consumer", "Title"], devices: [device_row(1, device_type: "web"), device_row(2)])
cases << run("a receiver with a device of another app", [1, "consumer", "Title"], devices: [device_row(1, app_type: "creator")])
cases << run("a receiver with a creator app device", [1, "creator", "Title"], devices: [device_row(1, app_type: "creator")])
cases << run("devices of other receivers", [1, "consumer", "Title"], devices: [device_row(1, user_id: 2), device_row(2, user_id: 3)])
cases << run("an app type that no device has", [1, "tablet", "Title"], devices: [device_row(1)])
cases << run("an app type of nil", [1, nil, "Title"], devices: [device_row(1)])
cases << run("an app type with a quote", [1, "con'sumer", "Title"], devices: [device_row(1)])
cases << run("a body, data and sound", [1, "consumer", "Title", "Body", { "a" => 1 }, "default"], devices: [device_row(1)])
cases << run("a receiver with no device and every argument", [1, "consumer", "Title", "Body", { "a" => 1 }, "default", false])
cases << run("a receiver id as a digit string with a device of another type", ["1", "consumer", "Title"], devices: [device_row(1, device_type: "web")])
cases << run("a receiver id of nil", [nil, "consumer", "Title"])
cases << run("a receiver id as a float", [1.0, "consumer", "Title"], devices: [device_row(1, device_type: "web")])
cases << run("a receiver id as a word", ["one", "consumer", "Title"])
cases << run("to team admins is true", [1, "consumer", "Title", nil, {}, nil, true], devices: [device_row(1, device_type: "web")])
cases << run("to team admins is false", [1, "consumer", "Title", nil, {}, nil, false], devices: [device_row(1, device_type: "web")])
cases << run("to team admins is nil", [1, "consumer", "Title", nil, {}, nil, nil], devices: [device_row(1, device_type: "web")])
cases << run("to team admins is a word", [1, "consumer", "Title", nil, {}, nil, "yes"], devices: [device_row(1, device_type: "web")])
cases << run("two arguments", [1, "consumer"])
cases << run("eight arguments", [1, "consumer", "Title", nil, {}, nil, false, 1])

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
