# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/reconcile-stripe-payouts-pauses-job.golden.json: ReconcileStripePayoutsPausesJob run by the
# real app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). Each seller's enqueue takes a unique-jobs lock, so the
# replay needs a real Redis (JOBS_REDIS_URL). Run it like release-chargeback-rate-payout-pause-for-seller-job.rb (env as in
# publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/reconcile-stripe-payouts-pauses-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[comments].freeze
AUTHOR = StripeMerchantAccountManager::STRIPE_PAYOUTS_SYNC_COMMENT_AUTHOR
BATCH_SIZE = ReconcileStripePayoutsPausesJob::BATCH_SIZE

Rails.logger = ActiveSupport::Logger.new(nil)
ActiveJob::Base.queue_adapter = :sidekiq
ActiveJob::Base.logger = Logger.new(nil)

$replica_lag_watches = 0
ReplicaLagWatcher.singleton_class.prepend(Module.new do
  def watch(*) = ($replica_lag_watches += 1)
end)

def comment_row(id, user: id, **overrides)
  { id:, commentable_id: user, commentable_type: "User", author_name: AUTHOR, comment_type: "payouts_paused", content: "Paused by Stripe", created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def run(name, comments, args = [])
  $replica_lag_watches = 0
  result = capture(name, now: NOW, tables: TABLES, seed: { comments: }, sidekiq: true, job: "ReconcileStripePayoutsPausesJob", args:, at: NOW.to_f) do
    ReconcileStripePayoutsPausesJob.new.perform(*args)
  end
  result.delete("seed")
  result.delete("rows")
  result.merge("replica_lag_watches" => $replica_lag_watches)
end

cases = []
cases << run("no comments", [])
cases << run("one stripe pause comment", [comment_row(1)])
cases << run("two sellers", [comment_row(1), comment_row(2)])
cases << run("a seller with several pause comments is queued once", [comment_row(1, user: 7), comment_row(2, user: 7), comment_row(3, user: 8), comment_row(4, user: 7)])
cases << run("sellers come out in comment id order", [comment_row(1, user: 9), comment_row(2, user: 3), comment_row(3, user: 5)])
cases << run("a deleted comment", [comment_row(1, deleted_at: SEEDED_AT)])
cases << run("a pause comment by another author", [comment_row(1, author_name: "Someone else")])
cases << run("a comment of another type", [comment_row(1, comment_type: "note")])
cases << run("a resumed comment by the stripe author", [comment_row(1, comment_type: "payouts_resumed")])
cases << run("a comment on another commentable type", [comment_row(1, commentable_type: "Link")])
cases << run("a deleted comment next to a live one of the same seller", [comment_row(1, user: 4, deleted_at: SEEDED_AT), comment_row(2, user: 4)])
cases << run("one batch exactly", (1..BATCH_SIZE).map { comment_row(_1, user: 1) })
cases << run("one comment past a batch", (1..BATCH_SIZE).map { comment_row(_1, user: 1) } + [comment_row(BATCH_SIZE + 1, user: 2)])
cases << run("a seller repeated across batches", (1..BATCH_SIZE).map { comment_row(_1, user: 1) } + [comment_row(BATCH_SIZE + 1, user: 1)])
cases << run("an argument given", [comment_row(1)], [1])

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
