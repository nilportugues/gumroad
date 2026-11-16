import { beforeEach, describe, expect, it, vi } from "vitest";

const { selectRows, findUserById, aliveComplianceInfo, activeBankAccount, isFeatureEnabled } = vi.hoisted(() => ({
  selectRows: vi.fn(),
  findUserById: vi.fn(),
  aliveComplianceInfo: vi.fn(),
  activeBankAccount: vi.fn(),
  isFeatureEnabled: vi.fn(),
}));

vi.mock("../../models/sql.ts", async (original) => ({
  ...(await original<typeof import("../../models/sql.ts")>()),
  selectRows,
}));
vi.mock("../../presenters/product-reads.ts", () => ({ findUserById }));
vi.mock("../signed-in/reads.ts", () => ({ aliveComplianceInfo, activeBankAccount }));
vi.mock("../../infra/flipper.ts", () => ({ isFeatureEnabled, userActor: (id: bigint) => `User;${id}` }));

const { hasValidPayoutInfo } = await import("./payout-info.ts");

// User flag 25, check_merchant_account_is_linked.
const LINKED_FLAGS = 1n << 24n;
type Account = { charge_processor_id: string; country: string | null; connect: number };
const stripeConnect = (country: string): Account => ({ charge_processor_id: "stripe", country, connect: 1 });
const stripeManaged: Account = { charge_processor_id: "stripe", country: "US", connect: 0 };
const paypal: Account = { charge_processor_id: "paypal", country: null, connect: 0 };

let accounts: Account[] = [];
let storedBankAccountId: string | null = null;
let legalName = {
  is_business: 0,
  business_name: null as string | null,
  first_name: null as string | null,
  last_name: null as string | null,
};

beforeEach(() => {
  vi.resetAllMocks();
  accounts = [];
  storedBankAccountId = null;
  legalName = { is_business: 0, business_name: null, first_name: null, last_name: null };
  findUserById.mockResolvedValue({ id: 7n, flags: 0n });
  aliveComplianceInfo.mockResolvedValue(null);
  activeBankAccount.mockResolvedValue(null);
  isFeatureEnabled.mockResolvedValue(false);
  selectRows.mockImplementation((query: { sql: string }) => {
    if (query.sql.includes("merchant_accounts")) return Promise.resolve(accounts);
    if (query.sql.includes("bank_accounts")) return Promise.resolve([{ stripe_bank_account_id: storedBankAccountId }]);
    return Promise.resolve([legalName]);
  });
});

const user = (payment_address: string | null) => ({ id: 7n, payment_address });
const linked = () => findUserById.mockResolvedValue({ id: 7n, flags: LINKED_FLAGS });

describe("hasValidPayoutInfo with a Stripe Connect account", () => {
  it("is valid without a bank account or payout email when the seller is linked and the account is not Brazilian", async () => {
    accounts = [stripeConnect("US")];
    linked();
    expect(await hasValidPayoutInfo(user(null))).toBe(true);
  });

  it("is not valid for an account that merchant migration does not route to Connect", async () => {
    accounts = [stripeConnect("US")];
    expect(await hasValidPayoutInfo(user(null))).toBe(false);
  });

  it("falls through to the bank checks for a Brazilian account", async () => {
    accounts = [stripeConnect("BR")];
    linked();
    expect(await hasValidPayoutInfo(user(null))).toBe(false);
  });

  it("is valid for a Brazilian account when the payout email is complete", async () => {
    accounts = [stripeConnect("BR")];
    linked();
    legalName.first_name = "Ana";
    expect(await hasValidPayoutInfo(user("ana@example.com"))).toBe(true);
  });

  it("does not count the Connect account as the Stripe account behind a bank account", async () => {
    accounts = [stripeConnect("BR")];
    linked();
    activeBankAccount.mockResolvedValue({ id: 1n });
    storedBankAccountId = "ba_123";
    expect(await hasValidPayoutInfo(user(null))).toBe(false);
  });
});

describe("hasValidPayoutInfo with a Gumroad-managed Stripe account", () => {
  it("is valid with a bank account linked at Stripe", async () => {
    accounts = [stripeManaged];
    activeBankAccount.mockResolvedValue({ id: 1n });
    storedBankAccountId = "ba_123";
    expect(await hasValidPayoutInfo(user(null))).toBe(true);
  });

  it("is not valid when the bank account is not linked at Stripe", async () => {
    accounts = [stripeManaged];
    activeBankAccount.mockResolvedValue({ id: 1n });
    expect(await hasValidPayoutInfo(user(null))).toBe(false);
  });
});

describe("hasValidPayoutInfo with a PayPal Connect account", () => {
  it("needs no compliance info when the payment address is a valid email", async () => {
    accounts = [paypal];
    expect(await hasValidPayoutInfo(user("seller@example.com"))).toBe(true);
  });

  it("is not valid for a payment address that is not an email", async () => {
    accounts = [paypal];
    expect(await hasValidPayoutInfo(user("not-an-email"))).toBe(false);
  });

  it("is not valid for a payment address with non-ASCII characters", async () => {
    accounts = [paypal];
    expect(await hasValidPayoutInfo(user("sélller@example.com"))).toBe(false);
  });

  it("still needs compliance info without a PayPal account", async () => {
    expect(await hasValidPayoutInfo(user("seller@example.com"))).toBe(false);
    legalName.first_name = "Ana";
    expect(await hasValidPayoutInfo(user("seller@example.com"))).toBe(true);
  });

  it("hands back when the email would come from PayPal's account details", async () => {
    accounts = [paypal];
    await expect(hasValidPayoutInfo(user(null))).rejects.toThrow(/PayPal Connect/u);
  });

  it("is not valid without a payment address or a PayPal account", async () => {
    expect(await hasValidPayoutInfo(user(null))).toBe(false);
  });
});
