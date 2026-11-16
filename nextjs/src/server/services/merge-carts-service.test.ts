import { afterEach, describe, expect, it } from "vitest";

import { setTransactionRunner, type Tx } from "../models/runtime/transaction.ts";
import { setSqlClient } from "../models/sql.ts";

import { mergeGuestCart, planGuestCartMerge } from "./merge-carts-service.ts";

// The parity examples (login_passkeys_parity_spec.rb, auth_mutations_parity_spec.rb) prove the rows; these pin the decisions made
// before the first write and the order of the statements.
const USER = { id: 7n, email: "buyer@example.com" };
const NOW = new Date("2026-01-01T00:00:00Z");

const cart = (overrides: Record<string, unknown>) => ({
  id: 1n,
  user_id: null,
  return_url: null,
  discount_codes: [],
  reject_ppp_discount: 0,
  email: null,
  browser_guid: "guid",
  ...overrides,
});
const line = (overrides: Record<string, unknown>) => ({
  id: 10n,
  product_id: 100n,
  option_id: null,
  price: 500n,
  quantity: 1,
  referrer: "direct",
  url_parameters: {},
  accepted_offer_details: {},
  ...overrides,
});

type Tables = { guests: unknown[]; targets: unknown[]; lines: Record<string, unknown[]> };

function fakeDatabase(tables: Tables) {
  const statements: string[] = [];
  const client = {
    $queryRaw: (async (sql: { strings: string[]; values: unknown[] }) => {
      const text = sql.strings.join("?");
      if (text.includes("`carts`.`browser_guid`")) return tables.guests;
      if (text.includes("`carts`.`user_id`")) return tables.targets;
      return tables.lines[String(sql.values[0])] ?? [];
    }) as never,
    $executeRaw: (async (sql: { strings: string[] }) => {
      statements.push(sql.strings.join("?").trim().split(" ").slice(0, 3).join(" "));
      return 1;
    }) as never,
  };
  setSqlClient(() => client);
  setTransactionRunner(async (fn) => fn(client as unknown as Tx));
  return statements;
}

afterEach(() => setSqlClient(async () => (await import("../../lib/db.ts")).db));

describe("planGuestCartMerge", () => {
  it("has nothing to merge without a guid, a guest cart or live lines", async () => {
    fakeDatabase({ guests: [], targets: [], lines: {} });
    expect(await planGuestCartMerge(undefined, USER)).toBeNull();
    expect(await planGuestCartMerge("guid", USER)).toBeNull();
    fakeDatabase({ guests: [cart({})], targets: [], lines: { "1": [] } });
    expect(await planGuestCartMerge("guid", USER)).toBeNull();
  });

  it("hands back two guest carts for one browser and two alive carts for one user", async () => {
    fakeDatabase({ guests: [cart({ id: 1n }), cart({ id: 2n })], targets: [], lines: {} });
    await expect(planGuestCartMerge("guid", USER)).rejects.toThrow("more than one guest cart");
    fakeDatabase({ guests: [cart({})], targets: [cart({ id: 2n }), cart({ id: 3n })], lines: { "1": [line({})] } });
    await expect(planGuestCartMerge("guid", USER)).rejects.toThrow("more than one alive cart");
  });

  it("hands back discount codes the cart schema rejects and lines CartProduct would refuse", async () => {
    fakeDatabase({ guests: [cart({ discount_codes: [{ code: "A" }] })], targets: [], lines: { "1": [line({})] } });
    await expect(planGuestCartMerge("guid", USER)).rejects.toThrow("discount codes");
    fakeDatabase({ guests: [cart({})], targets: [cart({ id: 2n })], lines: { "1": [line({ referrer: " " })], "2": [] } });
    await expect(planGuestCartMerge("guid", USER)).rejects.toThrow("CartProduct validations");
    fakeDatabase({
      guests: [cart({})],
      targets: [cart({ id: 2n })],
      lines: { "1": [line({ url_parameters: { utm: 1 } })], "2": [] },
    });
    await expect(planGuestCartMerge("guid", USER)).rejects.toThrow("CartProduct validations");
  });

  it("hands back a line of a product the target cart holds with another option (unique index)", async () => {
    fakeDatabase({
      guests: [cart({})],
      targets: [cart({ id: 2n })],
      lines: { "1": [line({ option_id: 5n })], "2": [line({ id: 20n, option_id: 6n })] },
    });
    await expect(planGuestCartMerge("guid", USER)).rejects.toThrow("collides");
  });

  it("skips lines the target already holds and appends only unseen discount codes", async () => {
    fakeDatabase({
      guests: [cart({ discount_codes: [{ code: "A", fromUrl: true }, { code: "B", fromUrl: false }] })],
      targets: [cart({ id: 2n, discount_codes: [{ code: "B", fromUrl: false }] })],
      lines: {
        "1": [line({ id: 10n }), line({ id: 11n, product_id: 101n })],
        "2": [line({ id: 20n, product_id: 100n })],
      },
    });
    const plan = await planGuestCartMerge("guid", USER);
    expect(plan?.copiedLineIds).toEqual([11n]);
    expect(plan?.discountCodes.map((code) => code.code)).toEqual(["B", "A"]);
  });
});

describe("mergeGuestCart", () => {
  it("gives the guest cart to a user without one in a single update", async () => {
    const statements = fakeDatabase({ guests: [cart({})], targets: [], lines: { "1": [line({})] } });
    const plan = await planGuestCartMerge("guid", USER);
    await mergeGuestCart(plan!, NOW);
    expect(statements).toEqual(["UPDATE `carts` SET"]);
  });

  it("copies lines, then saves the target cart, then deletes the guest cart", async () => {
    const statements = fakeDatabase({
      guests: [cart({})],
      targets: [cart({ id: 2n, user_id: 7n })],
      lines: { "1": [line({})], "2": [] },
    });
    const plan = await planGuestCartMerge("guid", USER);
    await mergeGuestCart(plan!, NOW);
    expect(statements).toEqual(["INSERT INTO `cart_products`", "UPDATE `carts` SET", "UPDATE `carts` SET"]);
  });
});
