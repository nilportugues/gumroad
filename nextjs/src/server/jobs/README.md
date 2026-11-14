# Jobs: BullMQ plus a Sidekiq bridge

`enqueue("FooJob", args, { delaySeconds })` is Node's `FooJob.perform_in(delay, *args)`. Jobs whose
body still lives in Ruby are pushed to Sidekiq in its own wire format; jobs ported to Node go to
BullMQ. Callers never know which.

```
 Node caller ─ enqueue() ─┬─ runtime "ruby" ─► unique-jobs lock ─► queue:<q> / schedule  ─► Sidekiq (Ruby)
                          └─ runtime "node" ─► unique-jobs lock ─► BullMQ bull:<q>       ─► src/worker
 Rails caller ─ perform_async ─► unique-jobs middleware ─► SidekiqNodeBridge ─► nextjs:bridge:inbox ─► src/worker/bridge.ts ─► BullMQ
```

## Registry

`registry.generated.ts` is generated from `app/sidekiq` (plus the plain Sidekiq jobs in `app/jobs`)
and `config/sidekiq_schedule.yml` by `scripts/generate-job-registry.ts`. It records each class's own
`sidekiq_options` in declaration order (the payload's key order depends on it), aliases
(`OldName = NewName`), whether it defines `lock_args` / `sidekiq_retry_in` / a retries-exhausted
hook, the `lock_ttl` that `RecurringLockTtl` computes, and every cron entry.

- `npm run jobs:generate` after changing a job's options, the schedule, or `ported-jobs.ts`.
- `npm run jobs:check-drift` fails when the committed registry is stale (wire it into CI next to
  `prisma:check-drift`); `registry.test.ts` checks the same.
- The generator parses Ruby rather than running it and fails on any expression it does not
  understand, so a new form of option is a generator change, not a silent default.
- A Ruby `self.lock_args` must have a port in `lock-args.ts`; the generator refuses to run otherwise.

## Sidekiq wire format

`sidekiq/item.ts` reproduces Sidekiq 7.3.4's `normalize_item` and sidekiq-unique-jobs 8.0.10's
`Job.prepare`; `sidekiq/client.ts` reproduces `atomic_push`. Sidekiq uses no Redis namespace here,
so the keys are `queues`, `queue:<name>` (LPUSH) and `schedule` (ZADD scored by `at`). Locks use the
gem's own Lua (`unique-jobs-lua.generated.ts`, rendered from the gem) in the same order as
`Locksmith#lock`: `queue.lua`, `LMOVE QUEUED→PRIMED`, `lock.lua`.

Proof: `__fixtures__/generate-sidekiq-golden.rb` runs the real gems (versions from Gemfile.lock)
against a scratch Redis and records the digests, the exact payload bytes and the full resulting Redis
state for each case. `sidekiq/wire.test.ts` matches the payloads byte for byte;
`jobs.integration.test.ts` replays every push from Node and compares the whole Redis keyspace.

`push-bulk.ts` is `Sidekiq::Client.push_bulk` / `perform_bulk`: one `normalize_item`, then a copy
per args entry with its own jid and `at` (an integer `at` schedules even when it is not in the
future), each through the unique-jobs lock, and one pipelined push per batch. A Node-owned class
goes to BullMQ item by item and returns the jid, where Ruby's bridge returns nil.
`__fixtures__/generate-push-bulk-golden.rb` and `push-bulk.integration.test.ts` prove it.

Known limits, enforced by `ruby-json.ts` throwing rather than diverging:

- JavaScript has no integral floats, so `1.0` in args is written `1` unless wrapped in `RubyFloat`.
  This only changes bytes (and so a lock digest) for jobs that take floats.
- Integers past 2^53 must be passed as `bigint`.
- Numbers V8 prints in exponent form (`1e-7`) are refused; Ruby's json prints them differently.

## BullMQ

One BullMQ queue per Sidekiq queue (`critical`, `default`, `low`, `exports`, `long`) under the
`bull:` prefix. `retry: N` becomes `attempts: N + 1`, with Sidekiq's default backoff
(`count**4 + 15 + rand(10) * (count + 1)` seconds). `retry: false` drops the job on failure; other
failures are kept for 180 days, as the dead set keeps them.

`src/worker/retry.ts` is Sidekiq 7.3.4's `JobRetry`: a job's `sidekiq_retry_in` block goes in
`JOB_RETRY_IN` (seconds, `"discard"` or `"kill"`; jitter is still added, nil or non-positive keeps
the default) and its `sidekiq_retries_exhausted` block in `JOB_RETRIES_EXHAUSTED`. The exhausted
hook runs after the last allowed retry fails (on the first failure for `retry: 0`, never for
`retry: false`), outside the lock middleware as in Sidekiq, with the `msg` Sidekiq builds
(`error_message`, `error_class`, `retry_count`, `failed_at`/`retried_at`); a hook that raises is
logged. The worker refuses to start a ported job whose Ruby class defines either block without
its port. Not reproduced: an exhausted hook's `:discard` (BullMQ keeps the failed job anyway).

Uniqueness for Node-run jobs uses the same unique-jobs keys as Ruby, not BullMQ's deduplication,
so a Ruby enqueue and a Node enqueue of the same job keep deduplicating while both exist. The
worker runs every lock type's server half as the gem's server middleware does (`processor.ts`):
it re-prepares the fetched item (`prepareServerItem`: no `at`, digest recomputed), releases
`until_executed` after every attempt and `until_executing` before the run, and holds the
`<digest>:RUN` runtime lock around the run for `while_executing` and `until_and_while_executing`,
blocking up to `lock_timeout` (at least one second) on a borrowed connection. A runtime conflict
applies the server `on_conflict` (`log`, `raise`, `reschedule`, or none); `replace` and `reject`
are refused at worker start. `__fixtures__/generate-server-locks-golden.rb` records the real gem's
keyspace for each case, including two jobs contending, and `server-locks.integration.test.ts`
replays it. The gem's death handler (delete the digest when retries are exhausted) and its orphan
reaper are not ported.

Node-owned cron entries become BullMQ job schedulers named after the `sidekiq_schedule.yml` key,
in UTC. The lock a sidekiq-cron push would take is taken when the fire starts.

The worker is `npm run worker` (critical, default, low, exports, plus the Rails bridge) and
`npm run worker -- --queues long`, mirroring `docker/web/sidekiq_worker.sh`. BullMQ has no strict
cross-queue priority, so each queue gets its own concurrency (`WORKER_CONCURRENCY_<QUEUE>`)
instead.

Configuration: `SIDEKIQ_REDIS_HOST` (as Rails; `redis://<host>`), optional `BULLMQ_REDIS_URL`
(defaults to the Sidekiq server). Integration tests: `JOBS_REDIS_URL=redis://127.0.0.1:6379/15 npm test`
(they flush that database).

## Porting a job

1. Write the handler in `src/worker/jobs/` and add it to `JOB_HANDLERS`.
2. Add the class to `ported-jobs.ts`, run `npm run jobs:generate`, and commit the regenerated files
   (including `node-owned-jobs.generated.json`, which Rails reads).
3. Keep the Ruby class and its `sidekiq_options`: Ruby callers still need the constant, and jobs
   already sitting in Sidekiq queues or the retry set still run in Ruby until they drain.
4. Delete the Ruby body only once the retry window has passed.

`LogResendEventJob` is the reference port.

## How Rails enqueues a job that now runs in Node

**Decision: a Sidekiq client middleware (`lib/sidekiq_node_bridge.rb`) that diverts the push into
a Redis list, which the Node worker drains into BullMQ.**

The middleware runs after `SidekiqUniqueJobs::Middleware::Client`, so the lock is already held and
the payload is final; for a class in `node-owned-jobs.generated.json` it LPUSHes the payload to
`nextjs:bridge:inbox` and halts the Sidekiq push. `src/worker/bridge.ts` moves each entry to a
processing list (`BLMOVE`), adds it to BullMQ with the jid as the job id, and removes it. Adding
is idempotent, so entries a crashed consumer left behind are replayed on start.

Alternatives considered:

- **A Ruby client that writes BullMQ jobs directly.** BullMQ's job layout is internal and changes
  between versions (its Lua `addJob` touches markers, events, priority and dedupe keys); a Ruby
  copy would break silently on a BullMQ upgrade.
- **An internal HTTP endpoint on Next.js.** Puts Next.js availability and latency inside every
  Rails request and transaction that enqueues a job, and needs auth and retries of its own.

Trade-offs of the bridge: one extra Redis hop and a Node consumer that must be running (entries
wait durably in the inbox if it is not); the diverted `perform_async` returns `nil`, as a
deduplicated one does; the inbox is not visible in Sidekiq Web.

Wiring it in is not done in this change (Ruby is outside this workstream). It is two lines in
`config/initializers/sidekiq.rb` (after the unique-jobs client middleware, in both
`configure_client` and `configure_server`):

```ruby
chain.add SidekiqNodeBridge
```

and one in `config/initializers/sidekiq_cron.rb`, so Ruby stops firing cron entries that Node
schedules:

```ruby
Sidekiq::Cron::Job.load_from_hash!(SidekiqNodeBridge.ruby_schedule(sidekiq_schedule), source: "schedule")
```

## Risks

- **Uniqueness races.** Lock and push are separate steps on both sides, as in the gem: a crash
  between them strands the lock until its TTL, and jobs with no `lock_ttl` strand it forever.
  `enqueue()` releases the lock if the BullMQ add throws, which covers errors but not a crash.
  `until_executing`'s relock on failure is not atomic with the failure, in Ruby either.
- **Clock skew.** The Lua scores locks with the caller's clock; Node and Ruby hosts must agree.
- **Gem upgrades.** A sidekiq or sidekiq-unique-jobs upgrade can change payload keys or Lua.
  Regenerate the golden file and the Lua with the new versions; the tests then show any drift.
- **Batches.** Sidekiq Pro batches are not used anywhere in `app/` or `lib/`, so there is no
  `bid` to carry. If one is introduced it must stay in Ruby until batches have a design here.
- **ActiveJob.** ActiveJob classes in `app/jobs` go through `Sidekiq::ActiveJob::Wrapper` with a
  different payload and are not in the registry.

## Handing a job back to Rails

A ported job that meets a case Node can't run yet throws `HandBackToRuby` (`hand-back.ts`). The
worker then pushes the original item onto its Sidekiq queue, without `at`, and completes the
BullMQ job, so Rails' Sidekiq runs the Ruby class from the start. That is only correct before the
job's first write: wrap argument checks and early reads in `beforeSideEffects`, which turns a
`NotPortedError` into a hand-back. A `NotPortedError` anywhere else still fails the attempt and
goes through Sidekiq's retry.

One exception: `SendWorkflowInstallmentWorker` hands back after its `SentPostEmail` claim, because
what it can't render is only known then. It deletes the claim first, as Rails does for a send it
withholds (`Installment#send_email`), so the rerun in Rails claims and sends. Nothing else it wrote
by then needs undoing; keep it that way when extending it.

## Ported subscription reminder jobs (WS-46)

`subscription-reminder-jobs.ts` ports `FreeTrialExpiringReminderWorker`, `ChargeDeclinedReminderWorker`,
`RecurringChargeReminderWorker`, `ReviewReminderJob`, `SendAutoInvoiceEmailJob` and
`FindSubscriptionsWithMissingChargeWorker`. They queue mail with `deliverLater` (Rails delivers it). Hand-backs: a buyer
eligible for an auto invoice (`CustomerMailer.auto_invoice` is sent inline and is not ported); a missing-charge sweep that meets
an installment plan priced with purchasing power parity (WS-48 ported the offer-code and installment-plan pricing, see
`models/README.md`); anything `NotPortedError` names in `models/README.md`.
`FindSubscriptionsWithMissingChargeWorker` holds its `RecurringChargeWorker` pushes until the sweep ends so that a hand-back
leaves nothing queued; a failure part-way flushes the batches already judged, as Ruby had pushed them.

`perform_in` and `perform_at` build the item without Setter, so their payload has `class` before `args` and no `at` when
the time is not in the future; `scheduled` in `BuildItemInput` selects that shape.

## Ported refund and dispute jobs (WS-49)

`refund-dispute-jobs.ts` ports `FightDisputesJob`, `DispatchPendingFailedRefundExceptionsJob`, `NotifyFailedRefundExceptionJob` and
`RefundUnpaidPurchasesWorker` in full. `ErrorNotifier.notify` goes to Sentry (`notifyError`); the Ruby jobs pass `context:` as a
keyword, so Sentry's extra scope is `{ context: {...} }` and the port keeps that shape. `FightDisputeJob` and `RefundPurchaseWorker`
(what these push) stay in Ruby: both end in charge-processor calls.

Hand-backs, all before the job's first write:

- `RecoverPendingRefundFeeRetentionJob`: an empty sweep, or refunds whose fee is no longer pending, run in Node
  (`purchase.with_lock { reload.fee_retention_pending }`, and Ruby's per-refund rescue that reports and moves on). The first
  refund still pending goes to Rails, which looks up Stripe transfers and writes ledger rows; a refund Node reported before that
  is reported again by Rails.
- `CreateMissingDisputeEvidenceJob`: an empty scan runs in Node; a dispute in it goes to Rails (evidence attachments, the
  processor's deadline, the seller's notice).
- A job argument that is not an Integer or its digits (`FailedRefundException.find("abc")`).

## Ported workflow and installment jobs (WS-51)

`workflow-jobs.ts` ports `ScheduleWorkflowEmailsWorker`, `UpdateInstallmentEventsCountCacheWorker`, `FlushInstallmentDeliveredDeltasJob`,
`ScheduleAffiliateWorkflowJobsJob` and the guard of `SendWorkflowInstallmentRescheduleJob`. `SendWorkflowInstallmentWorker`, which most of them
push, still runs in Rails. `ScheduleWorkflowEmailsWorker` decides every push before making the first, so a hand-back leaves nothing queued.
`FlushInstallmentDeliveredDeltasJob` (a cron entry) swallows Redis failures like the Ruby, and puts a delta back when the `UPDATE` fails.

Hand-backs, all before the job's first write:

- `SendWorkflowInstallmentRescheduleJob` with exactly one recipient: it runs `SendWorkflowInstallmentWorker`.
- `ScheduleAffiliateWorkflowJobsJob` with a token that has assignments (`DirectAffiliate#schedule_workflow_jobs`); the sweep without a token and a
  token with no assignments run in Node.
- Any of the above (and `SetSubscriptionAsDeactivatedWorker`'s member cancellation workflows) when a workflow filter holds a value Node does not
  judge; see `models/README.md`.

## Installment writes and the jobs they unblock (WS-63)

Supersedes the hand-back lists of the WS-51 section for what follows. Models: see `models/README.md`.

- `SendWorkflowInstallmentWorker` reads the rule version like Ruby (`current_rule_version`: cache, pending token, a locked read of the rule that is
  cached with the Lua script) and no longer hands back a stale version or a reschedule reference time: it matches the recipient against the current
  audience (`AudienceMember.filter`) and queues `SendWorkflowInstallmentRescheduleJob`. What it still hands back, before its first write: a filter or
  reference time Node does not read (`installment-reschedule.ts`). After its `SentPostEmail` claim: the cases of WS-59 (a post with files, a seller in
  the newsletter cutover, a template Node cannot render).
- `SendWorkflowInstallmentRescheduleJob` runs the worker for exactly one recipient.
- `ScheduleAffiliateWorkflowJobsJob` with a token schedules each affiliate's workflows. An affiliate is judged in full before its first push, so a
  hand-back leaves nothing queued for it. Affiliates before it were completed and their token cleared, so Rails, rerunning the job, finds only the
  assignments still holding the token. That is the one hand-back in this file that comes after a write, and it is safe for that reason.
- `ScheduleWorkflowInstallmentJob` re-schedules restarted memberships after a delay edit (`workflow-resubscribed-memberships.ts`). Workflows that exclude
  buyers of other products go back to Rails before the fanout is claimed: claiming first would make Rails skip the intent.
- `SendLastPostJob`: a post with files hands back after the claim (deleted again), as the worker does.
- `PublishScheduledPostJob`: guards in Node; `publish!` runs in Node for a post that does not email its audience. The rest hands back from inside the
  lock, before the publish writes (the transaction rolls back). Posts that email their audience are the common case for scheduled posts, so this job
  mostly hands back until the sending-limit count (Elasticsearch) and `PostEmailBlast` are ported.

## Ported payment processor jobs (WS-66)

`payment-processor-jobs.ts` ports `LargeSellersUpdateUserBalanceStatsCacheWorker` in full (Redis threshold and exclusion reads, `push_bulk` with
staggered `at`; a Redis failure queues nobody, as `cacheable_users` does) and the guards of seven jobs whose work is a payment processor call or a
ledger write. Everything past a guard is handed back to Rails before the first write:

- `HandleStripeEventWorker`: an event type `StripeEventHandler` does not handle runs in Node (Ruby only logs it); every handled type goes to Rails.
- `ExecuteScheduledPayoutsJob`, `SyncStuckPayoutsJob`: an empty first `find_each` batch runs in Node; a due or stuck row goes to Rails (`execute!`, `sync_with_payout_processor`).
- `UpdatePayoutStatusWorker`: a payment that is not `processing` runs in Node; a processing one (PayPal lookup) goes to Rails.
- `FailAbandonedPurchaseWorker`: not `in_progress`, and the 15 minute SCA guard (`perform_at`), run in Node; the Stripe intent handling goes to Rails.
- `LowBalanceFraudCheckWorker`: a balance above -$100 runs in Node; probation and the admin mail go to Rails.
- `HandlePayoutReversedWorker`: the `Stripe::Payout.retrieve` GET, the failed branch and the timeout raise run in Node; a paid payout with an available
  balance transaction goes to Rails after the GET and `Payment.find` (both reads), because the reversal writes credits.

Golden: `__fixtures__/payment-processor-jobs.golden.json` (`scripts/golden/payment-processor-jobs.rb`, 74 cases: every statement, Sidekiq payloads and unique
locks, and the Stripe requests the real gem sent to a capture server). Not ported, still Ruby: `RefundPurchaseWorker`, `FightDisputeJob`, the payout
processors (`PayoutUsersWorker`, `PerformPayouts*`, `ProcessPaymentWorker`), `StripeMerchantAccountManager` jobs and `UpdateUserBalanceStatsCacheWorker`
(its `payout_period_data` aggregates are not ported).

## Scheduled posts that email, and the guards of four refund and payout jobs (WS-74)

Supersedes the last bullet of the WS-63 section: `PublishScheduledPostJob` now runs a post that emails its audience in Node. After
`publish!` it asks `can_be_blasted?` (`send_emails?` and no `post_email_blasts` row for the post), creates the `PostEmailBlast`
(`requested_at` is the rule's `to_be_published_at`) and pushes `SendPostBlastEmailsJob` with the blast id, inside the lock, as Ruby does.
`SendPostBlastEmailsJob` itself stays in Ruby. The sending-limit validation this needed is in `models/README.md` (WS-74). Still handed back,
before the first write: a post with files, a call to action, a message the sanitizer would judge, a post without a slug, a seller content moderation
would review, and a "has not clicked" audience (it asks DynamoDB). Golden: `publish-scheduled-post.golden.json` (45 cases now).

`refund-payout-guard-jobs.ts` ports the guards of four jobs and hands everything past them back before the first write:

- `RefundPurchaseWorker`: a purchase that does not exist fails with `RecordNotFound`, as in Ruby; an existing one (the refund, the fraud path) goes to Rails.
- `FightDisputeJob`: a missing dispute or one without evidence fails as in Ruby, resolved evidence and an open window (`DisputeEvidence.window_open?`,
  exact comparison) return; a closed window goes to Rails (it reads the disputable, resolves the evidence and forwards it to the processor).
- `PayoutUsersWorker`: no users (`Array.wrap(nil)`, `[]`) is a no-op; any user goes to Rails (`Payouts.create_payments` and the processors).
- `UpdateUserBalanceStatsCacheWorker`: a missing user fails as in Ruby; any user goes to Rails, because the cached blob needs
  `PayoutsHelper#payout_period_data`, which is not ported (see `models/user-balance-stats.ts` for what is).

Golden: `refund-payout-guard-jobs.golden.json` (`scripts/golden/refund-payout-guard-jobs.rb`, 20 cases; the real jobs are run up to a marker
exception standing in for the call Node does not make).

## SendPurchaseReceiptJob (WS-76)

Ported in `worker/jobs/send-purchase-receipt-job.ts` (golden: the `jobs` cases of `mail/__fixtures__/receipt-mailer.golden.json`, 9 cases: first
send, a second provider, already sent, an explicit resend, a bundle product purchase, no URL redirect, a missing purchase, and the two hand-backs).
It reads in Rails' order (`Purchase.find`, the URL redirect, the link and its product files for `has_stampable_pdfs?`, the `CustomerEmailInfo`
guard), renders `CustomerMailer#receipt` with the Node port, sends over SMTP and writes the `CustomerEmailInfo`.

- Handed back (`HandBackToRuby`, before the first write): a purchase whose PDFs must be stamped and not yet are, and any receipt the Node renderer
  refuses (`mail/README.md`, "CustomerMailer#receipt"). The enqueue of `StampPdfForPurchaseJob` is the first write, so the check reads only.
- A read failure while checking for stamping is kept and raised after the mail, as the Ruby `rescue StandardError => e; e` does.
- Not ported: `SendChargeReceiptJob` (charge receipts, `receipt_sent`, `with_lock`, the auto invoice enqueue) and everything that calls
  `CustomerMailer.receipt` with a charge.

## Installments and workflows written by the controllers (WS-82)

`PublishScheduledPostJob` no longer hands back a post without a slug: `Installment` generates it (friendly_id) before the save. The post still hands back for files, a call to
action, markup the sanitizer would judge, a "has not clicked" audience and a content-moderation review. `SaveInstallmentService` enqueues `PublishScheduledPostJob`
(`perform_at`), `SendPostBlastEmailsJob` and the `ElasticsearchIndexerWorker` index/update jobs; see `models/README.md` (WS-82).

## Ported small jobs that hand back whole (ws-jobs-small-1)

`annual-payout-export-worker.ts`, `exports-sales-chunk-workers.ts` (`Exports::Sales::CompileChunksWorker` and
`ProcessChunkWorker`) and `reissue-ssl-certificate-for-updated-custom-domains.ts` run only the reads that open the Ruby job and hand
the whole job back before its first write: the user, the export or the chunk and its export, or the scan of alive custom domains with a
certificate (an empty scan finishes in Node). What follows is S3, a mail with an attachment, DNS or the ACME order, or sits inside
`WithMaxExecutionTime.timeout_queries` (a session `set max_execution_time` a pooled Node connection cannot hold). Goldens come from
`scripts/golden/` run in a Ruby container; the replay accepts a hand-back after a prefix of Rails' statements, so
`exports-sales-chunk-workers.test.ts` also pins the chunk worker to both of its reads.

Left in Ruby: `PdfUnstampableNotifierWorker` is a constant alias of the already ported `PdfUnstampableNotifierJob` (the registry lists
it as Ruby only because the file stays for items queued under the old name); `AnnualTaxSummaryExportWorker` has no branch short of the
full user scan, the S3 upload and the mail; `ProcessPurchaseEarlyFraudWarningJob` is money-adjacent.

## Ported small jobs, second batch (ws-jobs-small-2)

Fully in Node: `DispatchPendingPartnerMigrationNotificationsJob` (the join and `find_each` push `PartnerMigrationNotificationJob`) and
`ScheduleOpenedNoClickWorkflowEmailsJob` (the workflow join, batches of 200). `DispatchProductPublishSchedulesJob` queues the due publishes
and the notices unsent for 2 minutes; a stale claim (`recover_stale_claim!` writes) goes back to Rails after the scan with nothing pushed, so
the run is not half done. `ResumeStalledPartnerMigrationsJob`, `PublishScheduledProductJob` and `SendProductPublishScheduleNoticeJob` run only
the read that opens the Ruby job (the `stalled` scan, `find_by(id:)`, `notice_unsent.find_by(id:)`) and hand the whole job back when it finds a
row: what follows claims or locks rows, publishes the product, enqueues the import or mails through `CreatorMailer`. These tables have no
Prisma model, so the reads are raw SQL. Goldens come from `scripts/golden/`; the dispatcher's replay needs `JOBS_REDIS_URL` for the notice
job's unique-jobs lock.

Left in Ruby: `HandlePaypalEventWorker`, `PerformDailyInstantPayoutsWorker`, `ProcessPurchaseEarlyFraudWarningJob` (money), `GenerateAvatarVariantJob`
(its first read leads straight to an Active Storage resize), `AnnualTaxSummaryExportWorker` (see above).

## ExportPayoutData (ws-jobs-small-10)

`export-payout-data.ts` runs `Payment.where(id: ...).find_each` in Node and finishes a job that finds no payment (an empty list or nil sends
no statement, as in Rails). A payment that is found goes back whole: the CSV (`Exports::Payouts::Csv`) is built before the same-seller
check, and the zip and the mail with the file attached are `deliver_now`. An id Rails casts (a word reads as NULL) goes back before any
read. Golden: `scripts/golden/export-payout-data.rb`. `SendYearInReviewEmailJob`, `AnnualTaxSummaryExportWorker` and
`PostToPingEndpointsWorker` stay in Ruby.
