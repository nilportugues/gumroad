import { beforeEach, describe, expect, it, vi } from "vitest";

import { HandBackToRails } from "./application-controller.ts";
import type { MutationInput, MutationSpec } from "./mutation.ts";

const mocks = vi.hoisted(() => ({
  specs: [] as MutationSpec[],
  guardRedirect: vi.fn(),
  jsonDenied: vi.fn(),
  complianceInfo: vi.fn(),
  aliveInfo: vi.fn(),
  stripeAccounts: vi.fn(),
  requestCount: vi.fn(),
  remediate: vi.fn(),
  verify: vi.fn(),
  findUser: vi.fn(),
  saveUser: vi.fn(),
  purchaseCount: vi.fn(),
  rawQuery: vi.fn(),
  logAudit: vi.fn(),
}));
vi.mock("../models/user.ts", () => ({
  findUserBang: mocks.findUser,
  Users: { save: mocks.saveUser, saveBang: mocks.saveUser },
}));
vi.mock("../models/user-compliance-info-writes.ts", () => ({
  birthdayUnderMinimumAge: () => false,
  dupAndSaveBang: vi.fn(),
  UserComplianceInfos: { load: vi.fn(), build: vi.fn() },
}));
vi.mock("./settings-payments-mutations.ts", () => ({ logPayoutSettingsUpdateByNonOwner: mocks.logAudit }));
vi.mock("./settings-payments-remediation.ts", () => ({
  remediateStripeAccount: mocks.remediate,
  verifyStripeRemediation: mocks.verify,
}));

vi.mock("./mutation.ts", () => ({
  registerMutations: (...registered: MutationSpec[]) => void mocks.specs.push(...registered),
}));
vi.mock("../page-props/domain.ts", () => ({ domainConfig: () => ({}) }));
vi.mock("../page-props/settings/guard.ts", () => ({
  settingsGuard: () => async () => mocks.guardRedirect(),
}));
vi.mock("./json-seller.ts", () => ({
  jsonResponse: (body: unknown, status: number) => ({ json: body, status }),
  sellerJsonAction: async (_input: unknown, _policy: unknown, run: () => unknown) => mocks.jsonDenied() ?? run(),
}));
vi.mock("../models/user-compliance-info.ts", () => ({
  aliveUserComplianceInfoRow: mocks.aliveInfo,
  fetchOrBuildComplianceInfo: mocks.complianceInfo,
  countryCode: (row: { country: string | null }) => row.country,
  businessCountryCode: (row: { business_country: string | null }) => row.business_country,
  legalEntityCountryCode: (row: { is_business: boolean; business_country: string | null; country: string | null }) =>
    (row.is_business ? row.business_country : null) ?? row.country,
  jsonAttr: (row: { json_data: string | null }, key: string) =>
    row.json_data === null ? null : (JSON.parse(row.json_data)[key] ?? null),
}));
vi.mock("../models/merchant-account.ts", () => ({
  aliveStripeAccountsOf: mocks.stripeAccounts,
  isStripeConnectAccount: (account: { connect?: boolean }) => account.connect === true,
}));
vi.mock("../../lib/db.ts", () => ({
  db: {
    userComplianceInfoRequest: { count: mocks.requestCount },
    purchase: { count: mocks.purchaseCount },
    $queryRaw: mocks.rawQuery,
  },
}));

await import("./settings-payments-guards.ts");

const find = (method: string, pattern: string) =>
  mocks.specs.find((spec) => spec.method === method && spec.pattern === pattern)!.run;
const input = (params: Record<string, unknown> = {}, email: string | null = "seller@example.com") =>
  ({
    params,
    routeParams: {},
    context: { currentSeller: { id: 3n, email, external_id: "abc123" } },
  }) as unknown as MutationInput;
const refusal = (message: string) => ({
  status: 302,
  location: "/settings/payments",
  inertiaErrors: { base: [message] },
});
const row = (country: string | null, extra: Record<string, unknown> = {}) => ({
  country,
  business_country: null,
  is_business: false,
  ...extra,
});
const FRENCH_MESSAGE = "French overseas departments are not valid compliance countries. Select France instead.";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.complianceInfo.mockResolvedValue({ row: row("United States"), persisted: true });
  mocks.aliveInfo.mockResolvedValue(row("US"));
  mocks.stripeAccounts.mockResolvedValue([]);
  mocks.requestCount.mockResolvedValue(0);
});

