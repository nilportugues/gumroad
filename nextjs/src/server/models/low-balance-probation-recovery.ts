// Port of the read-only exits of LowBalanceProbationRecovery#evaluate_rules
// (app/services/low_balance_probation_recovery.rb): every reason that is settled before the
// PaperTrail binding of the probation transition. Those exits write nothing, so
// `recover_automatically!` returns the precheck as is. An account that gets past them needs the
// version history (bind_probation_transition) and the locked transition, which are not ported.
import { Prisma } from "@prisma/client";

import { COMMENT_TYPES, RISK_STATE_COMMENT_TYPES } from "./comment.ts";
import { connectedTo, uncached } from "./runtime/query-cache.ts";
import { column, selectRows, table } from "./sql.ts";
import { isDeleted, isFlagged, isOnProbation, isSuspended, type UserRecord } from "./user.ts";

const PROBATION_AUTHOR_NAME = "LowBalanceFraudCheck";
const RESTORABLE_STATES: readonly string[] = ["compliant", "not_reviewed"];
const DECISION_COMMENT_TYPES: readonly string[] = [
  ...RISK_STATE_COMMENT_TYPES,
  COMMENT_TYPES.FLAG_NOTE,
  COMMENT_TYPES.SUSPENSION_NOTE,
];

type CommentFacts = {
  id: bigint;
  comment_type: string | null;
  author_id: bigint | null;
  author_name: string | null;
  idempotency_key: string | null;
  deleted_at: Date | null;
};

const idempotencyKey = (probationCommentId: bigint) => `low_balance_probation_recovery:${probationCommentId}`;
const byId = (a: CommentFacts, b: CommentFacts) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

const isLowBalanceProbationComment = (comment: CommentFacts) =>
  comment.comment_type === COMMENT_TYPES.ON_PROBATION &&
  comment.author_name === PROBATION_AUTHOR_NAME &&
  comment.author_id == null;

// A decision made after the probation comment; it ends the probation if it is this recovery's own.
const isRecoveryCommentFor = (comment: CommentFacts, chain: CommentFacts[]) => {
  if (!RESTORABLE_STATES.includes(comment.comment_type ?? "")) return false;
  return (
    chain.some((probation) => comment.idempotency_key === idempotencyKey(probation.id)) ||
    (comment.idempotency_key == null && comment.author_name === PROBATION_AUTHOR_NAME && comment.author_id == null)
  );
};

// The reason `evaluate` settles on without the version history, or null when it needs it.
export async function settledReasonWithoutHistory(user: UserRecord): Promise<string | null> {
  return connectedTo("writing", () =>
    uncached(async () => {
      // unpaid_balances is read first, as evaluate_rules does, even though these exits do not use it.
      await selectRows(
        Prisma.sql`SELECT ${column("balances", "id")}, ${column("balances", "currency")}, ${column("balances", "amount_cents")} FROM ${table("balances")} WHERE ${column("balances", "user_id")} = ${user.get("id")} AND ${column("balances", "state")} = 'unpaid'`,
      );
      const comments = await selectRows<CommentFacts>(
        Prisma.sql`SELECT ${column("comments", "id")}, ${column("comments", "comment_type")}, ${column("comments", "author_id")}, ${column("comments", "author_name")}, ${column("comments", "idempotency_key")}, ${column("comments", "created_at")}, ${column("comments", "deleted_at")} FROM ${table("comments")} WHERE ${column("comments", "commentable_type")} = 'User' AND ${column("comments", "commentable_id")} = ${user.get("id")}`,
      );

      if (isDeleted(user)) return "account_deleted";

      const probations = comments.filter(isLowBalanceProbationComment).sort(byId);
      const latest = probations.at(-1);
      if (latest === undefined) return "no_low_balance_probation";

      const decisions = comments
        .filter((comment) => DECISION_COMMENT_TYPES.includes(comment.comment_type ?? ""))
        .sort(byId);
      const laterDecisions = decisions.filter((comment) => comment.id > latest.id);
      // reassertion_chain: the run of LowBalanceFraudCheck comments ending at `latest`, nothing else between.
      const upToLatest = decisions.filter((comment) => comment.id <= latest.id);
      let start = upToLatest.length;
      while (start > 0 && isLowBalanceProbationComment(upToLatest[start - 1]!)) start -= 1;
      const chain = upToLatest.slice(start);

      const recoveryComment = laterDecisions.find((comment) => isRecoveryCommentFor(comment, chain));
      if (
        recoveryComment !== undefined &&
        recoveryComment === laterDecisions.at(-1) &&
        user.get("user_risk_state") === recoveryComment.comment_type
      )
        return "already_recovered";

      if (isSuspended(user)) return "suspended";
      if (isFlagged(user)) return "flagged";
      if (!isOnProbation(user)) return "not_on_probation";
      if (chain.some((comment) => comment.deleted_at != null)) return "probation_comment_deleted";
      if (laterDecisions.length > 0) return "newer_risk_decision";
      return null;
    }),
  );
}
