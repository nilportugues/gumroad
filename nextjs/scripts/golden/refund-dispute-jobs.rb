# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/refund-dispute-jobs.golden.json: the jobs that read
# refunds, failed-refund exceptions and disputes, run by the real app against a scratch database,
# each case as a Sidekiq job (support/sidekiq_executor.rb). Run it like purchase-reads-jobs.rb,
# with USE_DB_WORKER_REPLICAS=true:
#
#   RAILS_ENV=test DATABASE_NAME=gumroad_ws49 TEST_DATABASE_NAME=gumroad_ws49 DISABLE_TEST_REDIS_ISOLATION=1 \
#     USE_DB_WORKER_REPLICAS=true REDIS_HOST=127.0.0.1:6379/12 SIDEKIQ_REDIS_HOST=127.0.0.1:6379/12 \
#     RPUSH_REDIS_HOST=127.0.0.1:6379/12 RACK_ATTACK_REDIS_HOST=127.0.0.1:6379/12 \
#     bundle exec rails runner nextjs/scripts/golden/refund-dispute-jobs.rb
#
# The purchase factory charges Stripe, so purchases are plain INSERTs of the columns a read looks at.
# ErrorNotifier is recorded (and can be made to raise) instead of reaching Sentry. Jobs Node hands
# back to Rails (RecoverPendingRefundFeeRetentionJob, CreateMissingDisputeEvidenceJob) are recorded
# up to the call that does their first write or charge-processor call, which a marker exception
# stands in for: the statements recorded are the ones Node must send before it hands back.
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/refund-dispute-jobs.golden.json")
# A Wednesday, so the weekend extension of a window opened the Friday before can be told apart.
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[users comments versions purchases refunds failed_refund_exceptions credits balances disputes dispute_evidences links].freeze

Stripe.api_base = "http://127.0.0.1:9"
Stripe.max_network_retries = 0
Rails.logger = ActiveSupport::Logger.new(nil)

# Stands in for the first write / charge-processor call of a job Node hands back.
class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

# TimeWithZone is not a ::Time to encode_value; Hashes nest.
def encode_context(value)
  case value
  when Hash then value.to_h { |k, v| [k.to_s, encode_context(v)] }
  when ActiveSupport::TimeWithZone then RailsRecorder.encode_value(value.utc.to_time)
  else RailsRecorder.encode_value(value)
  end
end

$notified = []
$notify_raises = false
ErrorNotifier.singleton_class.prepend(Module.new do
  def notify(error, *, **context)
    # An exception's class and message are the driver's and Ruby's; that one was reported is what matters.
    $notified << { "message" => error.is_a?(Exception) ? "<exception>" : error.to_s,
                   "context" => encode_context(context) }
    raise "Sentry is down" if $notify_raises

    super
  end
end)

# A lock wait timeout on `purchases.id = $lock_timeout_on ... FOR UPDATE`, recorded as MySQL's error.
$lock_timeout_on = nil
Mysql2::Client.prepend(Module.new do
  def query(sql, *rest, **options)
    if $lock_timeout_on && sql.include?("FOR UPDATE") && sql.include?("`purchases`.`id` = #{$lock_timeout_on} ")
      error = Mysql2::Error.new("Lock wait timeout exceeded; try restarting transaction", nil, 1205, "HY000")
      RailsRecorder.record_error(sql, error)
      raise error
    end
    super
  end
end)

Refund.prepend(Module.new do
  private
    def collect_pending_fee_retention!
      raise HandBackMarker
    end
end)
CreateMissingDisputeEvidenceJob.prepend(Module.new do
  private
    def create_evidence_for(_dispute)
      raise HandBackMarker
    end
end)

def user_row(id, **overrides)
  {
    id:, email: "seller#{id}@example.com", username: "seller#{id}", external_id: (1000 + id).to_s, recommendation_type: "own_products",
    user_risk_state: "compliant", flags: 0, json_data: nil, confirmed_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT
  }.merge(overrides)
end

