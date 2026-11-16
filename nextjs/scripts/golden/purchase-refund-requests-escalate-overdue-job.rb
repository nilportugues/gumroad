# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/purchase-refund-requests-escalate-overdue-job.golden.json:
# PurchaseRefundRequests::EscalateOverdueJob run by the real app against a scratch database as a Sidekiq job
# (support/sidekiq_executor.rb). A request that is due for a seller with the feature on is what Node hands back (`escalate!` mails
# support, then writes); those cases are recorded up to that call, which a marker exception stands in for. Run it like
# send-workflow-email-to-opened-non-clicker-job.rb (USE_DB_WORKER_REPLICAS=true).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/purchase-refund-requests-escalate-overdue-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000) # a Wednesday
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[purchase_refund_requests purchases links users].freeze
FLAG = :buyer_refund_requests

Rails.logger = ActiveSupport::Logger.new(nil)
ErrorNotifier.singleton_class.prepend(Module.new do
  def notify(*, **) = ($notified = true)
end)

class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

PurchaseRefundRequest.prepend(Module.new do
  def escalate! = ($escalated << id) && raise(HandBackMarker)
end)

def at(time) = time.utc.strftime("%Y-%m-%d %H:%M:%S.%6N")

def user_row(id) = { id:, email: "seller#{id}@example.com", username: "seller#{id}", external_id: (1000 + id).to_s, recommendation_type: "own_products", user_risk_state: "compliant", flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }

def link_row(id) = { id:, user_id: 1, name: "Product #{id}", unique_permalink: "p#{id}", flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }

