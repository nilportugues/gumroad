import { beforeEach, describe, expect, it, vi } from "vitest";

const selectRows = vi.hoisted(() => vi.fn());
vi.mock("./sql.ts", async (importOriginal) => ({ ...(await importOriginal<typeof import("./sql.ts")>()), selectRows }));

import { settledReasonWithoutHistory } from "./low-balance-probation-recovery.ts";
import type { UserRecord } from "./user.ts";

type CommentRow = {
  id: bigint;
  comment_type: string;
  author_id: bigint | null;
  author_name: string | null;
  idempotency_key: string | null;
  deleted_at: Date | null;
};

const PROBATION = "LowBalanceFraudCheck";
const probation = (id: number, overrides: Partial<CommentRow> = {}): CommentRow => ({
  id: BigInt(id),
  comment_type: "on",
  author_id: null,
  author_name: PROBATION,
  idempotency_key: null,
  deleted_at: null,
  ...overrides,
});
const comment = (id: number, commentType: string, overrides: Partial<CommentRow> = {}): CommentRow => ({
  id: BigInt(id),
  comment_type: commentType,
  author_id: null,
  author_name: null,
  idempotency_key: null,
  deleted_at: null,
  ...overrides,
});

const user = (attributes: Record<string, unknown> = {}) => {
  const values: Record<string, unknown> = { id: 5n, user_risk_state: "on_probation", deleted_at: null, ...attributes };
  return { get: (name: string) => values[name] } as unknown as UserRecord;
};

// The balances read comes first, then the comments read.
const answer = (comments: CommentRow[]) => selectRows.mockResolvedValueOnce([]).mockResolvedValueOnce(comments);

beforeEach(() => {
  selectRows.mockReset();
});

describe("settledReasonWithoutHistory", () => {
  it("reads the unpaid balances, then the comments", async () => {
    answer([]);
    await settledReasonWithoutHistory(user());
    expect(selectRows).toHaveBeenCalledTimes(2);
  });

  it("settles a deleted account", async () => {
    answer([probation(1)]);
    expect(await settledReasonWithoutHistory(user({ deleted_at: new Date() }))).toBe("account_deleted");
  });

  it("settles an account without a LowBalanceFraudCheck probation comment", async () => {
    answer([comment(1, "on", { author_name: "Admin" }), probation(2, { author_id: 9n })]);
    expect(await settledReasonWithoutHistory(user())).toBe("no_low_balance_probation");
  });

  it("settles an account whose recovery comment is the last decision and matches its risk state", async () => {
    answer([probation(1), comment(2, "compliant", { idempotency_key: "low_balance_probation_recovery:1" })]);
    expect(await settledReasonWithoutHistory(user({ user_risk_state: "compliant" }))).toBe("already_recovered");
  });

  it("settles a recovery comment without a key when the check wrote it", async () => {
    answer([probation(1), comment(2, "not_reviewed", { author_name: PROBATION })]);
    expect(await settledReasonWithoutHistory(user({ user_risk_state: "not_reviewed" }))).toBe("already_recovered");
  });

  it("does not take another probation's recovery key as its own", async () => {
    answer([probation(1), comment(2, "compliant", { idempotency_key: "low_balance_probation_recovery:99" })]);
    expect(await settledReasonWithoutHistory(user())).toBe("newer_risk_decision");
  });

  it("settles a suspended account", async () => {
    answer([probation(1)]);
    expect(await settledReasonWithoutHistory(user({ user_risk_state: "suspended_for_fraud" }))).toBe("suspended");
  });

  it("settles a flagged account", async () => {
    answer([probation(1)]);
    expect(await settledReasonWithoutHistory(user({ user_risk_state: "flagged_for_tos_violation" }))).toBe("flagged");
  });

  it("settles an account that is no longer on probation", async () => {
    answer([probation(1)]);
    expect(await settledReasonWithoutHistory(user({ user_risk_state: "compliant" }))).toBe("not_on_probation");
  });

  it("settles a probation whose comment was deleted, including a re-assertion in the chain", async () => {
    answer([probation(1, { deleted_at: new Date() }), probation(2)]);
    expect(await settledReasonWithoutHistory(user())).toBe("probation_comment_deleted");
  });

  it.each(["flag_note", "suspension_note", "flagged", "compliant"])(
    "settles a probation followed by a %s decision",
    async (type) => {
      answer([probation(1), comment(2, type, { author_name: "Admin" })]);
      expect(await settledReasonWithoutHistory(user())).toBe("newer_risk_decision");
    },
  );

  it("ignores comments that are not decisions", async () => {
    answer([probation(1), comment(2, "note")]);
    expect(await settledReasonWithoutHistory(user())).toBeNull();
  });

  it("chains re-assertions of the probation and still needs the history", async () => {
    answer([probation(1), probation(2), probation(3)]);
    expect(await settledReasonWithoutHistory(user())).toBeNull();
  });

  it("does not reach a deleted comment behind another decision when chaining", async () => {
    answer([probation(1, { deleted_at: new Date() }), comment(2, "flag_note", { author_name: "Admin" }), probation(3)]);
    expect(await settledReasonWithoutHistory(user())).toBeNull();
  });

  it("needs the history for a single live probation on a probation account", async () => {
    answer([probation(1)]);
    expect(await settledReasonWithoutHistory(user())).toBeNull();
  });
});