describe("PUT /settings/payments", () => {
  const run = find("PUT", "/settings/payments");

  it("is registered for PATCH too", () => {
    expect(find("PATCH", "/settings/payments")).toBe(run);
  });

  it("returns the guard's redirect", async () => {
    mocks.guardRedirect.mockResolvedValue({ status: 302, location: "/dashboard" });
    expect(await run(input())).toEqual({ status: 302, location: "/dashboard" });
  });

  it("refuses a seller with no email", async () => {
    expect(await run(input({}, null))).toEqual(
      refusal("You have to confirm your email address before you can do that."),
    );
  });

  it("answers no content to a seller with no country", async () => {
    mocks.complianceInfo.mockResolvedValue({ row: row(null), persisted: false });
    expect(await run(input())).toMatchObject({ status: 204, body: "" });
  });

  it("refuses a switch to Puerto Rico in any of the three country fields", async () => {
    for (const field of ["updated_country_code", "country", "business_country"])
      expect(await run(input({ user: { [field]: "PR" } }))).toEqual(
        refusal("Puerto Rico is not a valid compliance country. Select United States and Puerto Rico as your state."),
      );
  });

  it("lets a form that echoes the stored Puerto Rico country through to Rails", async () => {
    mocks.aliveInfo.mockResolvedValue(row("PR"));
    await expect(run(input({ user: { country: "PR" } }))).rejects.toThrow(HandBackToRails);
  });

  it("refuses a switch to a French overseas department", async () => {
    expect(await run(input({ user: { updated_country_code: "GP" } }))).toEqual(refusal(FRENCH_MESSAGE));
  });

  it("compares a French business country with the business country, then the personal one", async () => {
    mocks.aliveInfo.mockResolvedValue(row("MQ"));
    await expect(run(input({ user: { business_country: "MQ" } }))).rejects.toThrow(HandBackToRails);
    expect(await run(input({ user: { business_country: "GF" } }))).toEqual(refusal(FRENCH_MESSAGE));
  });

  it("ignores a blank or non-text country", async () => {
    await expect(run(input({ user: { country: "", updated_country_code: 5 } }))).rejects.toThrow(HandBackToRails);
  });

  it("hands a user param that is not a hash to Rails", async () => {
    await expect(run(input({ user: "PR" }))).rejects.toThrow(/not a hash/u);
  });

  it("hands a save that passes every guard to Rails", async () => {
    await expect(run(input({ user: { country: "US", zip_code: "94107" } }))).rejects.toThrow(HandBackToRails);
  });
});

describe("POST /settings/payments/set_country", () => {
  const run = find("POST", "/settings/payments/set_country");
  const forbidden = { status: 403, body: "", contentType: "application/json", paramsRead: true };

  it("returns the policy's refusal", async () => {
    mocks.jsonDenied.mockReturnValue({ status: 401 });
    expect(await run(input({ country: "US" }))).toEqual({ status: 401 });
  });

  it("answers 403 to a seller who already has a country", async () => {
    expect(await run(input({ country: "CA" }))).toEqual(forbidden);
  });

  it("answers 403 to Puerto Rico", async () => {
    mocks.complianceInfo.mockResolvedValue({ row: row(null), persisted: false });
    expect(await run(input({ country: "PR" }))).toEqual(forbidden);
  });

  it("answers a French overseas department with the message", async () => {
    mocks.complianceInfo.mockResolvedValue({ row: row(null), persisted: false });
    expect(await run(input({ country: "GP" }))).toEqual({ json: { error: FRENCH_MESSAGE }, status: 403 });
  });

  it("hands a country the ISO 3166 list does not know to Rails", async () => {
    mocks.complianceInfo.mockResolvedValue({ row: row(null), persisted: false });
    await expect(run(input({ country: "ZZ" }))).rejects.toThrow(HandBackToRails);
  });

  it("hands a Japanese country to Rails", async () => {
    mocks.complianceInfo.mockResolvedValue({ row: row(null), persisted: false });
    await expect(run(input({ country: "JP" }))).rejects.toThrow(HandBackToRails);
  });

  it("hands a first country to Rails while the seller has open compliance requests", async () => {
    mocks.complianceInfo.mockResolvedValue({ row: row(null), persisted: false });
    mocks.requestCount.mockResolvedValue(1);
    await expect(run(input({ country: "CA" }))).rejects.toThrow(HandBackToRails);
  });

  it("hands a country that is not text to Rails", async () => {
    await expect(run(input({ country: ["PR"] }))).rejects.toThrow(HandBackToRails);
  });
});

describe("POST /settings/payments/remove_credit_card", () => {
  const run = find("POST", "/settings/payments/remove_credit_card");

  it("returns the policy's refusal", async () => {
    mocks.jsonDenied.mockReturnValue({ status: 401 });
    expect(await run(input())).toEqual({ status: 401 });
  });

  const seller = () => ({ get: () => 3n, set: vi.fn(), errors: { fullMessages: () => ["Name is too long"] } });

  it("answers 400 with the validation errors when the seller no longer saves", async () => {
    mocks.findUser.mockResolvedValue(seller());
    mocks.purchaseCount.mockResolvedValue(0);
    mocks.rawQuery.mockResolvedValue([{ present: 0n }]);
    mocks.saveUser.mockResolvedValue(false);
    expect(await run(input())).toEqual({ json: { error: "Name is too long" }, status: 400 });
    expect(mocks.logAudit).not.toHaveBeenCalled();
  });

  it("answers 400 without saving while a preorder authorization needs the card", async () => {
    mocks.findUser.mockResolvedValue(seller());
    mocks.purchaseCount.mockResolvedValue(1);
    mocks.saveUser.mockClear();
    expect((await run(input())) as { status: number }).toMatchObject({ status: 400 });
    expect(mocks.saveUser).not.toHaveBeenCalled();
  });

  it("clears the card and notes the change", async () => {
    mocks.findUser.mockResolvedValue(seller());
    mocks.purchaseCount.mockResolvedValue(0);
    mocks.rawQuery.mockResolvedValue([{ present: 0n }]);
    mocks.saveUser.mockResolvedValue(true);
    expect(await run(input())).toMatchObject({ status: 204 });
    expect(mocks.logAudit).toHaveBeenCalledWith(expect.anything(), "Payout settings updated");
  });
});

