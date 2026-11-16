// Read side of app/models/dispute.rb: the state names and the reads the dispute sweeps make. Dispute
// transitions (state_machine, formalization side effects, credits) are Ruby.
// Golden: worker/jobs/__fixtures__/refund-dispute-jobs.golden.json (scripts/golden/refund-dispute-jobs.rb).
import { Prisma, type Dispute, type DisputeEvidence } from "@prisma/client";

import { ago } from "./concerns/ruby-time.ts";
import { uncached } from "./runtime/query-cache.ts";
import { columnIn, inList, castRow, column, selectRows, table } from "./sql.ts";

export const DISPUTES = "disputes";

// FightDisputesJob::TERMINAL_DISPUTE_STATES
export const TERMINAL_DISPUTE_STATES: readonly string[] = ["won", "lost", "closed"];
// CreateMissingDisputeEvidenceJob::OPEN_DISPUTE_STATES
export const OPEN_DISPUTE_STATES = ["created", "initiated", "formalized"] as const;
// CreateMissingDisputeEvidenceJob::LOOKBACK
export const MISSING_EVIDENCE_LOOKBACK = { days: 60 } as const;
// CreateMissingDisputeEvidenceJob::ABANDONED_FORMALIZATION_GRACE
export const ABANDONED_FORMALIZATION_GRACE = { hours: 12 } as const;

const BATCH_SIZE = 1_000;

// `includes(:dispute)` for one batch of evidence rows: a single SELECT over the distinct dispute ids
// (none, no statement), keyed by id. A row whose dispute is gone has no entry.
export async function preloadDisputes(evidences: readonly DisputeEvidence[]): Promise<Map<string, Dispute>> {
  const ids = [...new Set(evidences.map((evidence) => evidence.dispute_id).filter((id) => id != null))];
  if (ids.length === 0) return new Map();
  const rows = await selectRows(Prisma.sql`SELECT ${Prisma.raw("`disputes`.*")} FROM ${table(DISPUTES)} WHERE ${columnIn(DISPUTES, "id", ids)}`);
  return new Map(rows.map((row) => castRow<Dispute>("Dispute", row)).map((dispute) => [String(dispute.id), dispute]));
}

// CreateMissingDisputeEvidenceJob's relation, first `find_each` batch: open disputes inside the
// lookback whose formalization has finished (or was abandoned) and whose evidence row is missing,
// never announced to the seller, or unresolved.
export async function disputesMissingEvidenceFirstBatch(now: Date): Promise<Dispute[]> {
  const d = (name: string) => column(DISPUTES, name);
  const evidences = (name: string) => column("dispute_evidences", name);
  // find_each's batch load skips the query cache.
  const rows = await uncached(() =>
    selectRows(
      Prisma.sql`SELECT ${Prisma.raw("`disputes`.*")} FROM ${table(DISPUTES)} LEFT OUTER JOIN ${table("dispute_evidences")} ON ${evidences("dispute_id")} = ${d("id")} WHERE ${d("state")} IN ${inList(OPEN_DISPUTE_STATES)} AND ${d("event_created_at")} >= ${ago(MISSING_EVIDENCE_LOOKBACK, now)} AND ((disputes.formalized_side_effects_finished_at IS NOT NULL OR COALESCE(disputes.formalized_at, disputes.created_at) < ${ago(ABANDONED_FORMALIZATION_GRACE, now)})) AND ${evidences("seller_contacted_at")} IS NULL AND ${evidences("resolved_at")} IS NULL ORDER BY ${d("id")} ASC LIMIT ${Prisma.raw(String(BATCH_SIZE))}`,
    ),
  );
  return rows.map((row) => castRow<Dispute>("Dispute", row));
}
