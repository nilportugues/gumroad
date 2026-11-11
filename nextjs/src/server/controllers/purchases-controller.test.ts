import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MutationInput, MutationSpec } from "./mutation.ts";

const { specs, selectRows, loadSellerContext, decryptSecureExternalId, readEncryptedCookie } = vi.hoisted(() => ({
  specs: [] as MutationSpec[],
  selectRows: vi.fn(),
  loadSellerContext: vi.fn(),
  decryptSecureExternalId: vi.fn(),
  readEncryptedCookie: vi.fn(),
}));

vi.mock("./mutation.ts", () => ({
  registerMutations: (...registered: MutationSpec[]) => void specs.push(...registered),
}));
vi.mock("../models/sql.ts", async (original) => ({
  ...(await original<typeof import("../models/sql.ts")>()),
  selectRows,
  castRow: (_: string, row: unknown) => row,
}));
vi.mock("../models/secure-external-id.ts", async (original) => ({
  ...(await original<typeof import("../models/secure-external-id.ts")>()),
  decryptSecureExternalId,
}));
vi.mock("../policies/seller-context.ts", async (original) => ({
  ...(await original<typeof import("../policies/seller-context.ts")>()),
  loadSellerContext,
}));
vi.mock("../auth/rails-cookies.ts", () => ({ readEncryptedCookie }));
vi.mock("../auth/rails-session-config.ts", () => ({ railsCookieSecrets: () => ({}) }));
vi.mock("../../lib/obfuscate-ids.ts", () => ({
  decrypt: (value: string) => (/^\d+$/u.test(value) ? Number(value) : null),
  encrypt: (id: number) => `ext-${id}`,
  encryptNumeric: (id: number) => id + 1000,
}));

await import("./purchases-controller.ts");
const { SecureExternalIdError } = await import("../models/secure-external-id.ts");

const find = (method: string, pattern: string) =>
  specs.find((spec) => spec.method === method && spec.pattern === pattern)!;
const seller = { id: 7n, timezone: "Pacific Time (US & Canada)" };
const input = (id = "5", signedIn = true): MutationInput =>
  ({
    routeParams: { id },
    context: {
      currentSeller: signedIn ? seller : null,
      loggedInUser: signedIn ? seller : null,
      impersonatedUser: null,
    },
  }) as unknown as MutationInput;
const body = (result: unknown): unknown => JSON.parse((result as { body: string }).body);
const status = (result: unknown) => (result as { status: number }).status;
const accountant = {
  user: { id: 11n },
  seller,
  memberships: [{ user_id: 11n, seller_id: 7n, role: "accountant", deleted_at: null }],
};

beforeEach(() => {
  selectRows.mockReset();
  decryptSecureExternalId.mockReset();
  readEncryptedCookie.mockReset();
  loadSellerContext.mockReset();
  loadSellerContext.mockResolvedValue({ user: seller, seller, memberships: [] });
});

describe.each([
  ["PUT", "/purchases/:id"],
  ["PATCH", "/purchases/:id"],
  ["POST", "/purchases/:id/change_can_contact"],
  ["POST", "/purchases/:id/cancel_preorder_by_seller"],
])("%s %s", (method, pattern) => {
  const action = find(method, pattern);

  it("hands the seller's own purchase back to Rails", async () => {
    selectRows.mockResolvedValueOnce([{ id: 5n, seller_id: 7n }]);
    await expect(action.run(input())).rejects.toThrow(/^a /u);
  });

  it("answers 404 JSON for another seller's purchase", async () => {
    selectRows.mockResolvedValueOnce([{ id: 5n, seller_id: 8n }]);
    const result = await action.run(input());
    expect(status(result)).toBe(404);
    expect(body(result)).toEqual({ success: false, error: "Not found" });
  });

  it("raises a routing error for a purchase that does not exist or an id that does not decrypt", async () => {
    selectRows.mockResolvedValueOnce([]);
    await expect(action.run(input())).rejects.toThrow("Not Found");
    await expect(action.run(input("not-an-id"))).rejects.toThrow("Not Found");
  });

  it("answers 401 for a team member who cannot update customers", async () => {
    loadSellerContext.mockResolvedValue(accountant);
    selectRows.mockResolvedValueOnce([{ id: 5n, seller_id: 7n }]);
    expect(status(await action.run(input()))).toBe(401);
  });

  it("hands a signed-out request back to Rails", async () => {
    await expect(action.run(input("5", false))).rejects.toThrow(/signed-out/u);
  });
});

describe("PUT /purchases/:id/refund", () => {
  const action = find("PUT", "/purchases/:id/refund");

  it("answers 401 for a team member who cannot refund", async () => {
    loadSellerContext.mockResolvedValue(accountant);
    expect(status(await action.run(input()))).toBe(401);
  });
});

describe.each([
  ["GET", "/purchases/:id/receipt"],
  ["GET", "/purchases/:id/confirm_receipt_email"],
  ["GET", "/purchases/:id/subscribe"],
  ["POST", "/purchases/:id/subscribe"],
  ["POST", "/purchases/:id/resend_receipt"],
])("%s %s", (method, pattern) => {
  const action = find(method, pattern);

  it("raises a routing error for a purchase that does not exist", async () => {
    selectRows.mockResolvedValueOnce([]);
    await expect(action.run(input("5", false))).rejects.toThrow("Not Found");
  });

  it("hands an existing purchase back to Rails", async () => {
    selectRows.mockResolvedValueOnce([{ id: 5n, seller_id: 7n }]);
    await expect(action.run(input("5", false))).rejects.toThrow(/^a |^the /u);
  });
});

