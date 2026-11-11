import { beforeEach, describe, expect, it, vi } from "vitest";

import { HandBackToRails } from "./application-controller.ts";
import type { MobileAction, MobileAuth, MobileInput } from "./mobile-api.ts";

const { actions, selectRows } = vi.hoisted(() => ({
  actions: [] as MobileAction[],
  selectRows: vi.fn(),
}));

vi.mock("./mobile-api.ts", async (original) => ({
  ...(await original<typeof import("./mobile-api.ts")>()),
  registerMobile: (...registered: MobileAction[]) => void actions.push(...registered),
}));
vi.mock("../models/sql.ts", async (original) => ({
  ...(await original<typeof import("../models/sql.ts")>()),
  selectRows,
}));
vi.mock("../../lib/obfuscate-ids.ts", () => ({
  decrypt: (value: string) => (/^\d+$/u.test(value) ? Number(value) : null),
}));

await import("./mobile-seller-writes.ts");

const find = (method: string, pattern: string) =>
  actions.find((registered) => registered.method === method && registered.pattern === pattern)!;
const owner = { id: 7n, unconfirmed_email: null as string | null, confirmed_at: new Date() as Date | null };
const auth = { owner } as unknown as MobileAuth;
const input = (params: Record<string, unknown>) => ({ params }) as unknown as MobileInput;
const body = (result: unknown) => JSON.parse((result as { body: string }).body) as Record<string, unknown>;
const status = (result: unknown) => (result as { status: number }).status;
const handedBack = (promise: Promise<unknown>) => expect(promise).rejects.toBeInstanceOf(HandBackToRails);

beforeEach(() => {
  selectRows.mockReset();
  owner.unconfirmed_email = null;
  owner.confirmed_at = new Date();
});

describe("PATCH /mobile/sales/:id/refund", () => {
  const run = (params: Record<string, unknown>) =>
    find("PATCH", "/mobile/sales/:id/refund").run(input({ id: "5", ...params }), auth);

  it("registers a write behind the mobile_api scope", () => {
    expect(find("PATCH", "/mobile/sales/:id/refund").scopes).toEqual(["mobile_api"]);
  });

  it("refuses an amount with a comma before looking the sale up", async () => {
    const result = await run({ amount: "1,00" });
    expect(status(result)).toBe(200);
    expect(body(result)).toEqual({ success: false, message: "Commas not supported in refund amount." });
    expect(selectRows).not.toHaveBeenCalled();
  });

  it("answers 404 for a sale that is not a paid sale of the seller", async () => {
    selectRows.mockResolvedValueOnce([]);
    const result = await run({ amount: "1.00" });
    expect(status(result)).toBe(404);
    expect(body(result)).toEqual({ success: false, error: "Not found" });
  });

  it("answers 404 for an id that does not decrypt", async () => {
    const result = await find("PATCH", "/mobile/sales/:id/refund").run(input({ id: "xxx" }), auth);
    expect(status(result)).toBe(404);
    expect(selectRows).not.toHaveBeenCalled();
  });

  it("hands a refund of a paid sale back", async () => {
    selectRows.mockResolvedValueOnce([{ present: 1 }]);
    await handedBack(run({ amount: "1.00" }));
  });

  it("hands an amount that is not text back", async () => {
    await handedBack(run({ amount: 5 }));
  });
});

describe("POST /mobile/commissions/:id/complete", () => {
  const run = (id = "5") => find("POST", "/mobile/commissions/:id/complete").run(input({ id }), auth);

  it("answers 404 for a commission whose deposit is not the seller's", async () => {
    selectRows.mockResolvedValueOnce([]);
    const result = await run();
    expect(status(result)).toBe(404);
    expect(body(result)).toEqual({ success: false, message: "Could not find commission" });
  });

  it("hands the completion of the seller's commission back", async () => {
    selectRows.mockResolvedValueOnce([{ present: 1 }]);
    await handedBack(run());
  });
});

describe("POST /mobile/subscriptions/:id/cancel", () => {
  const run = (id = "5") => find("POST", "/mobile/subscriptions/:id/cancel").run(input({ id }), auth);

  it("answers 404 for a subscription that is not the seller's", async () => {
    selectRows.mockResolvedValueOnce([]);
    const result = await run();
    expect(status(result)).toBe(404);
    expect(body(result)).toEqual({ success: false, message: "Could not find subscription" });
  });

  it("hands the cancel of the seller's subscription back", async () => {
    selectRows.mockResolvedValueOnce([{ present: 1 }]);
    await handedBack(run());
  });
});

describe("DELETE /mobile/products/:id", () => {
  const run = () => find("DELETE", "/mobile/products/:id").run(input({ id: "abc" }), auth);

  it("answers 404 for a product that is not a live product of the seller", async () => {
    selectRows.mockResolvedValueOnce([]);
    const result = await run();
    expect(status(result)).toBe(404);
    expect(body(result)).toEqual({ success: false, message: "Product not found" });
  });

  it("hands the delete of the seller's product back", async () => {
    selectRows.mockResolvedValueOnce([{ present: 1 }]);
    await handedBack(run());
  });
});

describe("GET /mobile/url_redirects/get_url_redirect_attributes/:id", () => {
  const action = find("GET", "/mobile/url_redirects/get_url_redirect_attributes/:id");

  it("registers a read that needs no OAuth scope", () => {
    expect(action.scopes).toBeNull();
  });

  it("answers 404 for an unknown url redirect with a response that halts the chain", async () => {
    selectRows.mockResolvedValueOnce([]);
    const result = await action.run(input({ id: "5" }), null);
    expect(result).toMatchObject({ status: 404, rescued: true });
    expect(body(result)).toEqual({ success: false, message: "Could not find url redirect" });
  });

  it("hands the payload of a url redirect back", async () => {
    selectRows.mockResolvedValueOnce([{ present: 1 }]);
    await handedBack(action.run(input({ id: "5" }), null));
  });
});

describe("the sessions", () => {
  it("hands a sign-in back and keeps the visitor's cookies", async () => {
    const action = find("POST", "/mobile/sessions");
    expect(action.skipForgeryProtection).toBe(true);
    await handedBack(action.run(input({}), auth));
  });

  it("answers an already confirmed address without sending anything", async () => {
    const result = await find("POST", "/mobile/sessions/resend_confirmation_email").run(input({}), auth);
    expect(status(result)).toBe(200);
    expect(body(result)).toEqual({ success: true, status: "already_confirmed" });
  });

  it("hands a pending change of address back", async () => {
    owner.unconfirmed_email = "new@example.com";
    await handedBack(find("POST", "/mobile/sessions/resend_confirmation_email").run(input({}), auth));
  });

  it("hands an unconfirmed account back", async () => {
    owner.confirmed_at = null;
    await handedBack(find("POST", "/mobile/sessions/resend_confirmation_email").run(input({}), auth));
  });
});
