// The scheduled payout action of SuspendUsersWorker, with the reads and writes around it replaced: what
// matters here is which processor is stored and that a seller whose processor needs PayPal's API is
// handed to Rails before anybody is suspended.
import { beforeEach, describe, expect, it, vi } from "vitest";

const findInBatches = vi.hoisted(() => vi.fn());
const selectRows = vi.hoisted(() => vi.fn());
const fireRiskEvent = vi.hoisted(() => vi.fn());
const createScheduledPayout = vi.hoisted(() => vi.fn());
const createComment = vi.hoisted(() => vi.fn());
const findUserBang = vi.hoisted(() => vi.fn());
const currentPayoutProcessor = vi.hoisted(() => vi.fn());
const paypalPayoutEmailNeedsApi = vi.hoisted(() => vi.fn());

vi.mock("../../server/models/sql.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../server/models/sql.ts")>()),
  findInBatches,
  selectRows,
}));
vi.mock("../../server/models/user-risk.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../server/models/user-risk.ts")>()),
  fireRiskEvent,
}));
vi.mock("../../server/models/scheduled-payout.ts", () => ({ ScheduledPayouts: { createBang: createScheduledPayout } }));
vi.mock("../../server/models/comment.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../server/models/comment.ts")>()),
  Comments: { createBang: createComment },
}));
vi.mock("../../server/models/user.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../server/models/user.ts")>()),
  findUserBang,
}));
vi.mock("../../server/models/current-payout-processor.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../server/models/current-payout-processor.ts")>()),
  currentPayoutProcessor,
  paypalPayoutEmailNeedsApi,
}));

import { createJobsRuntime } from "../../server/jobs/runtime.ts";

import {
  asSidekiqJob,
  contextFor,
  recordingSidekiqRedis,
  rubyRuntimeRegistry,
  sequentialJids,
} from "./__fixtures__/golden.ts";
import { suspendUsersWorkerWith } from "./suspend-jobs.ts";

const NOW = new Date("2026-01-15T12:00:00Z");
const handler = suspendUsersWorkerWith({ now: () => NOW });

const run = (scheduledPayout: Record<string, unknown>) => {
  const recording = recordingSidekiqRedis();
  const runtime = createJobsRuntime({
    sidekiqRedis: recording.redis,
    bullmqRedis: recording.redis,
    registry: rubyRuntimeRegistry(),
    now: () => NOW.getTime() / 1000,
    newJid: sequentialJids(),
  });
  return asSidekiqJob(
    () => handler([3, ["5"], "spam", null, scheduledPayout as never], contextFor(runtime)),
    NOW.getTime() / 1000,
  );
};

const row = (riskState: string) => ({ id: 5n, user_risk_state: riskState, payment_address: null, name: null });

beforeEach(() => {
  for (const mock of [
    findInBatches,
    selectRows,
    fireRiskEvent,
    createScheduledPayout,
    createComment,
    findUserBang,
    currentPayoutProcessor,
    paypalPayoutEmailNeedsApi,
  ])
    mock.mockReset();
  findUserBang.mockResolvedValue({
    get: (name: string) => (name === "id" ? 3n : name === "name" ? "Admin" : name === "username" ? "admin" : null),
  });
  selectRows.mockResolvedValue([{ sum: 4_500n }]);
  paypalPayoutEmailNeedsApi.mockResolvedValue(false);
  currentPayoutProcessor.mockResolvedValue("STRIPE");
  createScheduledPayout.mockResolvedValue({
    get: (name: string) =>
      name === "action" ? "payout" : name === "delay_days" ? 21 : new Date("2026-02-05T12:00:00Z"),
  });
  createComment.mockResolvedValue({});
  findInBatches.mockImplementation(
    async (_table: string, _where: unknown, _size: number, each: (rows: unknown[]) => Promise<void>) =>
      each([row("compliant")]),
  );
  fireRiskEvent.mockImplementation(async (user: { set: (name: string, value: unknown) => void }) => {
    user.set("user_risk_state", "suspended_for_tos_violation");
    return true;
  });
});

describe("SuspendUsersWorker with a payout action", () => {
  it("stores the processor the seller is paid through on the scheduled payout", async () => {
    currentPayoutProcessor.mockResolvedValue("PAYPAL");
    await run({ action: "payout" });
    expect(createScheduledPayout).toHaveBeenCalledTimes(1);
    expect(createScheduledPayout.mock.calls[0]![0]).toMatchObject({
      action: "payout",
      processor: "PAYPAL",
      delay_days: 21,
      payout_amount_cents: 4_500n,
    });
  });

  it("stores no processor for a hold action", async () => {
    await run({ action: "hold" });
    expect(currentPayoutProcessor).not.toHaveBeenCalled();
    expect(createScheduledPayout.mock.calls[0]![0]).toMatchObject({ action: "hold", processor: null });
  });

  it("hands the job back before suspending anybody when a seller's PayPal email needs PayPal's API", async () => {
    paypalPayoutEmailNeedsApi.mockResolvedValue(true);
    await expect(run({ action: "payout" })).rejects.toMatchObject({ name: "HandBackToRuby" });
    expect(fireRiskEvent).not.toHaveBeenCalled();
    expect(createScheduledPayout).not.toHaveBeenCalled();
  });

  it("does not check a seller who is already suspended, whom Rails skips", async () => {
    paypalPayoutEmailNeedsApi.mockResolvedValue(true);
    findInBatches.mockImplementation(
      async (_table: string, _where: unknown, _size: number, each: (rows: unknown[]) => Promise<void>) =>
        each([row("suspended_for_fraud")]),
    );
    await run({ action: "payout" });
    expect(paypalPayoutEmailNeedsApi).not.toHaveBeenCalled();
    expect(createScheduledPayout).not.toHaveBeenCalled();
  });
});
