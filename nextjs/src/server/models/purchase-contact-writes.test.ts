import type { Purchase } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { findById, selectRows, coveredByCutover } = vi.hoisted(() => ({
  findById: vi.fn(),
  selectRows: vi.fn(),
  coveredByCutover: vi.fn(),
}));

vi.mock("./row-reads.ts", () => ({ findById }));
vi.mock("./follower.ts", () => ({ coveredByCutover }));
vi.mock("./sql.ts", async (original) => ({ ...(await original<typeof import("./sql.ts")>()), selectRows }));

const { castBoolean, changeCanContact, ContactPurchases } = await import("./purchase-contact-writes.ts");
const { HandBackToRails } = await import("../controllers/application-controller.ts");
const { PurchaseFlags } = await import("../search/flags.ts");

const freePurchase = (overrides: Partial<Purchase> = {}, flags: string[] = []): Purchase =>
  ({
    id: 5n,
    link_id: 9n,
    seller_id: 7n,
    subscription_id: null,
    purchase_state: "successful",
    email: "buyer@example.com",
    price_cents: 0,
    total_transaction_cents: 0,
    fee_cents: 0,
    stripe_transaction_id: null,
    stripe_fingerprint: null,
    charge_processor_id: null,
    paypal_order_id: null,
    merchant_account_id: null,
    json_data: null,
    can_contact: true,
    flags: flags.reduce((acc, flag) => PurchaseFlags.set(acc, flag as never, true), 0n),
    ...overrides,
  }) as unknown as Purchase;

const rows =
  (overrides: Record<string, unknown> = {}) =>
  (model: string, id: unknown) => {
    const found: Record<string, unknown> = {
      Link: { user_id: 7n, native_type: "digital" },
      User: { id: 7n },
      MerchantAccount: id === null ? null : { id },
      ...overrides,
    };
    return Promise.resolve(found[model] ?? null);
  };

const update = vi.spyOn(ContactPurchases, "updateBang");

beforeEach(() => {
  findById.mockReset().mockImplementation(rows());
  selectRows.mockReset().mockResolvedValue([]);
  coveredByCutover.mockReset().mockResolvedValue(false);
  update.mockReset().mockResolvedValue(undefined as never);
});

describe("castBoolean", () => {
  it("reads the values ActiveModel::Type::Boolean calls false as false and every other value as true", () => {
    for (const value of [false, 0, "0", "f", "F", "false", "FALSE", "off", "OFF"])
      expect(castBoolean(value)).toBe(false);
    for (const value of [true, 1, "1", "true", "on", "no", "False", " false"]) expect(castBoolean(value)).toBe(true);
  });

  it("casts a blank value to null, which Rails stores as NULL", () => {
    for (const value of [null, undefined, ""]) expect(castBoolean(value)).toBeNull();
  });

  it("reads a list or an object as true, since neither is a false value", () => {
    for (const value of [[], {}, ["false"], { value: "off" }]) expect(castBoolean(value)).toBe(true);
  });

  it("hands a value that JSON cannot carry back to Rails", () => {
    expect(() => castBoolean(10n)).toThrow(HandBackToRails);
  });
});

describe("changeCanContact", () => {
  it("saves the new value of a plain free purchase", async () => {
    expect(await changeCanContact(freePurchase(), "false")).toBe("changed");
    expect(update).toHaveBeenCalledOnce();
    expect(update.mock.calls[0]![1]).toEqual({ can_contact: false });
  });

  it("stores NULL for a blank value and writes nothing when it is already NULL", async () => {
    expect(await changeCanContact(freePurchase(), undefined)).toBe("changed");
    expect(update.mock.calls[0]![1]).toEqual({ can_contact: null });
    update.mockClear();
    expect(await changeCanContact(freePurchase({ can_contact: null }), "")).toBe("unchanged");
    expect(update).not.toHaveBeenCalled();
  });

  it("writes nothing when the value is the stored one", async () => {
    expect(await changeCanContact(freePurchase({ can_contact: false }), 0)).toBe("unchanged");
    expect(update).not.toHaveBeenCalled();
    expect(coveredByCutover).not.toHaveBeenCalled();
  });

  it("saves a priced purchase that carries a complete processor trace", async () => {
    const purchase = freePurchase({
      price_cents: 100,
      total_transaction_cents: 100,
      stripe_transaction_id: "ch_1",
      stripe_fingerprint: "fp",
      charge_processor_id: "stripe",
      merchant_account_id: 3n,
    });
    expect(await changeCanContact(purchase, false)).toBe("changed");
  });

  it.each([
    [
      "a priced purchase without a merchant account",
      { price_cents: 100, stripe_transaction_id: "ch_1", stripe_fingerprint: "fp", charge_processor_id: "stripe" },
    ],
    [
      "a priced purchase without a transaction id",
      { price_cents: 100, merchant_account_id: 3n, stripe_fingerprint: "fp", charge_processor_id: "stripe" },
    ],
    [
      "a priced purchase without a fingerprint or a PayPal order",
      { price_cents: 100, merchant_account_id: 3n, stripe_transaction_id: "ch_1", charge_processor_id: "stripe" },
    ],
    ["a free purchase with a transaction id", { stripe_transaction_id: "ch_1" }],
    ["a purchase that is not successful", { purchase_state: "failed" }],
    ["a purchase of a subscription", { subscription_id: 4n }],
    ["a purchase without an email", { email: null }],
    ["a purchase without a seller", { seller_id: null }],
    ["a purchase without its fee", { fee_cents: null }],
    ["a purchase with a custom fee", { json_data: '{"custom_fee_per_thousand":100}' }],
    ["a purchase with a recommender", { json_data: '{"recommender_model_name":"x"}' }],
  ])("hands %s back before writing", async (_name, overrides) => {
    await expect(changeCanContact(freePurchase(overrides as never), false)).rejects.toThrow(HandBackToRails);
    expect(update).not.toHaveBeenCalled();
  });

  it.each([
    "is_gift_sender_purchase",
    "is_gift_receiver_purchase",
    "is_preorder_authorization",
    "is_installment_payment",
  ])("hands a purchase with %s back before writing", async (flag) => {
    await expect(changeCanContact(freePurchase({}, [flag]), false)).rejects.toThrow(HandBackToRails);
    expect(update).not.toHaveBeenCalled();
  });

  it("hands back a product that is not the seller's, a call product and a missing seller", async () => {
    findById.mockImplementation(rows({ Link: { user_id: 8n, native_type: "digital" } }));
    await expect(changeCanContact(freePurchase(), false)).rejects.toThrow(HandBackToRails);
    findById.mockImplementation(rows({ Link: { user_id: 7n, native_type: "call" } }));
    await expect(changeCanContact(freePurchase(), false)).rejects.toThrow(HandBackToRails);
    findById.mockImplementation(rows({ User: null }));
    await expect(changeCanContact(freePurchase(), false)).rejects.toThrow(HandBackToRails);
    expect(update).not.toHaveBeenCalled();
  });

  it("hands back a purchase that has a review", async () => {
    selectRows.mockResolvedValue([{ 1: 1 }]);
    await expect(changeCanContact(freePurchase(), false)).rejects.toThrow(/review/u);
    expect(update).not.toHaveBeenCalled();
  });

  it("hands back a seller under a newsletter cutover", async () => {
    coveredByCutover.mockResolvedValue(true);
    await expect(changeCanContact(freePurchase(), false)).rejects.toThrow(/cutover/u);
    expect(update).not.toHaveBeenCalled();
  });
});