def purchase_row(id, **overrides)
  { id:, link_id: 1, seller_id: 1, purchase_state: "successful", price_cents: 100, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def refund_row(id, purchase_id, **overrides)
  { id:, purchase_id:, link_id: 1, seller_id: 1, amount_cents: 100, status: "succeeded", processor_refund_id: "re_#{id}", flags: 0,
    fee_retention_recoverable: false, json_data: nil, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def exception_row(id, refund_id, **overrides)
  { id:, refund_id:, owner: "payments", notification_room: "payments", state: "pending", due_at: "2026-11-05 00:00:00", balance_reversed: false,
    notification_failures: 0, notification_sent_at: nil, resolved_at: nil, resolution: nil, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def credit_row(id, **overrides)
  { id:, user_id: 1, amount_cents: -30, merchant_account_id: 1, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def balance_row(id, user_id, state, **overrides)
  { id:, user_id:, date: "2026-10-01", amount_cents: 100, state:, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def dispute_row(id, state, **overrides)
  { id:, purchase_id: 1, state:, seller_id: 1, event_created_at: "2026-10-20 00:00:00", created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def evidence_row(id, dispute_id, **overrides)
  { id:, dispute_id:, created_at: SEEDED_AT, updated_at: SEEDED_AT, resolution: "unknown" }.merge(overrides)
end

def json(hash) = JSON.generate(hash)

$uuid_seq = 0
def run(name, job, args, seed: {}, hands_back: false, notify_raises: false, setup: nil, lock_timeout_on: nil)
  $uuid_seq = 0
  $notified = []
  $notify_raises = notify_raises
  $lock_timeout_on = lock_timeout_on
  result = capture(name, now: NOW, tables: TABLES, seed:, setup:, sidekiq: true, job:, args:) do
    job.constantize.new.perform(*args)
  rescue HandBackMarker
    nil
  end
  $notify_raises = false
  $lock_timeout_on = nil
  # The replay answers from the recorded statements; the tables' final state is not compared.
  result.delete("rows")
  result.merge("notified" => $notified.dup, "hands_back" => hands_back, "notify_raises" => notify_raises)
end

cases = []

# --- FightDisputesJob ---------------------------------------------------------------------------
# NOW is Wednesday 2026-11-04 12:30:45. Windows opened after 2026-10-05 get 48 more hours when the
# base 72 hours touch a weekend.
def fight(name, evidences, disputes, **options)
  run(name, "FightDisputesJob", [], seed: { disputes:, dispute_evidences: evidences }, **options)
end

cases << fight("nothing open", [], [])
cases << fight("a window that closed on a weekday forwards the dispute",
               [evidence_row(1, 1, seller_contacted_at: "2026-10-28 09:00:00.500000")], [dispute_row(1, "formalized")])
cases << fight("a window still open is left alone",
               [evidence_row(1, 1, seller_contacted_at: "2026-11-03 09:00:00")], [dispute_row(1, "formalized")])
cases << fight("a Friday window runs into the weekend and is extended by two days",
               [evidence_row(1, 1, seller_contacted_at: "2026-10-30 12:00:00")], [dispute_row(1, "formalized")])
cases << fight("a Friday window past its extension forwards the dispute",
               [evidence_row(1, 1, seller_contacted_at: "2026-10-30 12:00:00"), evidence_row(2, 2, seller_contacted_at: "2026-10-30 12:30:00")],
               [dispute_row(1, "formalized"), dispute_row(2, "formalized")])
cases << fight("a Saturday window is extended",
               [evidence_row(1, 1, seller_contacted_at: "2026-10-31 14:00:00")], [dispute_row(1, "formalized")])
cases << fight("a window ending exactly at midnight does not reach the day that begins there",
               [evidence_row(1, 1, seller_contacted_at: "2026-10-30 00:00:00"), evidence_row(2, 2, seller_contacted_at: "2026-10-29 00:00:00")],
               [dispute_row(1, "formalized"), dispute_row(2, "formalized")])
cases << fight("a window stamped before the cutover keeps 72 hours",
               [evidence_row(1, 1, seller_contacted_at: "2026-10-03 12:00:00"), evidence_row(2, 2, seller_contacted_at: "2026-10-05 00:00:00")],
               [dispute_row(1, "formalized"), dispute_row(2, "formalized")])
cases << fight("rows without a stamp, resolved rows and terminal disputes are skipped",
               [evidence_row(1, 1), evidence_row(2, 2, seller_contacted_at: "2026-10-01 00:00:00", resolved_at: "2026-10-04 00:00:00"),
                evidence_row(3, 3, seller_contacted_at: "2026-10-01 00:00:00"), evidence_row(4, 4, seller_contacted_at: "2026-10-01 00:00:00"),
                evidence_row(5, 5, seller_contacted_at: "2026-10-01 00:00:00"), evidence_row(6, 6, seller_contacted_at: "2026-10-01 00:00:00"),
                evidence_row(7, 7, seller_contacted_at: "2026-10-01 00:00:00")],
               [dispute_row(1, "formalized"), dispute_row(2, "formalized"), dispute_row(3, "won"), dispute_row(4, "lost"), dispute_row(5, "closed"),
                dispute_row(6, "initiated"), dispute_row(7, nil)])
cases << fight("evidence whose dispute is gone fails on the missing dispute",
               [evidence_row(1, 99, seller_contacted_at: "2026-10-01 00:00:00")], [])

# --- DispatchPendingFailedRefundExceptionsJob ---------------------------------------------------
def dispatch(name, exceptions, refunds: nil, **options)
  refunds ||= exceptions.map { |e| refund_row(e[:refund_id], 1) }
  run(name, "DispatchPendingFailedRefundExceptionsJob", [], seed: { purchases: [purchase_row(1)], refunds:, failed_refund_exceptions: exceptions }, **options)
end

cases << dispatch("nothing pending", [])
cases << dispatch("pending exceptions with unsent reports are re-enqueued in id order",
                  [exception_row(1, 11), exception_row(2, 12, state: "resolved"), exception_row(3, 13, notification_sent_at: "2026-11-03 00:00:00"),
                   exception_row(4, 14, notification_failures: 19), exception_row(5, 15, state: "escalated")])
cases << dispatch("an exception past its failure cap is escalated, not re-enqueued",
                  [exception_row(1, 11, notification_failures: 20), exception_row(2, 12, notification_failures: 25, owner: "risk", notification_room: "risk")])
cases << dispatch("an exception past its deadline is escalated",
                  [exception_row(1, 11, due_at: "2026-11-04 12:30:45", notification_sent_at: "2026-11-03 00:00:00"),
                   exception_row(2, 12, due_at: "2026-11-04 12:30:46", notification_sent_at: "2026-11-03 00:00:00"),
                   exception_row(3, 13, due_at: "2026-11-01 00:00:00", notification_sent_at: "2026-11-03 00:00:00", state: "resolved")])
cases << dispatch("an overdue exception with an unsent report is both re-enqueued and escalated",
                  [exception_row(1, 11, due_at: "2026-11-01 00:00:00")])
cases << dispatch("a failure-capped overdue exception is escalated once, for the cap",
                  [exception_row(1, 11, due_at: "2026-11-01 00:00:00", notification_failures: 20)])
cases << dispatch("an error reporter that raises leaves the exception pending", [exception_row(1, 11, due_at: "2026-11-01 00:00:00", notification_sent_at: "2026-11-03 00:00:00"), exception_row(2, 12, due_at: "2026-11-01 00:00:00", notification_sent_at: "2026-11-03 00:00:00")],
                  notify_raises: true)
cases << dispatch("an exception whose refund is gone cannot be escalated", [exception_row(1, 11, due_at: "2026-11-01 00:00:00", notification_sent_at: "2026-11-03 00:00:00")], refunds: [])

# --- NotifyFailedRefundExceptionJob -------------------------------------------------------------
def notify(name, exceptions, refunds: nil, credits: [], args: [1], **options)
  refunds ||= exceptions.map { |e| refund_row(e[:refund_id], 1) }
  run(name, "NotifyFailedRefundExceptionJob", args, seed: { purchases: [purchase_row(1, seller_id: 7)], refunds:, failed_refund_exceptions: exceptions, credits: }, **options)
end

cases << notify("no such exception", [])
cases << notify("an exception that is not pending is left alone", [exception_row(1, 11, state: "resolved")])
cases << notify("an exception already reported is left alone", [exception_row(1, 11, notification_sent_at: "2026-11-03 00:00:00")])
cases << notify("an exception past the failure cap is left alone", [exception_row(1, 11, notification_failures: 20)])
cases << notify("reports an exception whose balance was not reversed", [exception_row(1, 11)])
cases << notify("reports a reversed exception with no retained fee", [exception_row(1, 11, balance_reversed: true)])
cases << notify("a reversed exception whose retained fee was given back",
                [exception_row(1, 11, balance_reversed: true)],
                refunds: [refund_row(11, 1, json_data: json(retained_fee_cents: 30, presentment_currency: "cad", presentment_amount_cents: 140))],
                credits: [credit_row(1, fee_retention_refund_id: 11, failed_refund_id: 11)])
cases << notify("a reversed exception whose retained fee stays with the seller",
                [exception_row(1, 11, balance_reversed: true, owner: "risk", notification_room: "risk")],
                refunds: [refund_row(11, 1, json_data: json(retained_fee_cents: "30"))],
                credits: [credit_row(1, fee_retention_refund_id: 11), credit_row(2, fee_retention_refund_id: 12, failed_refund_id: 11)])
cases << notify("an unreversed exception ignores the retained fee",
                [exception_row(1, 11)], refunds: [refund_row(11, 1, json_data: json(retained_fee_cents: 30))])
cases << notify("a non-numeric retained fee counts as zero",
                [exception_row(1, 11, balance_reversed: true)], refunds: [refund_row(11, 1, json_data: json(retained_fee_cents: "abc"))])
cases << notify("a failing error reporter counts the failure and raises", [exception_row(1, 11, notification_failures: 3)], notify_raises: true)
cases << notify("an exception whose refund is gone", [exception_row(1, 11)], refunds: [])
cases << notify("the exception id arrives as a string", [exception_row(1, 11)], args: ["1"])

# --- RefundUnpaidPurchasesWorker ----------------------------------------------------------------
def unpaid(name, args: [1, 2], **seed)
  run(name, "RefundUnpaidPurchasesWorker", args, seed: { users: [user_row(1, user_risk_state: "suspended_for_fraud"), user_row(2, name: "Admin Person")] }.merge(seed))
end

cases << run("unpaid: no such user", "RefundUnpaidPurchasesWorker", [1, 2])
cases << run("unpaid: a seller who is not suspended", "RefundUnpaidPurchasesWorker", [1, 2], seed: { users: [user_row(1)] })
cases << unpaid("unpaid: no unpaid sales still leaves a comment")
cases << unpaid("unpaid: refunds every successful unpaid sale that is not fully refunded",
                balances: [balance_row(1, 1, "unpaid"), balance_row(2, 1, "paid"), balance_row(3, 1, "processing"), balance_row(4, 5, "unpaid")],
                purchases: [purchase_row(10, purchase_success_balance_id: 1), purchase_row(11, purchase_success_balance_id: 1, stripe_refunded: true),
                            purchase_row(12, purchase_success_balance_id: 2), purchase_row(13, purchase_success_balance_id: 1, purchase_state: "failed"),
                            purchase_row(14, purchase_success_balance_id: 1, stripe_refunded: false), purchase_row(15, purchase_success_balance_id: 4),
                            purchase_row(16, seller_id: 5, purchase_success_balance_id: 1), purchase_row(17, purchase_success_balance_id: nil),
                            purchase_row(18, purchase_success_balance_id: 1, stripe_partially_refunded: true)])
cases << unpaid("unpaid: an admin without a name is credited by username", users: [user_row(1, user_risk_state: "suspended_for_tos_violation"), user_row(2)],
                balances: [balance_row(1, 1, "unpaid")], purchases: [purchase_row(10, purchase_success_balance_id: 1)])
cases << run("unpaid: a missing admin fails after the refunds were queued", "RefundUnpaidPurchasesWorker", [1, 9], seed: {
  users: [user_row(1, user_risk_state: "suspended_for_fraud")], balances: [balance_row(1, 1, "unpaid")], purchases: [purchase_row(10, purchase_success_balance_id: 1)],
})
cases << unpaid("unpaid: the user id arrives as a string", args: ["1", "2"])

# --- RecoverPendingRefundFeeRetentionJob ---------------------------------------------------------
def recover(name, refunds, **options)
  run(name, "RecoverPendingRefundFeeRetentionJob", [], seed: { purchases: [purchase_row(1), purchase_row(2)], refunds: }, **options)
end

PENDING = json(fee_retention_pending: true)
cases << recover("recover: nothing pending", [refund_row(1, 1), refund_row(2, 1, fee_retention_recoverable: false, json_data: PENDING)])
cases << recover("recover: recoverable refunds whose fee is no longer pending are skipped",
                 [refund_row(1, 1, fee_retention_recoverable: true), refund_row(2, 2, fee_retention_recoverable: true, json_data: json(fee_retention_pending: false))])
cases << recover("recover: a pending refund is handed back before anything is written",
                 [refund_row(1, 1, fee_retention_recoverable: true, json_data: json(fee_retention_pending: false)), refund_row(2, 2, fee_retention_recoverable: true, json_data: PENDING),
                  refund_row(3, 2, fee_retention_recoverable: true, json_data: PENDING)], hands_back: true)
cases << recover("recover: a lock wait timeout is reported and the sweep moves on",
                 [refund_row(1, 1, fee_retention_recoverable: true, json_data: PENDING), refund_row(2, 2, fee_retention_recoverable: true, json_data: json(fee_retention_pending: false))],
                 lock_timeout_on: 1)
cases << recover("recover: a lock wait timeout followed by a pending refund",
                 [refund_row(1, 1, fee_retention_recoverable: true, json_data: PENDING), refund_row(2, 2, fee_retention_recoverable: true, json_data: PENDING)],
                 lock_timeout_on: 1, hands_back: true)
cases << recover("recover: the first refund pending", [refund_row(1, 1, fee_retention_recoverable: true, json_data: PENDING)], hands_back: true)

# --- CreateMissingDisputeEvidenceJob -------------------------------------------------------------
def missing(name, disputes, evidences = [], **options)
  run(name, "CreateMissingDisputeEvidenceJob", [], seed: { disputes:, dispute_evidences: evidences }, **options)
end

cases << missing("missing evidence: no disputes", [])
cases << missing("missing evidence: nothing outside the open states, lookback or grace",
                 [dispute_row(1, "won"), dispute_row(2, "formalized", event_created_at: "2026-08-01 00:00:00"),
                  dispute_row(3, "formalized", formalized_at: "2026-11-04 10:00:00"), dispute_row(4, "formalized", created_at: "2026-11-04 10:00:00"),
                  dispute_row(5, "formalized", formalized_side_effects_finished_at: "2026-11-04 10:00:00", event_created_at: "2026-10-20 00:00:00"),
                  dispute_row(6, "formalized", formalized_side_effects_finished_at: "2026-11-04 10:00:00")],
                 [evidence_row(5, 5, seller_contacted_at: "2026-11-04 10:00:00"), evidence_row(6, 6, resolved_at: "2026-11-04 10:00:00")])
cases << missing("missing evidence: a dispute with no evidence is handed back", [dispute_row(1, "formalized", formalized_side_effects_finished_at: "2026-11-04 10:00:00")], hands_back: true)
cases << missing("missing evidence: a never-announced evidence row is handed back",
                 [dispute_row(1, "initiated", formalized_at: "2026-11-03 00:00:00")], [evidence_row(1, 1)], hands_back: true)
cases << missing("missing evidence: boundary of the lookback and the grace period",
                 [dispute_row(1, "created", event_created_at: "2026-09-05 12:30:45.123000", created_at: "2026-11-03 00:30:45")], hands_back: true)

now_f = travel_to(NOW, with_usec: true) { Time.now.to_f }
File.write(OUT, JSON.pretty_generate({ "now" => now_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
