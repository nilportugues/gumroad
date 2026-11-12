# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/update-purchase-email-to-match-account-worker.golden.json:
# UpdatePurchaseEmailToMatchAccountWorker run by the real app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb).
# A user with purchases reaches Purchase#update!, whose validations and callbacks Node does not run: those cases are recorded in full,
# and Node hands them back right after the first find_each batch. Run it like seller-update-worker.rb (env as in publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/update-purchase-email-to-match-account-worker.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[users purchases versions].freeze

Rails.logger = ActiveSupport::Logger.new(nil)
ActiveJob::Base.queue_adapter = :sidekiq
ActiveJob::Base.logger = Logger.new(nil)

def user_row(id, **overrides) = { id:, email: "user#{id}@example.com", username: "user#{id}", external_id: (1000 + id).to_s, confirmed_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)

def purchase_row(id, purchaser: 1, **overrides)
  { id:, link_id: 1, seller_id: 2, purchaser_id: purchaser, email: "old#{id}@example.com", purchase_state: "successful", price_cents: 1000, fee_cents: 100, flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def run(name, seed, id = 1)
  result = capture(name, now: NOW, tables: TABLES, seed:, sidekiq: true, job: "UpdatePurchaseEmailToMatchAccountWorker", args: [id], at: NOW.to_f) do
    UpdatePurchaseEmailToMatchAccountWorker.new.perform(id)
  end
  result.delete("seed")
  result
end

cases = []
cases << run("a user that does not exist", {}, 9)
cases << run("a user with no purchases", { users: [user_row(1)] })
cases << run("a user whose only purchases belong to another buyer", { users: [user_row(1), user_row(3)], purchases: [purchase_row(1, purchaser: 3), purchase_row(2, purchaser: nil)] })
cases << run("a user id given as a digit string and no purchases", { users: [user_row(1)] }, "1")
cases << run("a user id of nil", { users: [user_row(1)] }, nil)
cases << run("a user with a purchase", { users: [user_row(1)], purchases: [purchase_row(1)] })
cases << run("a user with a purchase already on the account email", { users: [user_row(1)], purchases: [purchase_row(1, email: "user1@example.com")] })
cases << run("a user with purchases and one of another buyer", { users: [user_row(1)], purchases: [purchase_row(1), purchase_row(2, purchaser: 3), purchase_row(3)] })
cases << run("a user id given as a digit string and a purchase", { users: [user_row(1)], purchases: [purchase_row(1)] }, "1")
cases << run("a user id given as a float", { users: [user_row(1)] }, 1.0)
cases << run("a user id given as a word", { users: [user_row(1)] }, "abc")

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
