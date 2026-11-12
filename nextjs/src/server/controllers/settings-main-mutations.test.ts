import { beforeEach, describe, expect, it, vi } from "vitest";

import { HandBackToRails } from "./application-controller.ts";
import type { MutationInput, MutationSpec } from "./mutation.ts";

const mocks = vi.hoisted(() => ({
  specs: [] as MutationSpec[],
  guard: vi.fn(),
  save: vi.fn(),
  execute: vi.fn(),
  selectRows: vi.fn(),
  requestFormat: vi.fn(),
  authorize: vi.fn(),
  editable: vi.fn(),
  policyRow: vi.fn(),
  policyUpdate: vi.fn(),
  notifyError: vi.fn(),
}));

vi.mock("./mutation.ts", () => ({
  registerMutations: (...registered: MutationSpec[]) => void mocks.specs.push(...registered),
}));
vi.mock("../page-props/settings/guard.ts", () => ({
  settingsGuard: () => mocks.guard,
  notAllowedMessage: () => "You are not allowed to perform this action.",
}));
vi.mock("../policies/authorize.ts", () => ({ authorize: mocks.authorize }));
vi.mock("../policies/seller-context.ts", async (original) => ({
  ...(await original<typeof import("../policies/seller-context.ts")>()),
  loadSellerContext: () => Promise.resolve({}),
}));
vi.mock("../infra/error-reporting.ts", () => ({ notifyError: mocks.notifyError }));
vi.mock("../models/runtime/transaction.ts", () => ({ transaction: (fn: () => unknown) => fn() }));
vi.mock("../models/sql.ts", async (original) => ({
  ...(await original<typeof import("../models/sql.ts")>()),
  execute: mocks.execute,
  selectRows: mocks.selectRows,
}));
vi.mock("../models/user.ts", async (original) => {
  const actual = await original<typeof import("../models/user.ts")>();
  const seller = {
    values: { id: 7n, email: "seller@example.com", unconfirmed_email: null, username: "seller" } as Record<
      string,
      unknown
    >,
    set: vi.fn(),
    get(key: string) {
      return this.values[key];
    },
    attributes: { id: 7n, flags: 0n },
    errors: { fullMessages: () => [] as string[] },
  };
  return {
    ...actual,
    setFlag: vi.fn(),
    findUserBang: () => Promise.resolve(seller),
    Users: { withLock: (_record: unknown, fn: () => unknown) => fn(), save: mocks.save },
    __seller: seller,
  };
});
vi.mock("../models/refund-policy.ts", () => ({
  RefundPolicies: { load: (row: unknown) => row, update: mocks.policyUpdate },
}));
vi.mock("./api-v2/refund-policies.ts", () => ({
  accountLevelRefundPolicyEnabled: mocks.editable,
  sellerRefundPolicy: mocks.policyRow,
}));
vi.mock("./rails-params.ts", () => ({ requestFormat: mocks.requestFormat }));

const userModule = (await import("../models/user.ts")) as unknown as {
  __seller: {
    values: Record<string, unknown>;
    set: ReturnType<typeof vi.fn>;
    errors: { fullMessages: () => string[] };
  };
  setFlag: ReturnType<typeof vi.fn>;
};
await import("./settings-main-mutations.ts");

const seller = userModule.__seller;
const spec = (method: string, pattern = "/settings") =>
  mocks.specs.find((candidate) => candidate.method === method && candidate.pattern === pattern)!;
const input = (user: Record<string, unknown> | undefined, currentSeller: Record<string, unknown> = {}): MutationInput =>
  ({
    params: user === undefined ? {} : { user },
    url: new URL("http://example.com/settings"),
    rawBody: new TextEncoder().encode(JSON.stringify(user === undefined ? {} : { user })),
    context: { currentSeller: { id: 7n, unconfirmed_email: null, confirmed_at: new Date(), ...currentSeller } },
    request: { headers: new Headers({ "content-type": "application/json" }) },
  }) as unknown as MutationInput;
const form = (overrides: Record<string, unknown> = {}) => ({
  email: "seller@example.com",
  username: "seller",
  locale: "en",
  enable_payment_email: true,
  purchasing_power_parity_excluded_product_ids: [],
  product_level_support_emails: [],
  ...overrides,
});

beforeEach(() => {
  process.env.OBFUSCATE_IDS_CIPHER_KEY = "a".repeat(32);
  process.env.OBFUSCATE_IDS_NUMERIC_CIPHER_KEY = "0";
  seller.values = { id: 7n, email: "seller@example.com", unconfirmed_email: null, username: "seller" };
  seller.set.mockReset();
  seller.errors.fullMessages = () => [];
  userModule.setFlag.mockReset();
  for (const mock of Object.values(mocks)) if ("mockReset" in mock) mock.mockReset();
  mocks.guard.mockResolvedValue(null);
  mocks.save.mockResolvedValue(true);
  mocks.execute.mockResolvedValue(1);
  mocks.selectRows.mockResolvedValue([]);
  mocks.editable.mockResolvedValue(false);
  mocks.requestFormat.mockReturnValue("html");
});

