import type { User } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Errors } from "../../models/runtime/errors.ts";

const mocks = vi.hoisted(() => ({
  db: { refundPolicy: { findFirst: vi.fn() } },
  isFeatureEnabled: vi.fn(),
  update: vi.fn(),
}));
vi.mock("../../../lib/db.ts", () => ({ db: mocks.db }));
vi.mock("../../infra/flipper.ts", () => ({ isFeatureEnabled: mocks.isFeatureEnabled, userActor: (id: unknown) => id }));
vi.mock("../../models/refund-policy.ts", () => ({
  RefundPolicies: { load: (row: unknown) => ({ row, errors: new Errors() }), update: mocks.update },
}));

const { updateRefundPolicy } = await import("./refund-policies.ts");
const { NotPortedError } = await import("../../page-props/not-ported.ts");

// User flag 46, refund_policy_enabled
const REFUND_POLICY_ENABLED_FLAG = 1n << 45n;
const owner = { id: 7n, flags: REFUND_POLICY_ENABLED_FLAG } as unknown as User;
const stored = { id: 1n, seller_id: 7n, product_id: null, fine_print: null, max_refund_period_in_days: 30 };
const run = (params: Record<string, unknown>, seller: User = owner) =>
  updateRefundPolicy({ owner: seller, params } as never);
const bodyOf = (rendered: unknown) =>
  JSON.parse(String((rendered as { body: string }).body)) as Record<string, unknown>;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.isFeatureEnabled.mockResolvedValue(false);
  mocks.db.refundPolicy.findFirst.mockResolvedValue(stored);
  mocks.update.mockResolvedValue(true);
});

describe("PUT /v2/refund_policy", () => {
  it("answers that the policy is not in effect before looking at the parameters", async () => {
    const disabled = { ...owner, flags: 0n } as User;

    expect(bodyOf(await run({}, disabled))).toEqual({
      success: false,
      message: "The account-level refund policy is not in effect for this seller.",
    });
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it.each([{}, { refund_period: "" }, { refund_period: "  " }, { refund_period: null }])(
    "requires a refund period for %j",
    async (params) => {
      expect(bodyOf(await run(params))).toEqual({ success: false, message: "Refund period is required." });
      expect(mocks.update).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["none", 0],
    ["7", 7],
    ["14", 14],
    ["30", 30],
    ["183", 183],
  ])("maps %s to %i days", async (period, days) => {
    await run({ refund_period: period });

    expect(mocks.update).toHaveBeenCalledWith(expect.anything(), { max_refund_period_in_days: days });
  });

  it.each(["0", "365", "constructor", "None"])("assigns no period for %s, which the model rejects", async (period) => {
    await run({ refund_period: period });

    expect(mocks.update).toHaveBeenCalledWith(expect.anything(), { max_refund_period_in_days: null });
  });

  it("assigns the fine print only when the parameter is present, null included", async () => {
    await run({ refund_period: "none", fine_print: null });
    await run({ refund_period: "none" });

    expect(mocks.update.mock.calls.map((call) => call[1])).toEqual([
      { max_refund_period_in_days: 0, fine_print: null },
      { max_refund_period_in_days: 0 },
    ]);
  });

  it.each([
    { refund_period: 14 },
    { refund_period: ["14"] },
    { refund_period: "14", fine_print: ["x"] },
    { refund_period: "14", fine_print: 5 },
  ])("hands %j back to Rails before writing", async (params) => {
    await expect(run(params)).rejects.toBeInstanceOf(NotPortedError);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("names the allowed periods when the period is not included", async () => {
    mocks.update.mockImplementation(async (policy: { errors: Errors }) => {
      policy.errors.add("max_refund_period_in_days", "inclusion");
      return false;
    });

    expect(bodyOf(await run({ refund_period: "365" }))).toEqual({
      success: false,
      message: "Refund period must be one of: none, 7, 14, 30, 183.",
    });
  });

  it("joins the model's other errors as a sentence", async () => {
    mocks.update.mockImplementation(async (policy: { errors: Errors }) => {
      policy.errors.add("fine_print", "too_long", { count: 3000 });
      policy.errors.add("max_refund_period_in_days", "must offer a refund period of at least 7 days");
      return false;
    });

    expect(bodyOf(await run({ refund_period: "none" }))).toEqual({
      success: false,
      message:
        "Fine print is too long (maximum is 3000 characters) and Max refund period in days must offer a refund period of at least 7 days",
    });
  });

  it("renders the stored policy after a save", async () => {
    mocks.db.refundPolicy.findFirst.mockResolvedValue({
      ...stored,
      max_refund_period_in_days: 0,
      fine_print: "All sales are final.",
    });

    expect(bodyOf(await run({ refund_period: "none", fine_print: "All sales are final." }))).toEqual({
      success: true,
      refund_policy: {
        refund_period: "none",
        title: "No refunds allowed",
        fine_print: "All sales are final.",
        in_effect: true,
      },
    });
  });
});