describe("GET /purchases/:id/unsubscribe", () => {
  const action = find("GET", "/purchases/:id/unsubscribe");

  it("hands a token that opens a purchase back to Rails", async () => {
    decryptSecureExternalId.mockReturnValue("5");
    selectRows.mockResolvedValueOnce([{ 1: 1 }]);
    await expect(action.run(input("token"))).rejects.toThrow(/unsubscribe/u);
  });

  it("hands a legacy purchase external id back to Rails for the signed redirect", async () => {
    decryptSecureExternalId.mockReturnValue(null);
    selectRows.mockResolvedValueOnce([{ 1: 1 }]);
    await expect(action.run(input("5"))).rejects.toThrow(/signed redirect/u);
  });

  it("hands a legacy charge external id back to Rails", async () => {
    decryptSecureExternalId.mockReturnValue(null);
    selectRows.mockResolvedValueOnce([]).mockResolvedValueOnce([{ 1: 1 }]);
    await expect(action.run(input("5"))).rejects.toThrow(/signed redirect/u);
  });

  it("raises a routing error when neither a purchase nor a charge matches", async () => {
    decryptSecureExternalId.mockReturnValue(null);
    selectRows.mockResolvedValue([]);
    await expect(action.run(input("5"))).rejects.toThrow("Not Found");
    await expect(action.run(input("garbage"))).rejects.toThrow("Not Found");
  });

  it("hands the request back when the SecureExternalId configuration is missing", async () => {
    decryptSecureExternalId.mockImplementation(() => {
      throw new SecureExternalIdError("SecureExternalId configuration is missing");
    });
    await expect(action.run(input("token"))).rejects.toThrow(/configuration/u);
  });
});

describe("POST /purchases/:id/confirm", () => {
  const action = find("POST", "/purchases/:id/confirm");

  it("hands a purchase with a valid confirm token back to Rails", async () => {
    decryptSecureExternalId.mockReturnValue("5");
    selectRows.mockResolvedValueOnce([{ 1: 1 }]);
    await expect(action.run(input("token", false))).rejects.toThrow(/confirmation/u);
    expect(decryptSecureExternalId).toHaveBeenCalledWith("Purchase", "token", "confirm");
  });

  it("raises a routing error for a token that does not open a purchase", async () => {
    decryptSecureExternalId.mockReturnValue(null);
    await expect(action.run(input("token", false))).rejects.toThrow("Not Found");
    decryptSecureExternalId.mockReturnValue("5");
    selectRows.mockResolvedValueOnce([]);
    await expect(action.run(input("token", false))).rejects.toThrow("Not Found");
  });
});

describe("POST /preorders/:id/charge_preorder", () => {
  const action = find("POST", "/preorders/:id/charge_preorder");

  it("hands an existing preorder back to Rails", async () => {
    selectRows.mockResolvedValueOnce([{ 1: 1 }]);
    await expect(action.run(input("5", false))).rejects.toThrow(/preorder charge/u);
  });

  it("raises a routing error for a preorder that does not exist or an id that does not decrypt", async () => {
    selectRows.mockResolvedValueOnce([]);
    await expect(action.run(input("5", false))).rejects.toThrow("Not Found");
    await expect(action.run(input("not-an-id", false))).rejects.toThrow("Not Found");
  });
});

describe("PUT /subscriptions/:id", () => {
  const action = find("PUT", "/subscriptions/:id");
  const withCookie = (cookies: Record<string, string> = {}) => {
    const request = input("5", false);
    return { ...request, request: { cookies: new Map(Object.entries(cookies)) } } as unknown as MutationInput;
  };

  it("hands a subscription whose manage cookie matches back to Rails", async () => {
    selectRows.mockResolvedValueOnce([{ 1: 1 }]);
    readEncryptedCookie.mockReturnValue("ext-5");
    await expect(action.run(withCookie({ subscription_1005: "sealed" }))).rejects.toThrow(/subscription update/u);
    expect(readEncryptedCookie).toHaveBeenCalledWith({}, "subscription_1005", "sealed");
  });

  it("raises a routing error for a subscription that does not exist or an id that does not decrypt", async () => {
    selectRows.mockResolvedValueOnce([]);
    await expect(action.run(withCookie())).rejects.toThrow("Not Found");
    await expect(
      action.run({ ...input("not-an-id", false), request: { cookies: new Map() } } as unknown as MutationInput),
    ).rejects.toThrow("Not Found");
  });

  it("raises a routing error when the cookie is missing or belongs to another subscription", async () => {
    selectRows.mockResolvedValue([{ 1: 1 }]);
    readEncryptedCookie.mockReturnValue(null);
    await expect(action.run(withCookie())).rejects.toThrow("Not Found");
    readEncryptedCookie.mockReturnValue("ext-6");
    await expect(action.run(withCookie({ subscription_1005: "sealed" }))).rejects.toThrow("Not Found");
  });
});