describe("PUT /settings", () => {
  const update = spec("PUT");

  it("serves the refusal of the settings guard", async () => {
    const refusal = { status: 302, location: "/dashboard", rescued: true };
    mocks.guard.mockResolvedValue(refusal);

    expect(await update.run(input(form()))).toBe(refusal);
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it.each([[undefined], [{}]])("hands a request without a user hash (%j) to Rails", async (user) => {
    await expect(update.run(input(user))).rejects.toBeInstanceOf(HandBackToRails);
  });

  it.each([
    ["a new email address", { email: "new@example.com" }],
    ["a blank email address", { email: "" }],
    ["a username change", { username: "renamed" }],
  ])("hands %s to Rails before saving", async (_label, overrides) => {
    await expect(update.run(input(form(overrides)))).rejects.toBeInstanceOf(HandBackToRails);
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("hands a seller with an email change awaiting confirmation to Rails", async () => {
    seller.values.unconfirmed_email = "pending@example.com";

    await expect(update.run(input(form()))).rejects.toBeInstanceOf(HandBackToRails);
  });

  it.each([
    ["a null timezone", { timezone: null }],
    ["a PPP limit with trailing text", { purchasing_power_parity_limit: "12abc" }],
    ["excluded products that are not a list", { purchasing_power_parity_excluded_product_ids: "abc" }],
    ["a support email entry without a list", { product_level_support_emails: [{ email: "a@example.com" }] }],
    [
      "an octal feature announcements version",
      { feature_announcements_subscribed: true, feature_announcements_version: "010" },
    ],
  ])("hands %s to Rails", async (_label, overrides) => {
    await expect(update.run(input(form(overrides)))).rejects.toBeInstanceOf(HandBackToRails);
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("saves the unchanged identity with the flags and columns as sent", async () => {
    const result = await update.run(
      input(form({ timezone: "UTC", purchasing_power_parity_limit: "50", enable_payment_email: false, ignored: "x" })),
    );

    expect(result).toEqual({ status: 303, location: "/settings", flash: { notice: "Your account has been updated!" } });
    expect(userModule.setFlag).toHaveBeenCalledWith(seller, "enable_payment_email", false);
    expect(seller.set).toHaveBeenCalledWith("timezone", "UTC");
    expect(seller.set).toHaveBeenCalledWith("purchasing_power_parity_limit", 50);
    expect(seller.set).not.toHaveBeenCalledWith("ignored", expect.anything());
  });

  it.each([
    [12.5, 12],
    [-3.9, -3],
    [0.9, 0],
    [40.0, 40],
  ])("truncates the float PPP limit %s like an integer column", async (sent, stored) => {
    // The test input encodes the body with JSON.stringify, which drops the point of a whole float: write the literal.
    const request = input(form({ purchasing_power_parity_limit: sent }));
    (request as { rawBody: Uint8Array }).rawBody = new TextEncoder().encode(
      JSON.stringify({ user: form({ purchasing_power_parity_limit: "FLOAT" }) }).replace(
        '"FLOAT"',
        Number.isInteger(sent) ? `${sent}.0` : String(sent),
      ),
    );

    await update.run(request);

    expect(seller.set).toHaveBeenCalledWith("purchasing_power_parity_limit", stored);
  });

  it("hands a float PPP limit past a 4-byte column to Rails", async () => {
    const request = input(form());
    (request as { rawBody: Uint8Array }).rawBody = new TextEncoder().encode(
      JSON.stringify({ user: form({ purchasing_power_parity_limit: "FLOAT" }) }).replace('"FLOAT"', "3.0e10"),
    );

    await expect(update.run(request)).rejects.toBeInstanceOf(HandBackToRails);
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("redirects with the model errors when the seller does not save, without touching the rest", async () => {
    mocks.save.mockResolvedValue(false);
    seller.errors.fullMessages = () => ["Support email is invalid"];

    const result = await update.run(input(form({ support_email: "nope" })));

    expect(result).toEqual({ status: 302, location: "/settings", flash: { alert: "Support email is invalid" } });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("answers the generic failure when a later step raises and keeps the earlier ones", async () => {
    const result = await update.run(
      input(form({ product_level_support_emails: [{ email: "support@gumroad.com", product_ids: ["abc"] }] })),
    );

    expect(result).toEqual({
      status: 302,
      location: "/settings",
      flash: { alert: "Something broke. We're looking into what happened. Sorry about this!" },
    });
    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(mocks.notifyError).toHaveBeenCalledTimes(1);
  });

  it("clears every product support email when none is sent", async () => {
    await update.run(input(form()));

    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });

  describe("feature announcements", () => {
    it("reports an unchanged subscription without writing", async () => {
      mocks.selectRows.mockResolvedValueOnce([{ subscribed: 1, version: 2 }]);

      const result = await update.run(
        input(form({ feature_announcements_subscribed: true, feature_announcements_version: 2 })),
      );

      expect(result).toMatchObject({ status: 303, flash: { notice: "Your account has been updated!" } });
    });

    it("saves the account but not a subscription that changed since the form rendered", async () => {
      mocks.selectRows.mockResolvedValueOnce([{ subscribed: 0, version: 3 }]);

      const result = await update.run(
        input(form({ feature_announcements_subscribed: true, feature_announcements_version: 2 })),
      );

      expect(result).toMatchObject({
        status: 303,
        flash: { notice: expect.stringContaining("Feature announcements changed elsewhere") as string },
      });
    });

    it("inserts the first row when none exists and the form carried version 0", async () => {
      mocks.selectRows.mockResolvedValueOnce([]);

      await update.run(input(form({ feature_announcements_subscribed: "true", feature_announcements_version: "0" })));

      expect(mocks.execute).toHaveBeenCalledTimes(2);
    });
  });

  describe("account-level refund policy", () => {
    const row = {
      max_refund_period_in_days: 30,
      fine_print: null,
      errors: { fullMessages: () => ["Max refund period in days is not included in the list"] },
    };

    beforeEach(() => {
      mocks.editable.mockResolvedValue(true);
      mocks.policyRow.mockResolvedValue(row);
      mocks.policyUpdate.mockResolvedValue(true);
    });

    it("hands the fine print the classifier checks to Rails before saving anything", async () => {
      const user = form({ seller_refund_policy: { max_refund_period_in_days: 30, fine_print: "Ask nicely" } });

      await expect(update.run(input(user))).rejects.toBeInstanceOf(HandBackToRails);
      expect(mocks.save).not.toHaveBeenCalled();
    });

    it("saves a blank fine print without the classifier", async () => {
      await update.run(input(form({ seller_refund_policy: { max_refund_period_in_days: 14, fine_print: "" } })));

      expect(mocks.policyUpdate).toHaveBeenCalledWith(row, { max_refund_period_in_days: 14, fine_print: "" });
    });

    it("hands a section that is not a hash to Rails", async () => {
      await expect(update.run(input(form({ seller_refund_policy: null })))).rejects.toBeInstanceOf(HandBackToRails);
    });

    it("updates the policy with the period and the fine print as sent", async () => {
      await update.run(input(form({ seller_refund_policy: { max_refund_period_in_days: "14" } })));

      expect(mocks.policyUpdate).toHaveBeenCalledWith(row, { max_refund_period_in_days: 14, fine_print: null });
    });

    it("redirects with the policy errors when it does not save", async () => {
      mocks.policyUpdate.mockResolvedValue(false);

      const result = await update.run(input(form({ seller_refund_policy: { max_refund_period_in_days: 14 } })));

      expect(result).toMatchObject({
        status: 302,
        flash: { alert: "Max refund period in days is not included in the list" },
      });
    });
  });
});

describe("PATCH /settings", () => {
  it("is served like PUT", () => {
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(spec("PATCH").run).toBe(spec("PUT").run);
  });
});

describe("POST /settings/resend_confirmation_email", () => {
  const resend = spec("POST", "/settings/resend_confirmation_email");

  it("hands a seller who still has to confirm to Rails, which sends the mail", async () => {
    await expect(resend.run(input(undefined, { confirmed_at: null }))).rejects.toBeInstanceOf(HandBackToRails);
  });

  it("hands a seller with a pending address to Rails", async () => {
    await expect(resend.run(input(undefined, { unconfirmed_email: "new@example.com" }))).rejects.toBeInstanceOf(
      HandBackToRails,
    );
  });

  it("acknowledges a confirmed seller with a JSON failure", async () => {
    mocks.requestFormat.mockReturnValue("json");

    const result = await resend.run(input(undefined));

    expect(result).toMatchObject({ status: 200 });
    expect(JSON.parse((result as { body: string }).body)).toEqual({ success: false });
  });

  it("redirects a confirmed seller back to the settings with an alert", async () => {
    expect(await resend.run(input(undefined))).toEqual({
      status: 302,
      location: "/settings",
      flash: { alert: "Sorry, something went wrong. Please try again." },
    });
  });

  it("answers 401 JSON to a JSON request the policy refuses", async () => {
    const { NotAuthorizedError } = await import("../policies/seller-context.ts");
    mocks.requestFormat.mockReturnValue("json");
    mocks.authorize.mockImplementation(() => {
      throw new NotAuthorizedError();
    });

    const result = await resend.run(input(undefined));

    expect(result).toMatchObject({ status: 401, rescued: true });
    expect(JSON.parse((result as { body: string }).body)).toEqual({
      success: false,
      error: "You are not allowed to perform this action.",
    });
  });
});
