// The writes of WorkflowInstallmentScheduleIntent that schedule a workflow installment: `enqueue!`, `mark_processed!` and
// `claim_fanout!` (app/models/workflow_installment_schedule_intent.rb). The dispatch lease half is in
// workflow-installment-schedule-intent.ts. Golden: worker/jobs/__fixtures__/schedule-workflow-installment.golden.json.
import { afterCommitEverywhere } from "./concerns/job-runtime.ts";
import { advance } from "./concerns/ruby-time.ts";
import { currentTransaction } from "./runtime/transaction.ts";
import { EnqueueError, enqueueIntent, FANOUT_LEASE, WorkflowInstallmentScheduleIntents, type Deps } from "./workflow-installment-schedule-intent.ts";

export type IntentRecord = ReturnType<typeof WorkflowInstallmentScheduleIntents.load>;

// `enqueue!`: the intent is written inside the caller's transaction, and its dispatch is enqueued once that commits.
export async function enqueueBang(
  input: { installmentId: number; ruleVersion: number; oldDelayedDeliveryTime: number | null; cutoffReferenceTime: Date; expectedPublishedAt?: Date | null },
  deps: Deps,
): Promise<IntentRecord> {
  if (currentTransaction() === null) throw new EnqueueError("A database transaction is required");
  const token = deps.uuid();
  const intent = await WorkflowInstallmentScheduleIntents.createBang(
    {
      token,
      installment_id: input.installmentId,
      rule_version: input.ruleVersion,
      old_delayed_delivery_time: input.oldDelayedDeliveryTime,
      cutoff_reference_time: input.cutoffReferenceTime,
      expected_published_at: input.expectedPublishedAt ?? null,
    },
    { now: deps.now },
  );
  await afterCommitEverywhere(async () => {
    await enqueueIntent(token, deps);
  });
  return intent;
}

// `mark_processed!`
export async function markProcessedBang(intent: IntentRecord, deps: Pick<Deps, "now">): Promise<void> {
  await WorkflowInstallmentScheduleIntents.updateBang(
    intent,
    { processed_at: deps.now(), dispatch_token: null, dispatch_expires_at: null, fanout_token: null, fanout_expires_at: null },
    { now: deps.now },
  );
}

// Whether `claim_fanout!` would write: not for a processed intent, nor one whose fanout lease is still held.
export function fanoutClaimable(intent: IntentRecord, now: Date): boolean {
  if (intent.get("processed_at") != null) return false;
  const expires = intent.get("fanout_expires_at");
  return !(expires != null && expires.getTime() > now.getTime());
}

// `claim_fanout!`: the owner token of the new fanout, or null when the intent is processed or already fanning out.
export async function claimFanoutBang(intent: IntentRecord, deps: Deps): Promise<string | null> {
  const now = deps.now();
  if (!fanoutClaimable(intent, now)) return null;
  const owner = deps.uuid();
  await WorkflowInstallmentScheduleIntents.updateBang(intent, { fanout_token: owner, fanout_expires_at: advance(now, FANOUT_LEASE) }, { now: deps.now });
  return owner;
}
