# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/send-memberships-price-update-emails-job.golden.json: SendMembershipsPriceUpdateEmailsJob
# run by the real app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb), with ActiveJob on the Sidekiq adapter so
# `SendMembershipPriceUpdateEmailJob.perform_later` is recorded as the JobWrapper push Redis receives. Run it like
# send-reminders-for-outstanding-user-compliance-info-requests-worker.rb.
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/send-memberships-price-update-emails-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[subscription_plan_changes subscriptions versions].freeze
FOR_PRODUCT_PRICE_CHANGE = 1 << 0
APPLIED = 1 << 1

ActiveJob::Base.queue_adapter = :sidekiq
ActiveJob::Base.logger = Logger.new(nil)
$uuid_seq = 0
SecureRandom.singleton_class.prepend(Module.new do
  def uuid = format("00000000-0000-4000-8000-%012x", ($uuid_seq += 1))
end)
Rails.logger = ActiveSupport::Logger.new(nil)

$fail_enqueue = false
SendMembershipPriceUpdateEmailJob.singleton_class.prepend(Module.new do
  def perform_later(*)
    raise "queue is down" if $fail_enqueue

    super
  end
end)

def plan_change_row(id, subscription_id: id, **overrides)
  { id:, subscription_id:, recurrence: "monthly", perceived_price_cents: 500, flags: FOR_PRODUCT_PRICE_CHANGE, effective_on: "2026-11-10",
    created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def subscription_row(id, **overrides) = { id:, link_id: 1, user_id: 1, flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)

def ago(seconds) = (NOW - seconds).strftime("%F %T.%6N")

def run(name, changes, subscriptions = nil, fail_enqueue: false)
  $uuid_seq = 0
  $fail_enqueue = fail_enqueue
  subscriptions ||= changes.map { subscription_row(_1[:subscription_id]) }.uniq
  result = capture(name, now: NOW, tables: TABLES, seed: { subscription_plan_changes: changes, subscriptions: }, sidekiq: true, job: "SendMembershipsPriceUpdateEmailsJob", args: []) do
    SendMembershipsPriceUpdateEmailsJob.new.perform
  end
  result.delete("seed")
  result
end

cases = []
cases << run("no plan changes", [])
cases << run("a plan change due in a week", [plan_change_row(1)])
cases << run("a plan change effective exactly seven days from now", [plan_change_row(1, effective_on: "2026-11-11")])
cases << run("a plan change effective eight days from now", [plan_change_row(1, effective_on: "2026-11-12")])
cases << run("a plan change effective in the past", [plan_change_row(1, effective_on: "2026-10-01")])
cases << run("a plan change with no effective date", [plan_change_row(1, effective_on: nil)])
cases << run("a plan change that is not for a product price change", [plan_change_row(1, flags: 0)])
cases << run("a plan change already applied", [plan_change_row(1, flags: FOR_PRODUCT_PRICE_CHANGE | APPLIED)])
cases << run("a deleted plan change", [plan_change_row(1, deleted_at: SEEDED_AT)])
cases << run("a subscriber already notified", [plan_change_row(1, notified_subscriber_at: SEEDED_AT)])
cases << run("a claim made an hour ago", [plan_change_row(1, notification_claim_id: "claim-1", notification_claimed_at: ago(3600))])
cases << run("a claim made two and a half hours ago", [plan_change_row(1, notification_claim_id: "claim-1", notification_claimed_at: ago(9000))])
cases << run("a claim made just over three hours ago", [plan_change_row(1, notification_claim_id: "claim-1", notification_claimed_at: ago(3 * 3600 + 1))])
cases << run("a claim made exactly three hours ago", [plan_change_row(1, notification_claim_id: "claim-1", notification_claimed_at: ago(3 * 3600))])
cases << run("a claim id without a claim time", [plan_change_row(1, notification_claim_id: "claim-1")])
cases << run("a claim time without a claim id", [plan_change_row(1, notification_claimed_at: ago(60))])
cases << run("a cancelled subscription", [plan_change_row(1)], [subscription_row(1, cancelled_at: ago(60))])
cases << run("a subscription cancelled in the future", [plan_change_row(1)], [subscription_row(1, cancelled_at: (NOW + 86_400).strftime("%F %T"))])
cases << run("a failed subscription", [plan_change_row(1)], [subscription_row(1, failed_at: ago(60))])
cases << run("an ended subscription", [plan_change_row(1)], [subscription_row(1, ended_at: ago(60))])
cases << run("a plan change whose subscription is gone", [plan_change_row(1, subscription_id: 9)], [])
cases << run("three plan changes, the middle one not eligible", [plan_change_row(1), plan_change_row(2), plan_change_row(3)], [subscription_row(1), subscription_row(2, failed_at: ago(60)), subscription_row(3)])
cases << run("two plan changes of one subscription", [plan_change_row(1, subscription_id: 1), plan_change_row(2, subscription_id: 1)], [subscription_row(1)])
cases << run("an enqueue that fails", [plan_change_row(1), plan_change_row(2)], nil, fail_enqueue: true)

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
