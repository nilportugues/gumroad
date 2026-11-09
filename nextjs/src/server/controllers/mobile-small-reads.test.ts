import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MobileAction, MobileInput } from "./mobile-api.ts";

const { actions, selectRows } = vi.hoisted(() => ({ actions: [] as MobileAction[], selectRows: vi.fn() }));

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
  encrypt: (value: number | bigint) => `enc${value}`,
}));

await import("./mobile-preorders.ts");
await import("./mobile-installments.ts");

const find = (pattern: string) => actions.find((action) => action.pattern === pattern)!;
const input = (params: Record<string, unknown> = {}) => ({ params }) as unknown as MobileInput;
const body = (result: unknown) => JSON.parse((result as { body: string }).body);
const status = (result: unknown) => (result as { status: number }).status;

beforeEach(() => selectRows.mockReset());

describe("registration", () => {
  it("registers the reads without an OAuth scope and no write", () => {
    expect(actions.map((action) => [action.method, action.pattern, action.scopes])).toEqual([
      ["GET", "/mobile/preorders/preorder_attributes/:id", null],
      ["GET", "/mobile/installments/:id", null],
    ]);
  });
});

describe("GET /mobile/preorders/preorder_attributes/:id", () => {
  const run = find("/mobile/preorders/preorder_attributes/:id").run;

  it("answers 404 for an id that decrypts to nothing", async () => {
    const result = await run(input({ id: "xxx" }), null);
    expect(status(result)).toBe(404);
    expect(body(result)).toEqual({ success: false, message: "Could not find preorder" });
    expect(selectRows).not.toHaveBeenCalled();
  });

  it("answers 404 for a preorder that is not authorization or charge successful", async () => {
    selectRows.mockResolvedValue([]);
    expect(status(await run(input({ id: "5" }), null))).toBe(404);
  });

  it("hands back a preorder that exists", async () => {
    selectRows.mockResolvedValue([{ 1: 1 }]);
    await expect(run(input({ id: "5" }), null)).rejects.toThrow(/preorder that exists/u);
  });
});

describe("GET /mobile/installments/:id", () => {
  const run = find("/mobile/installments/:id").run;

  // spec/controllers/api/mobile/installments_controller_spec.rb
  it("answers 404 for an unknown installment", async () => {
    const result = await run(input({ id: "xxx" }), null);
    expect(status(result)).toBe(404);
    expect(body(result)).toEqual({ success: false, message: "Could not find installment" });
  });

  it("answers 404 when none of the context params is given", async () => {
    selectRows.mockResolvedValueOnce([{ 1: 1 }]);
    const result = await run(input({ id: "3" }), null);
    expect(status(result)).toBe(404);
    expect(body(result)).toEqual({ success: false, message: "Could not find related object to the installment." });
  });

  it("answers 404 when the given purchase does not exist", async () => {
    selectRows.mockResolvedValueOnce([{ 1: 1 }]);
    const result = await run(input({ id: "3", purchase_id: "xxx" }), null);
    expect(body(result).message).toBe("Could not find related object to the installment.");
  });

  it("only looks at the first context param that is present", async () => {
    selectRows.mockResolvedValueOnce([{ 1: 1 }]).mockResolvedValueOnce([]);
    const result = await run(input({ id: "3", purchase_id: "9", follower_id: "4" }), null);
    expect(status(result)).toBe(404);
    expect(selectRows).toHaveBeenCalledTimes(2);
  });

  it("hands back an installment with a context object that exists", async () => {
    selectRows.mockResolvedValue([{ 1: 1 }]);
    await expect(run(input({ id: "3", follower_id: "4" }), null)).rejects.toThrow(/context object/u);
  });

  it("hands back a context param that is not a string", async () => {
    selectRows.mockResolvedValue([{ 1: 1 }]);
    await expect(run(input({ id: "3", follower_id: ["4"] }), null)).rejects.toThrow(/not a string/u);
  });
});
