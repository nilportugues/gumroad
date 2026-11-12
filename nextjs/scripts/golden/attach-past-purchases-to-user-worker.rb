# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/attach-past-purchases-to-user-worker.golden.json: AttachPastPurchasesToUserWorker run by the
# real app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). The first purchase to attach reaches
# Purchase#attach_to_user_and_card (writes), which Node hands back to Rails; those cases are recorded up to it, which a marker exception
# stands in for. Run it like pdf-unstampable-notifier-job.rb (env as in publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/attach-past-purchases-to-user-worker.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[users purchases].freeze

Rails.logger = ActiveSupport::Logger.new(nil)

class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

Purchase.prepend(Module.new do
  def attach_to_user_and_card(*) = raise(HandBackMarker)
end)

def user_row(id, **overrides)
  { id:, email: "seller#{id}@example.com", username: "seller#{id}", external_id: (1000 + id).to_s, recommendation_type: "own_products",
    user_risk_state: "compliant", flags: 0, confirmed_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def purchase_row(id, email, **overrides)
  { id:, link_id: 1, seller_id: 9, email:, purchase_state: "successful", price_cents: 100, flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def run(name, args, users: [user_row(1)], purchases: [])
  hands_back = false
  result = capture(name, now: NOW, tables: TABLES, seed: { users:, purchases: }, sidekiq: true, job: "AttachPastPurchasesToUserWorker", args:) do
    AttachPastPurchasesToUserWorker.new.perform(*args)
  rescue HandBackMarker
    hands_back = true
  end
  result.delete("rows")
  result.delete("seed")
  result.merge("hands_back" => hands_back)
end

mine = "seller1@example.com"
cases = []
cases << run("a user that does not exist", [9])
cases << run("a confirmed user with no past purchase", [1])
cases << run("a confirmed user with a past purchase", [1], purchases: [purchase_row(1, mine)])
cases << run("a confirmed user with past purchases", [1], purchases: [purchase_row(1, mine), purchase_row(2, mine), purchase_row(3, "other@example.com")])
cases << run("a confirmed user whose past purchase is attached already", [1], purchases: [purchase_row(1, mine, purchaser_id: 1)])
cases << run("a confirmed user whose past purchase is another buyer's", [1], purchases: [purchase_row(1, mine, purchaser_id: 5)])
cases << run("a confirmed user with purchases of other emails", [1], purchases: [purchase_row(1, "other@example.com")])
cases << run("an unconfirmed user", [1], users: [user_row(1, confirmed_at: nil)], purchases: [purchase_row(1, mine)])
cases << run("an unconfirmed user with an email", [1, mine], users: [user_row(1, confirmed_at: nil)], purchases: [purchase_row(1, mine)])
cases << run("an unconfirmed user with an email and no past purchase", [1, mine], users: [user_row(1, confirmed_at: nil)])
cases << run("an unconfirmed user with another email", [1, "other@example.com"], users: [user_row(1, confirmed_at: nil)], purchases: [purchase_row(1, "other@example.com")])
cases << run("a confirmed user with another email", [1, "other@example.com"], purchases: [purchase_row(1, mine), purchase_row(2, "other@example.com")])
cases << run("a confirmed user with an email that has a quote", [1, "o'brien@example.com"], purchases: [purchase_row(1, "o'brien@example.com")])
cases << run("a confirmed user with no email on file", [1], users: [user_row(1, email: "")], purchases: [purchase_row(1, "")])
cases << run("an unconfirmed user with no email on file", [1], users: [user_row(1, email: "", confirmed_at: nil)], purchases: [purchase_row(1, "")])
cases << run("an email of nil", [1, nil], users: [user_row(1, confirmed_at: nil)], purchases: [purchase_row(1, mine)])
cases << run("an email of nil for a confirmed user", [1, nil], purchases: [purchase_row(1, mine)])
cases << run("an empty email", [1, ""], purchases: [purchase_row(1, mine), purchase_row(2, "")])
cases << run("an email of spaces", [1, "  \t\n"], purchases: [purchase_row(1, mine), purchase_row(2, "  \t\n")])
cases << run("an email of a no-break space", [1, " "], purchases: [purchase_row(1, mine)])
cases << run("an email of a next-line character", [1, "\u0085"], purchases: [purchase_row(1, mine)])
cases << run("an email of a byte order mark", [1, "\uFEFF"], purchases: [purchase_row(1, "\uFEFF")])
cases << run("an email of a no-break space and a line separator", [1, "\u00a0\u2028\u3000"], purchases: [purchase_row(1, mine)])
cases << run("an email of a zero-width space", [1, "​"], purchases: [purchase_row(1, "​")])
cases << run("an email that is a number", [1, 5], purchases: [purchase_row(1, mine)])
cases << run("an email that is false", [1, false], purchases: [purchase_row(1, mine)])
cases << run("an email that is a list", [1, ["a@example.com"]], purchases: [purchase_row(1, mine)])
cases << run("a user id as a digit string", ["1"], purchases: [purchase_row(1, mine)])
cases << run("a user id as a digit string without purchases", ["1"])
cases << run("a user id of nil", [nil])
cases << run("a user id as a float", [1.0])
cases << run("a user id as a word", ["one"])
cases << run("no arguments", [])
cases << run("one argument too many", [1, mine, 1])

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
