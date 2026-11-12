# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/stale-transient-suppression-sweep-job.golden.json: StaleTransientSuppressionSweepJob run
# by the real app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb), with every outbound request answered by
# WebMock (capture_http!, `http_responses:` in order) and recorded. A list with a usable entry is what Node hands back to Rails
# (classifying the reason, the owner's sign-in, the DELETE); those cases are recorded up to the first classification, which a marker
# exception stands in for. Run it like delete-wishlist-products-job.rb:
#
#   bundle exec rails runner nextjs/scripts/golden/stale-transient-suppression-sweep-job.rb   (env as in publish-scheduled-post.rb)
require_relative "support/rails_cases"
include RailsCases
capture_http!

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/stale-transient-suppression-sweep-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
KEY_VARIABLES = {
  gumroad: "SENDGRID_GUMROAD_TRANSACTIONS_API_KEY",
  followers: "SENDGRID_GUMROAD_FOLLOWER_CONFIRMATION_API_KEY",
  creators: "SENDGRID_GR_CREATORS_API_KEY",
  customers_level_1: "SENDGRID_GR_CUSTOMERS_API_KEY",
  customers_level_2: "SENDGRID_GR_CUSTOMERS_LEVEL_2_API_KEY"
}.freeze
KEPT_HEADERS = %w[Authorization Accept].freeze

Rails.logger = ActiveSupport::Logger.new(nil)

class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

TransientEmailFailureClassifier.prepend(Module.new do
  def transient? = raise(HandBackMarker)
end)

def entries(count, email: ->(i) { "bounced#{i}@example.com" }) = Array.new(count) { |i| { created: 1_760_000_000 + i, email: email.call(i), reason: "mailbox full", status: "4.2.2" } }
def ok(body) = { status: 200, body: body.to_json }

def run(name, keys, responses)
  hands_back = false
  KEY_VARIABLES.each_value { ENV.delete(_1) }
  keys.each { |subuser, key| ENV[KEY_VARIABLES.fetch(subuser)] = key }
  result = capture(name, now: NOW, tables: [], sidekiq: true, job: "StaleTransientSuppressionSweepJob", args: [], http_responses: responses) do
    StaleTransientSuppressionSweepJob.new.perform
  rescue HandBackMarker
    hands_back = true
  end
  result.delete("rows")
  result.delete("seed")
  result.delete("http_responses")
  result["http"] = result["http"].map { |request| request.merge("headers" => request["headers"].slice(*KEPT_HEADERS)) }
  result.merge("hands_back" => hands_back)
ensure
  KEY_VARIABLES.each_value { ENV.delete(_1) }
end

ONE = { gumroad: "SG.example-gumroad" }.freeze

cases = []
cases << run("no api key at all", {}, [])
cases << run("blank api keys", { gumroad: "", followers: "  " }, [])
cases << run("one subuser with two empty lists", ONE, [ok([]), ok([])])
cases << run("every subuser with empty lists", KEY_VARIABLES.keys.to_h { [_1, "SG.example-#{_1}"] }, Array.new(10) { ok([]) })
cases << run("a bounce list with a usable entry", ONE, [ok(entries(1))])
cases << run("a block list with a usable entry after an empty bounce list", ONE, [ok([]), ok(entries(2))])
cases << run("a bounce list with entries that have no email", ONE, [ok([{ created: 1_760_000_000, email: "", reason: "x" }, { created: 1, reason: "y" }]), ok([])])
cases << run("a bounce list with entries that are not hashes", ONE, [ok(["a@example.com", 5, nil]), ok([])])
cases << run("a full first page with usable entries", ONE, [ok(entries(500))])
cases << run("a full first page of entries without an email", ONE, [ok(entries(500, email: ->(_) { "" })), ok([]), ok([])])
cases << run("twenty full pages of entries without an email", ONE, Array.new(20) { ok(entries(500, email: ->(_) { nil })) } + [ok([])])
cases << run("a bounce list with a failing status", ONE, [{ status: 401, body: { errors: [{ message: "authorization required" }] }.to_json }, ok([])])
cases << run("a bounce list that is not an array", ONE, [ok({ errors: [] }), ok([])])
cases << run("a bounce list that is not JSON", ONE, [{ status: 200, body: "<html>" }, ok([])])
cases << run("a bounce list with a server error then empty blocks", ONE, [{ status: 500, body: "" }, ok([])])
cases << run("two subuser keys with empty lists", { gumroad: "SG.example-gumroad", creators: "SG.example-creators" }, Array.new(4) { ok([]) })

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
