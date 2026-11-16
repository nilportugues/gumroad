import { beforeEach, describe, expect, it, vi } from "vitest";

const selectRows = vi.hoisted(() => vi.fn());
const activeBankAccount = vi.hoisted(() => vi.fn());
const aliveComplianceInfo = vi.hoisted(() => vi.fn());
vi.mock("./sql.ts", async (importOriginal) => ({ ...(await importOriginal<typeof import("./sql.ts")>()), selectRows }));
vi.mock("../page-props/signed-in/reads.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../page-props/signed-in/reads.ts")>()),
  activeBankAccount,
  aliveComplianceInfo,
}));

import { currentPayoutProcessor, paypalPayoutEmailNeedsApi } from "./current-payout-processor.ts";
import type { UserRecord } from "./user.ts";

const user = (paymentAddress: string | null) => {
  const values: Record<string, unknown> = { id: 7n, payment_address: paymentAddress };
  return { get: (name: string) => values[name] } as unknown as UserRecord;
};
const info = (country: string, extra: Record<string, unknown> = {}) => ({
  country,
  business_country: null,
  is_business: false,
  birthday: null,
  guardian_id: null,
  ...extra,
});

beforeEach(() => {
  selectRows.mockReset().mockResolvedValue([]);
  activeBankAccount.mockReset().mockResolvedValue(null);
  aliveComplianceInfo.mockReset().mockResolvedValue(info("United States"));
});

describe("currentPayoutProcessor", () => {
  it("pays a seller with a payment address and no bank account through PayPal", async () => {
    expect(await currentPayoutProcessor(user("seller@example.com"))).toBe("PAYPAL");
    expect(aliveComplianceInfo).not.toHaveBeenCalled();
  });

  it("pays a seller with a payment address and a bank account through Stripe when their country is supported", async () => {
    activeBankAccount.mockResolvedValue({ type: "AchAccount" });
    expect(await currentPayoutProcessor(user("seller@example.com"))).toBe("STRIPE");
  });

  it("pays a seller with a bank account in a country without native payouts through PayPal", async () => {
    activeBankAccount.mockResolvedValue({ type: "AchAccount" });
    aliveComplianceInfo.mockResolvedValue(info("Brazil"));
    expect(await currentPayoutProcessor(user("seller@example.com"))).toBe("PAYPAL");
  });

  it("pays a seller with no payment address in a supported country through Stripe", async () => {
    expect(await currentPayoutProcessor(user(null))).toBe("STRIPE");
    expect(activeBankAccount).not.toHaveBeenCalled();
  });

  it("treats a blank payment address as absent", async () => {
    expect(await currentPayoutProcessor(user("  "))).toBe("STRIPE");
  });

  it("pays a seller without compliance info through PayPal", async () => {
    aliveComplianceInfo.mockResolvedValue(null);
    expect(await currentPayoutProcessor(user(null))).toBe("PAYPAL");
  });

  it("pays an individual in the UAE through PayPal and a business there through Stripe", async () => {
    aliveComplianceInfo.mockResolvedValue(info("United Arab Emirates"));
    expect(await currentPayoutProcessor(user(null))).toBe("PAYPAL");
    aliveComplianceInfo.mockResolvedValue(
      info("United Arab Emirates", { is_business: true, business_country: "United Arab Emirates" }),
    );
    expect(await currentPayoutProcessor(user(null))).toBe("STRIPE");
  });

  it("hands a seller with a connected PayPal account and no payment address to Rails", async () => {
    selectRows.mockResolvedValue([{ one: 1 }]);
    await expect(currentPayoutProcessor(user(null))).rejects.toMatchObject({ name: "NotPortedError" });
  });
});

describe("paypalPayoutEmailNeedsApi", () => {
  it("reads nothing for a seller with a payment address", async () => {
    expect(await paypalPayoutEmailNeedsApi(user("seller@example.com"))).toBe(false);
    expect(selectRows).not.toHaveBeenCalled();
  });

  it("looks for an alive PayPal merchant account of a seller without one", async () => {
    expect(await paypalPayoutEmailNeedsApi(user(null))).toBe(false);
    expect(selectRows).toHaveBeenCalledTimes(1);
    selectRows.mockResolvedValue([{ one: 1 }]);
    expect(await paypalPayoutEmailNeedsApi(user(null))).toBe(true);
  });
});
