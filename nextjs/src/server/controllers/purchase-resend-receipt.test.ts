import { beforeEach, describe, expect, it, vi } from "vitest";

const { findByPurchaseOrCharge, performAsync } = vi.hoisted(() => ({
  findByPurchaseOrCharge: vi.fn(),
  performAsync: vi.fn(),
}));

vi.mock("../models/charge.ts", () => ({ findByPurchaseOrCharge }));
vi.mock("../models/concerns/job-runtime.ts", () => ({ performAsync }));

const { resendReceipt } = await import("./purchase-resend-receipt.ts");
const { PurchaseFlags } = await import("../search/flags.ts");
const { HandBackToRails } = await import("./application-controller.ts");

const purchase = (overrides: Record<string, unknown> = {}, flags: string[] = []) =>
  ({
    id: 5n,
    email: "buyer@example.com",
    flags: flags.reduce((acc, flag) => PurchaseFlags.set(acc, flag as never, true), 0n),
    ...overrides,
  }) as never;

const WEB = { rescueEnqueueError: true };

beforeEach(() => {
  findByPurchaseOrCharge.mockReset().mockImplementation((row: unknown) => ({ kind: "purchase", purchase: row }));
  performAsync.mockReset().mockResolvedValue("jid");
});

describe("resendReceipt", () => {
  it("enqueues SendPurchaseReceiptJob for a plain purchase", async () => {
    expect(await resendReceipt(purchase(), WEB)).toBe("sent");
    expect(performAsync).toHaveBeenCalledOnce();
    expect(performAsync).toHaveBeenCalledWith("SendPurchaseReceiptJob", [5, true]);
  });

  it("reports a blank email without enqueuing", async () => {
    expect(await resendReceipt(purchase({ email: " " }), WEB)).toBe("missing");
    expect(await resendReceipt(purchase({ email: null }), WEB)).toBe("missing");
    expect(performAsync).not.toHaveBeenCalled();
  });

  it("hands back the receipt of a charge, a preorder authorization and a gift sender before enqueuing", async () => {
    findByPurchaseOrCharge.mockResolvedValueOnce({ kind: "charge", charge: {} });
    await expect(resendReceipt(purchase(), WEB)).rejects.toBeInstanceOf(HandBackToRails);
    await expect(resendReceipt(purchase({}, ["is_preorder_authorization"]), WEB)).rejects.toBeInstanceOf(
      HandBackToRails,
    );
    await expect(resendReceipt(purchase({}, ["is_gift_sender_purchase"]), WEB)).rejects.toBeInstanceOf(HandBackToRails);
    expect(performAsync).not.toHaveBeenCalled();
  });

  it("answers unavailable instead of throwing when the enqueue fails", async () => {
    performAsync.mockRejectedValue(new Error("ECONNREFUSED"));
    expect(await resendReceipt(purchase(), WEB)).toBe("unavailable");
  });

  it("lets the enqueue error propagate where Rails does not rescue it", async () => {
    performAsync.mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(resendReceipt(purchase(), { rescueEnqueueError: false })).rejects.toThrow("ECONNREFUSED");
  });
});
