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
  dupAndSave: vi.fn(),
  paypalConnect: vi.fn(),
  facts: vi.fn(),
  bankCount: vi.fn(),
  setFlag: vi.fn(),
  setJson: vi.fn(),
  createTos: vi.fn(),
}));
vi.mock("../models/paypal-merchant-account-connect.ts", () => ({ updatePaypalMerchantAccount: mocks.paypalConnect }));
vi.mock("../models/tos-agreement.ts", () => ({ TosAgreements: { createBang: mocks.createTos } }));
vi.mock("../page-props/settings/payments.ts", () => ({ payoutFacts: mocks.facts }));
vi.mock("./mutation.ts", () => ({
  registerMutations: (...registered: MutationSpec[]) => void mocks.specs.push(...registered),
  remoteIp: () => "127.0.0.1",
}));
vi.mock("../models/user.ts", () => ({
  findUserBang: mocks.findUser,
  setFlag: mocks.setFlag,
  setJsonDataForAttr: mocks.setJson,
  Users: { save: mocks.saveUser, saveBang: mocks.saveUser },
}));
vi.mock("../models/user-compliance-info-writes.ts", () => ({
  birthdayUnderMinimumAge: () => false,
  dupAndSaveBang: mocks.dupAndSave,
  UserComplianceInfos: { load: vi.fn(), build: vi.fn() },
}));
vi.mock("./settings-payments-mutations.ts", () => ({ logPayoutSettingsUpdateByNonOwner: mocks.logAudit }));
vi.mock("./settings-payments-remediation.ts", () => ({
  remediateStripeAccount: mocks.remediate,
  verifyStripeRemediation: mocks.verify,
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
    bankAccount: { count: mocks.bankCount },
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
  mocks.bankCount.mockResolvedValue(0);
  mocks.facts.mockResolvedValue({ stripeAccount: { id: 1 }, minimumPayoutThresholdCents: 1000 });
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

  describe("with payout preferences only", () => {
    const saved = { status: 303, location: "/settings/payments", flash: { notice: "Thanks! You're all set." } };

    beforeEach(() => {
      mocks.findUser.mockResolvedValue({ errors: { fullMessages: () => ["Payout frequency must be daily"] } });
      mocks.saveUser.mockResolvedValue(true);
    });

    it("records the terms acceptance, writes the preferences and notes the save", async () => {
      expect(
        await run(input({ payout_frequency: "monthly", payouts_paused_by_user: true, payout_threshold_cents: "5000" })),
      ).toEqual(saved);
      expect(mocks.createTos).toHaveBeenCalledWith({ user_id: 3, ip: "127.0.0.1" });
      expect(mocks.setJson).toHaveBeenCalledWith(expect.anything(), "payout_frequency", "monthly");
      expect(mocks.setJson).toHaveBeenCalledWith(expect.anything(), "payout_threshold_cents", "5000");
      expect(mocks.setFlag).toHaveBeenCalledWith(expect.anything(), "payouts_paused_by_user", true);
      expect(mocks.logAudit).toHaveBeenCalledWith(expect.anything(), "Payout settings updated");
    });

    it("answers a save of nothing without writing the seller", async () => {
      expect(await run(input({}))).toEqual(saved);
      expect(mocks.createTos).toHaveBeenCalled();
      expect(mocks.saveUser).not.toHaveBeenCalled();
    });

    it("refuses a threshold under the minimum after recording the terms acceptance", async () => {
      expect(await run(input({ payout_threshold_cents: 999 }))).toEqual(
        refusal("Your payout threshold must be greater than the minimum payout amount"),
      );
      expect(mocks.createTos).toHaveBeenCalled();
      expect(mocks.saveUser).not.toHaveBeenCalled();
    });

    it("refuses with the first validation message when the seller does not save", async () => {
      mocks.saveUser.mockResolvedValue(false);
      expect(await run(input({ payout_frequency: "hourly" }))).toEqual(refusal("Payout frequency must be daily"));
      expect(mocks.logAudit).not.toHaveBeenCalled();
    });

    it("hands a seller with a bank account and no Stripe account to Rails before any write", async () => {
      mocks.facts.mockResolvedValue({ stripeAccount: null, minimumPayoutThresholdCents: 1000 });
      mocks.bankCount.mockResolvedValue(1);
      await expect(run(input({ payout_frequency: "monthly" }))).rejects.toThrow(HandBackToRails);
      expect(mocks.createTos).not.toHaveBeenCalled();
    });

    it.each([
      ["a payment address", { payment_address: "a@example.com" }],
      ["a card", { card: { token: "x" } }],
      ["a threshold with a fraction", { payout_threshold_cents: "10.5" }],
      ["a switch that is not a boolean", { payouts_paused_by_user: "true" }],
      ["a frequency that is not text", { payout_frequency: 3 }],
    ])("hands %s to Rails before any write", async (_name, params) => {
      await expect(run(input(params))).rejects.toThrow(HandBackToRails);
      expect(mocks.createTos).not.toHaveBeenCalled();
    });
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

  it("saves a revision with no country for a country the ISO 3166 list does not know", async () => {
    mocks.complianceInfo.mockResolvedValue({ row: row(null), persisted: false });
    const copy = { set: vi.fn() };
    mocks.dupAndSave.mockImplementation(async (_revision: unknown, edit: (copy: unknown) => Promise<void>) =>
      edit(copy),
    );
    mocks.findUser.mockResolvedValue({ get: () => "usd", set: vi.fn() });
    expect(await run(input({ country: "ZZ" }))).toMatchObject({ status: 204 });
    expect(copy.set).toHaveBeenCalledWith("country", null);
    expect(mocks.saveUser).not.toHaveBeenCalled();
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

  it("saves a revision with no country for a country that is not text", async () => {
    mocks.complianceInfo.mockResolvedValue({ row: row(null), persisted: false });
    const copy = { set: vi.fn() };
    mocks.dupAndSave.mockImplementation(async (_revision: unknown, edit: (copy: unknown) => Promise<void>) =>
      edit(copy),
    );
    mocks.findUser.mockResolvedValue({ get: () => "usd", set: vi.fn() });
    expect(await run(input({ country: ["PR"] }))).toMatchObject({ status: 204 });
    expect(copy.set).toHaveBeenCalledWith("country", null);
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

  it("links the merchant account and flashes what the manager answers", async () => {
    mocks.paypalConnect.mockResolvedValue("linked");
    expect(
      await run(input({ merchantIdInPayPal: "PP1", merchantId: "abc123-1", permissionsGranted: "true", extra: "x" })),
    ).toEqual({ status: 302, location: "/checkout/form", flash: { notice: "linked" } });
    expect(mocks.paypalConnect).toHaveBeenCalledWith(expect.objectContaining({ id: 3n }), "PP1", {
      merchantId: "abc123-1",
      permissionsGranted: "true",
    });
    expect(mocks.logAudit).toHaveBeenCalledWith(expect.anything(), "PayPal account connection updated");
  });

  it("sets no flash when the manager answers nothing", async () => {
    mocks.paypalConnect.mockResolvedValue(null);
    expect(await run(input({ merchantIdInPayPal: "PP1", merchantId: "abc123-1" }))).toEqual({
      status: 302,
      location: "/checkout/form",
    });
  });

  it("hands a meta parameter that is not text to Rails", async () => {
    await expect(
      run(input({ merchantIdInPayPal: "PP1", merchantId: "abc123-1", accountStatus: ["a"] })),
    ).rejects.toThrow(HandBackToRails);
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
