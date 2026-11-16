# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/generate-subscribe-preview-job.golden.json: GenerateSubscribePreviewJob run by the real
# app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb), and the block of its sidekiq_retries_exhausted
# (`perform` again without the avatar requirement). A user that exists reaches `SubscribePreviewGeneratorService.generate_pngs`
# (image generation), which Node hands back; those cases are recorded up to there, which a marker exception stands in for
# (`hands_back`). Run it like pdf-unstampable-notifier-job.rb (env as in publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/generate-subscribe-preview-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[users].freeze

Rails.logger = ActiveSupport::Logger.new(nil)

class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

SubscribePreviewGeneratorService.singleton_class.prepend(Module.new do
  def generate_pngs(*, **) = raise(HandBackMarker)
end)

def user_row(id, **overrides)
  { id:, email: "seller#{id}@example.com", username: "seller#{id}", external_id: (1000 + id).to_s, recommendation_type: "own_products",
    user_risk_state: "compliant", flags: 0, confirmed_at: nil, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def run(name, args, *users, hook: false)
  hands_back = false
  extra = hook ? { hook: true } : {}
  result = capture(name, now: NOW, tables: TABLES, seed: { users: }, sidekiq: true, job: "GenerateSubscribePreviewJob", args:, **extra) do
    if hook
      GenerateSubscribePreviewJob.sidekiq_retries_exhausted_block.call({ "args" => args }, StandardError.new("boom"))
    else
      GenerateSubscribePreviewJob.new.perform(*args)
    end
  rescue HandBackMarker
    hands_back = true
  end
  result.delete("rows")
  result.delete("seed")
  result.merge("hands_back" => hands_back)
end

cases = []
[false, true].each do |hook|
  prefix = hook ? "exhausted: " : ""
  cases << run("#{prefix}a user that does not exist", [9], hook:)
  cases << run("#{prefix}a user that does not exist among others", [9], user_row(1), user_row(2), hook:)
  cases << run("#{prefix}a user", [1], user_row(1), hook:)
  cases << run("#{prefix}a user among others", [2], user_row(1), user_row(2), user_row(3), hook:)
  cases << run("#{prefix}a deleted user", [1], user_row(1, deleted_at: SEEDED_AT), hook:)
  cases << run("#{prefix}a user id as a digit string", ["1"], user_row(1), hook:)
  cases << run("#{prefix}a user id of nil", [nil], user_row(1), hook:)
  cases << run("#{prefix}a user id as a float", [1.0], user_row(1), hook:)
  cases << run("#{prefix}a user id as a word", ["one"], user_row(1), hook:)
  cases << run("#{prefix}no arguments", [], user_row(1), hook:)
  cases << run("#{prefix}one argument too many", [1, 1], user_row(1), hook:)
end

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
