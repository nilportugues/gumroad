# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/resend-confirmation-email-job.golden.json: ResendConfirmationEmailJob run by the real app
# against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). A user with something left to confirm is what Node hands
# back to Rails (the SendGrid suppression clearing and the confirmation mail); those cases are recorded up to the suppression call,
# which a marker exception stands in for. Run it like delete-wishlist-products-job.rb:
#
#   bundle exec rails runner nextjs/scripts/golden/resend-confirmation-email-job.rb   (env as in publish-scheduled-post.rb)
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/resend-confirmation-email-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[users].freeze

Rails.logger = ActiveSupport::Logger.new(nil)

class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

EmailSuppressionManager.prepend(Module.new do
  def remove_from_lists(*) = raise(HandBackMarker)
end)

def user_row(id, **overrides)
  { id:, email: "seller#{id}@example.com", username: "seller#{id}", external_id: (1000 + id).to_s, recommendation_type: "own_products",
    user_risk_state: "compliant", flags: 0, confirmed_at: nil, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def run(name, args, seed)
  hands_back = false
  result = capture(name, now: NOW, tables: TABLES, seed:, sidekiq: true, job: "ResendConfirmationEmailJob", args:) do
    ResendConfirmationEmailJob.new.perform(*args)
  rescue HandBackMarker
    hands_back = true
  end
  result.delete("rows")
  result.delete("seed")
  result.merge("hands_back" => hands_back)
end

cases = []
cases << run("a user that does not exist", [9], { users: [user_row(1)] })
cases << run("a deleted user", [1], { users: [user_row(1, deleted_at: SEEDED_AT)] })
cases << run("a user who confirmed", [1], { users: [user_row(1, confirmed_at: SEEDED_AT)] })
cases << run("a user who confirmed with a blank pending address", [1], { users: [user_row(1, confirmed_at: SEEDED_AT, unconfirmed_email: "")] })
cases << run("a user who has not confirmed", [1], { users: [user_row(1)] })
cases << run("a user who confirmed and has a pending address", [1], { users: [user_row(1, confirmed_at: SEEDED_AT, unconfirmed_email: "new@example.com")] })
cases << run("a user who has not confirmed and has a pending address", [1], { users: [user_row(1, unconfirmed_email: "new@example.com")] })
cases << run("a user id as a digit string", ["1"], { users: [user_row(1, confirmed_at: SEEDED_AT)] })
cases << run("a user id of nil", [nil], { users: [user_row(1, confirmed_at: SEEDED_AT)] })
cases << run("a user id as a float", [1.0], { users: [user_row(1, confirmed_at: SEEDED_AT)] })
cases << run("a user id as a word", ["one"], { users: [user_row(1, confirmed_at: SEEDED_AT)] })

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
