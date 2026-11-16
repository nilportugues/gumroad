import { beforeEach, describe, expect, it, vi } from "vitest";

const { findByPurchaseOrCharge, orderableEmail, performAsync, deliverLater, findOneBy } = vi.hoisted(() => ({
  findByPurchaseOrCharge: vi.fn(),
  orderableEmail: vi.fn(),
  performAsync: vi.fn(),
  deliverLater: vi.fn(),
  findOneBy: vi.fn(),
}));

vi.mock("../models/charge.ts", () => ({ findByPurchaseOrCharge, orderableEmail }));
vi.mock("../models/concerns/job-runtime.ts", () => ({ performAsync, currentJobsRuntime: () => "runtime" }));
vi.mock("../models/row-reads.ts", () => ({ findOneBy }));
vi.mock("../mail/active-job.ts", () => ({ deliverLater }));
vi.mock("../mail/delivery.ts", () => ({ mailRoute: () => "ruby" }));

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
  orderableEmail.mockReset().mockResolvedValue("buyer@example.com");
  performAsync.mockReset().mockResolvedValue("jid");
  deliverLater.mockReset().mockResolvedValue("job-id");
  findOneBy.mockReset().mockResolvedValue(null);
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

  it("checks the email of the order's first purchase for the receipt of a charge", async () => {
    findByPurchaseOrCharge.mockResolvedValue({ kind: "charge", charge: { order_id: 3n } });
    orderableEmail.mockResolvedValueOnce(null);
    expect(await resendReceipt(purchase(), WEB)).toBe("missing");
    expect(performAsync).not.toHaveBeenCalled();

    expect(await resendReceipt(purchase({ email: "" }), WEB)).toBe("sent");
    expect(performAsync).toHaveBeenCalledWith("SendPurchaseReceiptJob", [5, true]);
  });

  it("enqueues the giftee's receipt after the sender's", async () => {
    findOneBy.mockResolvedValueOnce({ giftee_purchase_id: 9n }).mockResolvedValueOnce({ id: 9n });
    expect(await resendReceipt(purchase({}, ["is_gift_sender_purchase"]), WEB)).toBe("sent");
    expect(performAsync.mock.calls).toEqual([
      ["SendPurchaseReceiptJob", [5, true]],
      ["SendPurchaseReceiptJob", [9, true]],
    ]);
  });

  it("enqueues only the sender's receipt when the gift or its giftee purchase is missing", async () => {
    expect(await resendReceipt(purchase({}, ["is_gift_sender_purchase"]), WEB)).toBe("sent");
    findOneBy.mockResolvedValueOnce({ giftee_purchase_id: 9n }).mockResolvedValueOnce(null);
    expect(await resendReceipt(purchase({}, ["is_gift_sender_purchase"]), WEB)).toBe("sent");
    expect(performAsync).toHaveBeenCalledTimes(2);
  });

  it("delivers the preorder receipt through ActiveJob instead of enqueuing a receipt job", async () => {
    findOneBy.mockResolvedValueOnce({ id: 7n });
    expect(await resendReceipt(purchase({ preorder_id: 7n }, ["is_preorder_authorization"]), WEB)).toBe("sent");
    expect(deliverLater).toHaveBeenCalledWith(
      "runtime",
      { mailer: "CustomerMailer", method: "preorder_receipt", args: [7], queue: "critical", waitSeconds: 3 },
      "ruby",
    );
    expect(performAsync).not.toHaveBeenCalled();
  });

  it("hands back a preorder authorization whose preorder is gone before enqueuing", async () => {
    await expect(resendReceipt(purchase({}, ["is_preorder_authorization"]), WEB)).rejects.toBeInstanceOf(
      HandBackToRails,
    );
    expect(deliverLater).not.toHaveBeenCalled();
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
