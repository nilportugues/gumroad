import { beforeEach, describe, expect, it, vi } from "vitest";

const { aliveStripeAccountsOf, findUserById, aliveComplianceInfo, isFeatureEnabled } = vi.hoisted(() => ({
  aliveStripeAccountsOf: vi.fn(),
  findUserById: vi.fn(),
  aliveComplianceInfo: vi.fn(),
  isFeatureEnabled: vi.fn(),
}));

vi.mock("../../models/merchant-account.ts", async (original) => ({
  ...(await original<typeof import("../../models/merchant-account.ts")>()),
  aliveStripeAccountsOf,
}));
vi.mock("../../presenters/product-reads.ts", () => ({ findUserById }));
vi.mock("../signed-in/reads.ts", () => ({ aliveComplianceInfo, activeBankAccount: vi.fn() }));
vi.mock("../../infra/flipper.ts", () => ({ isFeatureEnabled, userActor: (id: unknown) => `User;${id}` }));

const { hasBrazilianStripeConnectAccount } = await import("./payout-info.ts");

const connect = (country: string) => ({
  id: 1n,
  user_id: 7n,
  charge_processor_id: "stripe",
  country,
  json_data: { meta: { stripe_connect: "true" } },
});
const managed = (country: string) => ({ ...connect(country), id: 2n, json_data: {} });
// User flag 25, check_merchant_account_is_linked.
const LINKED_FLAGS = 1n << 24n;
const unitedStates = { country: "United States", business_country: null, is_business: 0 };

beforeEach(() => {
  vi.resetAllMocks();
  findUserById.mockResolvedValue({ id: 7n, flags: 0n });
  aliveComplianceInfo.mockResolvedValue(unitedStates);
  isFeatureEnabled.mockResolvedValue(false);
});

describe("hasBrazilianStripeConnectAccount", () => {
  it("is false without a Connect account, whatever Gumroad-managed accounts exist", async () => {
    aliveStripeAccountsOf.mockResolvedValue([managed("BR")]);
    expect(await hasBrazilianStripeConnectAccount(7n)).toBe(false);
  });

  it("is false for a non-Brazilian Connect account", async () => {
    aliveStripeAccountsOf.mockResolvedValue([connect("US")]);
    findUserById.mockResolvedValue({ id: 7n, flags: LINKED_FLAGS });
    expect(await hasBrazilianStripeConnectAccount(7n)).toBe(false);
  });

  it("is true when the seller is flagged as linked", async () => {
    aliveStripeAccountsOf.mockResolvedValue([connect("BR")]);
    findUserById.mockResolvedValue({ id: 7n, flags: LINKED_FLAGS });
    expect(await hasBrazilianStripeConnectAccount(7n)).toBe(true);
    expect(isFeatureEnabled).not.toHaveBeenCalled();
  });

  it("is false when merchant migration is neither linked nor rolled out", async () => {
    aliveStripeAccountsOf.mockResolvedValue([connect("BR")]);
    expect(await hasBrazilianStripeConnectAccount(7n)).toBe(false);
  });

  it("is true when merchant_migration is on and the compliance country is supported by Connect", async () => {
    aliveStripeAccountsOf.mockResolvedValue([connect("BR")]);
    isFeatureEnabled.mockImplementation((name: string) => Promise.resolve(name === "merchant_migration"));
    expect(await hasBrazilianStripeConnectAccount(7n)).toBe(true);
  });

  it("is false when merchant_migration is on but the compliance country is not supported", async () => {
    aliveStripeAccountsOf.mockResolvedValue([connect("BR")]);
    isFeatureEnabled.mockImplementation((name: string) => Promise.resolve(name === "merchant_migration"));
    aliveComplianceInfo.mockResolvedValue({ country: "Kenya", business_country: null, is_business: 0 });
    expect(await hasBrazilianStripeConnectAccount(7n)).toBe(false);
  });

  it("routes a business by its legal entity country when that feature is on", async () => {
    aliveStripeAccountsOf.mockResolvedValue([connect("BR")]);
    isFeatureEnabled.mockResolvedValue(true);
    aliveComplianceInfo.mockResolvedValue({ country: "Kenya", business_country: "Brazil", is_business: 1 });
    expect(await hasBrazilianStripeConnectAccount(7n)).toBe(true);
  });

  it("is false when merchant_migration is on and the seller has no compliance info", async () => {
    aliveStripeAccountsOf.mockResolvedValue([connect("BR")]);
    isFeatureEnabled.mockResolvedValue(true);
    aliveComplianceInfo.mockResolvedValue(null);
    expect(await hasBrazilianStripeConnectAccount(7n)).toBe(false);
  });

  it("looks at the first Connect account only", async () => {
    aliveStripeAccountsOf.mockResolvedValue([connect("US"), { ...connect("BR"), id: 3n }]);
    findUserById.mockResolvedValue({ id: 7n, flags: LINKED_FLAGS });
    expect(await hasBrazilianStripeConnectAccount(7n)).toBe(false);
  });
});
