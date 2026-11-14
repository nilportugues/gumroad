# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/post-to-ping-endpoints-worker.golden.json: PostToPingEndpointsWorker run by the real app
# against a scratch database as a Sidekiq job (support/sidekiq_executor.rb), inside `connected_to(role: :writing)`. A subscription is
# found and, for the ended and restarted resources, may end the job on its own state; past that, and for a purchase that is found, the job
# builds the ping payload and enqueues deliveries. Those cases are recorded up to the `subscription.link` and `purchase.seller` reads, which
# a marker exception stands in for and Node hands back. Run it like pdf-unstampable-notifier-job.rb (env as in publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/post-to-ping-endpoints-worker.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[purchases subscriptions].freeze

Rails.logger = ActiveSupport::Logger.new(nil)

class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

Subscription.prepend(Module.new do
  def link = raise(HandBackMarker)
end)
Purchase.prepend(Module.new do
  def seller = raise(HandBackMarker)
end)

def purchase_row(id, **overrides) = { id:, link_id: 1, seller_id: 1, email: "buyer#{id}@example.com", purchase_state: "successful", price_cents: 100, flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
def subscription_row(id, **overrides) = { id:, link_id: 1, user_id: 2, flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)

def run(name, args, purchases: [], subscriptions: [])
  hands_back = false
  result = capture(name, now: NOW, tables: TABLES, seed: { purchases:, subscriptions: }, sidekiq: true, job: "PostToPingEndpointsWorker", args:) do
    PostToPingEndpointsWorker.new.perform(*args)
  rescue HandBackMarker
    hands_back = true
  end
  result.delete("rows")
  result.delete("seed")
  result.merge("hands_back" => hands_back)
end

P = [purchase_row(1), purchase_row(2)].freeze
LIVE = [subscription_row(1), subscription_row(2)].freeze
DEACTIVATED = [subscription_row(1, deactivated_at: SEEDED_AT), subscription_row(2)].freeze
ENDED = [subscription_row(1, ended_at: SEEDED_AT), subscription_row(2)].freeze
CANCELLED = [subscription_row(1, cancelled_at: SEEDED_AT), subscription_row(2)].freeze
FAILED = [subscription_row(1, failed_at: SEEDED_AT), subscription_row(2)].freeze

cases = []
cases << run("a sale", [1, {}], purchases: P)
cases << run("a sale with url parameters", [1, { "a" => "b" }, "sale"], purchases: P)
cases << run("a sale among others", [2, {}], purchases: P + [purchase_row(3)])
cases << run("a cancellation", [1, {}, "cancellation"], purchases: P)
cases << run("a sale that does not exist", [9, {}], purchases: P)
cases << run("a sale id of zero", [0, {}], purchases: P)
cases << run("the sale id as a digit string", ["2", {}], purchases: P)
cases << run("a sale id of nil", [nil, {}], purchases: P)
cases << run("a sale id as a float", [1.0, {}], purchases: P)
cases << run("a sale id as a word", ["one", {}], purchases: P)
cases << run("a nil subscription id", [1, {}, "sale", nil], purchases: P)
cases << run("a subscription id of false", [1, {}, "sale", false], purchases: P)
cases << run("a blank subscription id", [1, {}, "sale", ""], purchases: P)
cases << run("a live subscription", [nil, {}, "subscription_updated", 1], subscriptions: LIVE)
cases << run("a live subscription, and the sale id given too", [1, {}, "subscription_updated", 2], purchases: P, subscriptions: LIVE)
cases << run("a live subscription with additional params", [nil, {}, "subscription_updated", 1, { "plan" => "x" }], subscriptions: LIVE)
cases << run("a subscription that ended and is deactivated", [nil, {}, "subscription_ended", 1], subscriptions: DEACTIVATED)
cases << run("a subscription that ended and is still active", [nil, {}, "subscription_ended", 2], subscriptions: DEACTIVATED)
cases << run("a subscription restarted with no termination date", [nil, {}, "subscription_restarted", 2], subscriptions: DEACTIVATED)
cases << run("a subscription restarted that has an end date", [nil, {}, "subscription_restarted", 1], subscriptions: ENDED)
cases << run("a subscription restarted that was cancelled", [nil, {}, "subscription_restarted", 1], subscriptions: CANCELLED)
cases << run("a subscription restarted that failed", [nil, {}, "subscription_restarted", 1], subscriptions: FAILED)
cases << run("a subscription restarted that is deactivated", [nil, {}, "subscription_restarted", 1], subscriptions: DEACTIVATED)
cases << run("a subscription ended that has an end date but is not deactivated", [nil, {}, "subscription_ended", 1], subscriptions: ENDED)
cases << run("a subscription that does not exist", [nil, {}, "subscription_updated", 9], subscriptions: LIVE)
cases << run("a subscription id of zero", [nil, {}, "subscription_updated", 0], subscriptions: LIVE)
cases << run("the subscription id as a digit string", [nil, {}, "subscription_updated", "2"], subscriptions: LIVE)
cases << run("a subscription id as a float", [nil, {}, "subscription_updated", 1.0], subscriptions: LIVE)
cases << run("a subscription id as a word", [nil, {}, "subscription_updated", "one"], subscriptions: LIVE)
cases << run("a subscription ended that does not exist", [nil, {}, "subscription_ended", 9], subscriptions: DEACTIVATED)
cases << run("no arguments", [], purchases: P)
cases << run("one argument", [1], purchases: P)
cases << run("six arguments", [1, {}, "sale", nil, {}, 1], purchases: P)

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
