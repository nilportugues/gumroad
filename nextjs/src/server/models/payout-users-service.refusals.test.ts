// What payout-users-service.ts does with a NotPortedError at the points the golden cannot reach: a refusal is a hand-back only while
// nothing has been written (before the claim commits, before the payout request leaves).
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  notifyError: vi.fn(),
  performPaymentBang: vi.fn(),
  processPaymentsBang: vi.fn(),
  createPaymentsBang: vi.fn(),
  paymentUser: vi.fn(),
}));
vi.mock("../infra/error-reporting.ts", () => ({ notifyError: mocks.notifyError }));
vi.mock("./payout-perform.ts", () => ({
  performPaymentBang: mocks.performPaymentBang,
  processPaymentsBang: mocks.processPaymentsBang,
}));
vi.mock("./payouts.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./payouts.ts")>()),
  createPaymentsBang: mocks.createPaymentsBang,
}));
vi.mock("./payment.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./payment.ts")>()),
  paymentUser: mocks.paymentUser,
}));
vi.mock("./user.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./user.ts")>()),
  findUserBang: () => Promise.resolve({ get: () => 5 }),
}));

import type { PaymentRecord } from "./payment.ts";
import { processPayoutUsers, processStripePayment } from "./payout-users-service.ts";
import { NotPortedError } from "./user.ts";

const payment = { get: (name: string) => (name === "processor" ? "STRIPE" : 7) } as unknown as PaymentRecord;
const input = {
  dateString: "2025-10-31",
  processorType: "STRIPE",
  userIds: 5,
  payoutType: "standard",
  retrying: false,
};

beforeEach(() => vi.clearAllMocks());

describe("processStripePayment", () => {
  it("rethrows a refusal made before the payout request, to be handed back", async () => {
    const refusal = new NotPortedError("a payout from a retired Stripe account", "ref");
    mocks.performPaymentBang.mockRejectedValue(refusal);

    await expect(processStripePayment(payment)).rejects.toBe(refusal);
    expect(mocks.notifyError).not.toHaveBeenCalled();
  });

  it("fails the job, not a hand-back, for a refusal after the payout request left", async () => {
    mocks.performPaymentBang.mockImplementation((_payment, _options, progress: { requested: boolean }) => {
      progress.requested = true;
      return Promise.reject(new NotPortedError("something late", "ref"));
    });

    const error = await processStripePayment(payment).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(NotPortedError);
    expect(mocks.notifyError).toHaveBeenCalledTimes(1);
  });
});

describe("processPayoutUsers", () => {
  it("rethrows a refusal of the claim, to be handed back", async () => {
    const refusal = new NotPortedError("an unpaid balance left outside the claim", "ref");
    mocks.createPaymentsBang.mockRejectedValue(refusal);

    await expect(processPayoutUsers(input)).rejects.toBe(refusal);
    expect(mocks.processPaymentsBang).not.toHaveBeenCalled();
  });

  it("reports a refusal after the claim committed and keeps going", async () => {
    mocks.createPaymentsBang.mockResolvedValue([[payment, []]]);
    mocks.paymentUser.mockRejectedValue(new NotPortedError("late", "ref"));

    await expect(processPayoutUsers(input)).resolves.toBeUndefined();
    expect(mocks.notifyError).toHaveBeenCalledTimes(1);
  });
});