def purchase_row(id, **overrides)
  { id:, link_id: 1, seller_id: 1, email: "buyer#{id}@example.com", price_cents: 500, displayed_price_cents: 500, displayed_price_currency_type: "usd",
    purchase_state: "successful", flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def request_row(id, created_at, purchase_id: id, **overrides)
  { id:, purchase_id:, email: "buyer#{id}@example.com", reason: "other", created_at: at(created_at), updated_at: at(created_at) }.merge(overrides)
end

def days_before(days, hour = 12) = Time.utc(2026, 11, 4, hour) - days.days

BASE = { users: [user_row(1), user_row(2)], links: [link_row(1)] }.freeze

def run(name, requests, purchases = requests.map { purchase_row(_1[:purchase_id]) }, flag: :on, now: NOW, **seed)
  setup = lambda do
    case flag
    when :on then Feature.activate(FLAG)
    when :off then Feature.activate(FLAG).then { Feature.deactivate(FLAG) }
    when :actor then Feature.activate_user(FLAG, User.find(1))
    when :other_actor then Feature.activate_user(FLAG, User.find(2))
    when :actors100 then Feature.activate_percentage(FLAG, 100)
    when :actors0 then Feature.activate_percentage(FLAG, 0)
    when :actors50 then Feature.activate_percentage(FLAG, 50)
    when :time100 then Flipper.enable_percentage_of_time(FLAG, 100)
    when :time50 then Flipper.enable_percentage_of_time(FLAG, 50)
    end
  end
  srand(1) # Flipper rolls a percentage of time with Kernel#rand
  $escalated = []
  $notified = false
  hands_back = false
  result = capture(name, now:, tables: TABLES, seed: BASE.merge(purchases:, purchase_refund_requests: requests).merge(seed), setup:,
                         sidekiq: true, job: "PurchaseRefundRequests::EscalateOverdueJob", args: []) do
    PurchaseRefundRequests::EscalateOverdueJob.new.perform
  rescue HandBackMarker
    hands_back = true
  end
  result.delete("rows")
  result.delete("seed")
  result.merge("now" => now.to_f, "hands_back" => hands_back, "escalated" => $escalated, "notified" => $notified)
end

cases = []
cases << run("no requests", [])
cases << run("a request that is due", [request_row(1, days_before(5))])
cases << run("a request that is due and the feature is off", [request_row(1, days_before(5))], flag: :off)
cases << run("a request that is due and no feature row exists", [request_row(1, days_before(5))], flag: :none)
cases << run("a request that is due and the feature is on for its seller only", [request_row(1, days_before(5))], flag: :actor)
cases << run("a request that is due and the feature is on for another user only", [request_row(1, days_before(5))], flag: :other_actor)
cases << run("a request that is due and the feature is on for 100 percent of actors", [request_row(1, days_before(5))], flag: :actors100)
cases << run("a request that is due and the feature is on for 0 percent of actors", [request_row(1, days_before(5))], flag: :actors0)
cases << run("a request that is due and the feature is on for 50 percent of actors", [request_row(1, days_before(5))], flag: :actors50)
cases << run("a request that is due and the feature is on for 100 percent of time", [request_row(1, days_before(5))], flag: :time100)
cases << run("a request that is due and the feature is on for 50 percent of time", [request_row(1, days_before(5))], flag: :time50)
cases << run("a request created on a Monday, still inside its two business days", [request_row(1, days_before(2, 0))])
cases << run("a request created at the candidate cutoff", [request_row(1, NOW - 2.days)])
cases << run("a request created a microsecond after the candidate cutoff", [request_row(1, NOW - 2.days + Rational(1, 1_000_000))])
cases << run("a request created on a Friday, due on Tuesday", [request_row(1, Time.utc(2026, 10, 30, 12))])
cases << run("a request created on a Saturday", [request_row(1, Time.utc(2026, 10, 31, 12))])
cases << run("a request created on a Sunday", [request_row(1, Time.utc(2026, 11, 1, 12))])
cases << run("a request created on a Thursday, due the next Monday", [request_row(1, Time.utc(2026, 10, 29, 12))], now: Time.utc(2026, 11, 2, 23, 59, 59, 999_000))
cases << run("a request created on a Thursday, the first instant past its deadline", [request_row(1, Time.utc(2026, 10, 29, 12))], now: Time.utc(2026, 11, 3))
cases << run("a request created on a Wednesday, the last millisecond of its deadline", [request_row(1, Time.utc(2026, 10, 28, 12))], now: Time.utc(2026, 10, 30, 23, 59, 59, 999_000))
cases << run("a request created on a Wednesday, a moment after its deadline", [request_row(1, Time.utc(2026, 10, 28, 12))], now: Time.utc(2026, 10, 31, 0, 0, 0))
cases << run("a request that was already escalated", [request_row(1, days_before(5), escalated_at: at(days_before(1)))])
cases << run("a request whose purchase was refunded", [request_row(1, days_before(5))], [purchase_row(1, stripe_refunded: 1)])
cases << run("a request whose purchase has a zero stripe_refunded", [request_row(1, days_before(5))], [purchase_row(1, stripe_refunded: 0)])
cases << run("a request whose purchase was charged back", [request_row(1, days_before(5))], [purchase_row(1, chargeback_date: SEEDED_AT)])
cases << run("a request whose purchase has no row", [request_row(1, days_before(5))], [])
cases << run("a request whose purchase has no seller", [request_row(1, days_before(5))], [purchase_row(1, seller_id: nil)])
cases << run("a request whose purchase has no seller and the feature is off", [request_row(1, days_before(5))], [purchase_row(1, seller_id: nil)], flag: :off)
cases << run("a request whose purchase's seller does not exist", [request_row(1, days_before(5))], [purchase_row(1, seller_id: 9)])
cases << run("a request whose purchase's product does not exist", [request_row(1, days_before(5))], [purchase_row(1, link_id: 9)])
cases << run("requests whose purchases are listed in another order", [request_row(1, days_before(6), purchase_id: 2), request_row(2, days_before(5), purchase_id: 1)], [purchase_row(1), purchase_row(2, link_id: 2, seller_id: 2)],
             flag: :off, links: [link_row(1), link_row(2)])
cases << run("three requests sharing a seller and a product, the feature off", (1..3).map { request_row(_1, days_before(6)) }, (1..3).map { purchase_row(_1) }, flag: :off)
cases << run("three requests, two without a seller, the feature off", (1..3).map { request_row(_1, days_before(6)) }, [purchase_row(1, seller_id: nil), purchase_row(2, seller_id: nil), purchase_row(3, seller_id: 2)], flag: :off)
cases << run("1001 requests that are not due for their seller", (1..1001).map { request_row(_1, days_before(6)) }, (1..1001).map { purchase_row(_1) }, flag: :off)
cases << run("1000 requests that are not due for their seller", (1..1000).map { request_row(_1, days_before(6)) }, (1..1000).map { purchase_row(_1) }, flag: :off)
cases << run("a due request behind one that is not due", [request_row(1, days_before(2, 0)), request_row(2, days_before(5))])
cases << run("a due request behind one that is refunded", [request_row(1, days_before(6)), request_row(2, days_before(5))], [purchase_row(1, stripe_refunded: 1), purchase_row(2)])
cases << run("two requests that are due", [request_row(1, days_before(6)), request_row(2, days_before(5))])
cases << run("two requests that are due, the feature off", [request_row(1, days_before(6)), request_row(2, days_before(5))], flag: :off)
cases << run("requests of two sellers, the first off for its seller", [request_row(1, days_before(6)), request_row(2, days_before(5))],
             [purchase_row(1), purchase_row(2, seller_id: 2)], flag: :other_actor)

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