describe("GET /settings/payments/paypal_connect", () => {
  const run = find("GET", "/settings/payments/paypal_connect");
  const error = {
    status: 302,
    location: "/checkout/form",
    flash: { notice: "There was an error connecting your PayPal account with Gumroad." },
  };

  it("sends a request with no PayPal merchant id back to the form", async () => {
    expect(await run(input({ merchantId: "abc123-1" }))).toEqual(error);
  });

  it("sends a request with no merchant id back to the form", async () => {
    expect(await run(input({ merchantIdInPayPal: "PP1" }))).toEqual(error);
  });

  it("sends a merchant id of another seller back to the form", async () => {
    expect(await run(input({ merchantIdInPayPal: "PP1", merchantId: "zzz-1" }))).toEqual(error);
  });

  it("hands a matching merchant id to Rails", async () => {
    await expect(run(input({ merchantIdInPayPal: "PP1", merchantId: "abc123-1" }))).rejects.toThrow(HandBackToRails);
  });

  it("hands a parameter that is not text to Rails", async () => {
    await expect(run(input({ merchantIdInPayPal: "PP1", merchantId: ["abc123"] }))).rejects.toThrow(HandBackToRails);
  });
});

describe("GET /settings/payments/remediation", () => {
  const run = find("GET", "/settings/payments/remediation");
  const account = (reason: string | null, extra: Record<string, unknown> = {}) => ({
    json_data: JSON.stringify({ stripe_disabled_reason: reason }),
    ...extra,
  });

  it("tells a seller with no Stripe account they are all set", async () => {
    expect(await run(input())).toEqual({
      status: 302,
      location: "/settings/payments",
      flash: { notice: "Thanks! You're all set." },
    });
  });

  it("ignores a Connect account", async () => {
    mocks.stripeAccounts.mockResolvedValue([account(null, { connect: true })]);
    expect(await run(input())).toHaveProperty("flash");
  });

  it("sends a rejected account with nothing to submit to the payments page", async () => {
    mocks.stripeAccounts.mockResolvedValue([account("rejected.fraud")]);
    expect(await run(input())).toEqual({ status: 302, location: "/settings/payments" });
  });

  it("reads a rejected account with an open request at Stripe, knowing the seller has a request", async () => {
    const rejected = account("rejected.listed");
    mocks.stripeAccounts.mockResolvedValue([rejected]);
    mocks.requestCount.mockResolvedValue(1);
    mocks.remediate.mockResolvedValue({ status: 302, location: "https://connect.stripe.com/link" });
    expect(await run(input())).toEqual({ status: 302, location: "https://connect.stripe.com/link" });
    expect(mocks.remediate).toHaveBeenCalledWith(expect.anything(), rejected, true);
  });

  it("reads an account in good standing at Stripe", async () => {
    const standing = account(null);
    mocks.stripeAccounts.mockResolvedValue([standing]);
    mocks.requestCount.mockResolvedValue(0);
    mocks.remediate.mockResolvedValue({ status: 302, location: "/settings/payments" });
    await run(input());
    expect(mocks.remediate).toHaveBeenCalledWith(expect.anything(), standing, false);
  });
});

describe("GET /settings/payments/verify_stripe_remediation", () => {
  const run = find("GET", "/settings/payments/verify_stripe_remediation");

  it("sends a seller with no Stripe account to the payments page", async () => {
    expect(await run(input())).toEqual({ status: 302, location: "/settings/payments" });
  });

  it("checks a seller with a Stripe account against Stripe, counting the requests it would mark as provided", async () => {
    const stripe = { json_data: null };
    mocks.stripeAccounts.mockResolvedValue([stripe]);
    mocks.verify.mockImplementation(async (_input, _account, pending: () => Promise<boolean>) => ({
      status: 302,
      location: "/settings/payments",
      flash: { pending: String(await pending()) },
    }));
    mocks.requestCount.mockResolvedValue(2);
    expect(await run(input())).toEqual({ status: 302, location: "/settings/payments", flash: { pending: "true" } });
    expect(mocks.requestCount).toHaveBeenCalledWith({ where: { user_id: 3, state: "requested" } });
  });
});
