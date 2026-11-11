import { beforeEach, describe, expect, it, vi } from "vitest";

import { HandBackToRails } from "./application-controller.ts";
import type { MutationInput, MutationSpec } from "./mutation.ts";

const { specs, selectRows, findLink, findUser, loggedInUser } = vi.hoisted(() => ({
  specs: [] as MutationSpec[],
  selectRows: vi.fn(),
  findLink: vi.fn(),
  findUser: vi.fn(),
  loggedInUser: vi.fn(),
}));

vi.mock("./mutation.ts", () => ({
  registerMutations: (...registered: MutationSpec[]) => void specs.push(...registered),
}));
vi.mock("../models/sql.ts", () => ({
  selectRows,
  column: (_table: string, name: string) => name,
  table: (name: string) => name,
}));
vi.mock("../../lib/db.ts", () => ({ db: { link: { findUnique: findLink }, user: { findFirst: findUser } } }));
vi.mock("../../lib/obfuscate-ids.ts", () => ({ decrypt: (id: string) => (id === "unknown" ? null : 7) }));
vi.mock("../auth/resolve.ts", () => ({ railsLoggedInUser: loggedInUser }));

await import("./users-controller.ts");

const run = specs.find((spec) => spec.method === "POST" && spec.pattern === "/add_purchase_to_library")!.run;

const PURCHASE = { id: 7n, email: "guest@example.com", purchaser_id: null, link_id: 3n, flags: 0n };
const call = (user: unknown) => run({ params: { user }, context: {} } as unknown as MutationInput);
const body = async (user: unknown) => JSON.parse(String(((await call(user)) as { body: string }).body));
const VALID = { purchase_id: "abc", purchase_email: "guest@example.com" };
// PurchaseFlags.is_reassignment_locked is bit 32 (search/flags.ts).
const LOCKED = 2n ** 31n;

describe("POST /add_purchase_to_library", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    selectRows.mockResolvedValue([PURCHASE]);
    findLink.mockResolvedValue({ user_id: 11n });
    findUser.mockResolvedValue(null);
    loggedInUser.mockReturnValue(null);
  });

  it("answers failure when the user param is not a hash", async () => {
    expect(await body(undefined)).toEqual({ success: false });
    expect(await body("guest")).toEqual({ success: false });
    expect(await body(["a"])).toEqual({ success: false });
  });

  it("answers failure for an id that does not decrypt", async () => {
    expect(await body({ ...VALID, purchase_id: "unknown" })).toEqual({ success: false });
  });

  it("answers failure for a purchase that is missing", async () => {
    selectRows.mockResolvedValue([]);
    expect(await body(VALID)).toEqual({ success: false });
  });

  it("compares the email byte for byte", async () => {
    expect(await body({ ...VALID, purchase_email: "GUEST@example.com" })).toEqual({ success: false });
  });

  it("answers failure for a purchase locked against reassignment", async () => {
    selectRows.mockResolvedValue([{ ...PURCHASE, flags: LOCKED }]);
    expect(await body(VALID)).toEqual({ success: false });
  });

  it("answers failure for the seller's own purchase", async () => {
    selectRows.mockResolvedValue([{ ...PURCHASE, purchaser_id: 11n }]);
    expect(await body(VALID)).toEqual({ success: false });
  });

  it("answers failure when no account owns the email", async () => {
    expect(await body(VALID)).toEqual({ success: false });
  });

  it("refuses the seller who sold the purchase", async () => {
    loggedInUser.mockReturnValue({ id: 11n, email: "seller@example.com" });
    expect(await body(VALID)).toEqual({
      success: false,
      error_message: "This is your customer's purchase, so it can't be moved into your account.",
    });
  });

  it("hands a signed-in buyer's move to Rails", async () => {
    loggedInUser.mockReturnValue({ id: 12n, email: "buyer@example.com" });
    await expect(call(VALID)).rejects.toBeInstanceOf(HandBackToRails);
  });

  it("hands an email an account owns to Rails", async () => {
    findUser.mockResolvedValue({ id: 5n });
    await expect(call({ ...VALID, password: "secret" })).rejects.toBeInstanceOf(HandBackToRails);
  });

  it("hands a parameter that is not text to Rails", async () => {
    await expect(call({ ...VALID, purchase_id: ["a"] })).rejects.toBeInstanceOf(HandBackToRails);
  });
});
