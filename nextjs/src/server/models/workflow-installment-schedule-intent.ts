// Port of app/models/workflow_installment_schedule_intent.rb: validations, the pending/dispatchable
// scopes and the dispatch lease (enqueue, claim_dispatch, release_dispatch). Not ported yet:
// enqueue!, mark_processed(!), claim_fanout!, begin_fanout, renew_fanout, defer_fanout; see
// models/README.md.
import { Prisma, type WorkflowInstallmentScheduleIntent } from "@prisma/client";

import { performAsync } from "./concerns/job-runtime.ts";
import { advance } from "./concerns/ruby-time.ts";
import { defineModel } from "./runtime/define-model.ts";
import { transaction } from "./runtime/transaction.ts";
import { validatesPresenceOf } from "./runtime/validators.ts";
import { castRow, column, execute, selectRows, table } from "./sql.ts";

const TABLE = "workflow_installment_schedule_intents";
export const WORKFLOW_INSTALLMENT_SCHEDULE_INTENTS = TABLE;

export const DISPATCH_LEASE = { minutes: 15 };
export const FANOUT_LEASE = { hours: 2 };
export const FANOUT_HEARTBEAT_INTERVAL = { minutes: 5 };

export class EnqueueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowInstallmentScheduleIntent::EnqueueError";
  }
}

export const WorkflowInstallmentScheduleIntents = defineModel<WorkflowInstallmentScheduleIntent>({
  rubyClass: "WorkflowInstallmentScheduleIntent",
  prismaModel: "WorkflowInstallmentScheduleIntent",
  delegate: (tx) => tx.workflowInstallmentScheduleIntent as never,
  validations: [validatesPresenceOf<WorkflowInstallmentScheduleIntent>(["token", "installment_id", "rule_version", "cutoff_reference_time"])],
});

export const pendingScope = () => Prisma.sql`${column(TABLE, "processed_at")} IS NULL`;
export const dispatchableScope = (at: Date) =>
  Prisma.sql`${pendingScope()} AND (dispatch_expires_at IS NULL OR dispatch_expires_at <= ${at}) AND (fanout_expires_at IS NULL OR fanout_expires_at <= ${at})`;

const selectAll = Prisma.raw(`\`${TABLE}\`.*`);

export type Deps = { now: () => Date; uuid: () => string; logError: (message: string) => void };

// `claim_dispatch(token)`: a fresh dispatch token, or null when the intent is gone or leased.
export async function claimDispatch(token: string, deps: Deps): Promise<string | null> {
  const now = deps.now();
  return transaction(async () => {
    const rows = await selectRows(Prisma.sql`SELECT ${selectAll} FROM ${table(TABLE)} WHERE ${dispatchableScope(now)} AND ${column(TABLE, "token")} = ${token} LIMIT 1 FOR UPDATE`);
    if (!rows[0]) return null;
    const intent = WorkflowInstallmentScheduleIntents.load(castRow<WorkflowInstallmentScheduleIntent>("WorkflowInstallmentScheduleIntent", rows[0]));
    const dispatchToken = deps.uuid();
    await WorkflowInstallmentScheduleIntents.updateBang(intent, { dispatch_token: dispatchToken, dispatch_expires_at: advance(now, DISPATCH_LEASE) }, { now: deps.now });
    return dispatchToken;
  });
}

// `release_dispatch(token, dispatch_token)`
export async function releaseDispatch(token: string, dispatchToken: string, deps: Pick<Deps, "now">): Promise<number> {
  const now = deps.now();
  return execute(
    Prisma.sql`UPDATE ${table(TABLE)} SET ${column(TABLE, "dispatch_token")} = NULL, ${column(TABLE, "dispatch_expires_at")} = NULL, ${column(TABLE, "updated_at")} = ${now} WHERE ${pendingScope()} AND ${column(TABLE, "token")} = ${token} AND ${column(TABLE, "dispatch_token")} = ${dispatchToken}`,
  );
}

const errorText = (error: unknown) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error));

// `WorkflowInstallmentScheduleIntent.enqueue(token)`: the jid, or null. Never raises: a failure is
// logged and the lease released so the dispatcher can retry it.
export async function enqueueIntent(token: string, deps: Deps): Promise<string | null> {
  let dispatchToken: string | null = null;
  try {
    dispatchToken = await claimDispatch(token, deps);
    if (dispatchToken === null) return null;
    const jid = await performAsync("ScheduleWorkflowInstallmentJob", [token, dispatchToken]);
    if (!jid) throw new EnqueueError("The scheduler job was not enqueued");
    return jid;
  } catch (error) {
    deps.logError(`[WorkflowInstallmentScheduleIntent] could not enqueue token=${token}: ${errorText(error)}`);
    try {
      if (dispatchToken) await releaseDispatch(token, dispatchToken, deps);
    } catch (releaseError) {
      deps.logError(`[WorkflowInstallmentScheduleIntent] could not release token=${token}: ${errorText(releaseError)}`);
    }
    return null;
  }
}
