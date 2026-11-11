import { afterEach, describe, expect, it } from "vitest";

process.env.OBFUSCATE_IDS_CIPHER_KEY ??= "ws17l-test-obfuscate-key";
process.env.OBFUSCATE_IDS_NUMERIC_CIPHER_KEY ??= "123456789";

const { setSqlClient } = await import("../../models/sql.ts");
const { licensePurchaseJson } = await import("../../models/license-purchase-json.ts");
const { HandBackToRails } = await import("../application-controller.ts");
const { registeredApiV2Routes } = await import("./base.ts");
await import("./licenses.ts");

type Rows = Record<string, Record<string, unknown>[]>;

// Answers each statement from the rows of the table it reads (the first `FROM` in the text).
function database(rows: Rows) {
  setSqlClient(() => ({
    $queryRaw: (async (query: { sql: string }) => {
      const table = /FROM `(\w+)`/u.exec(query.sql)?.[1] ?? "";
      if (query.sql.includes("COUNT(*)")) return [{ total: 0n }];
      return rows[table] ?? [];
    }) as never,
    $executeRaw: (async () => 0) as never,
  }));
}

const FLAGS = { is_gift_receiver_purchase: 32, is_preorder_authorization: 8 } as const;
const LICENSED = 64;
const link = {
  id: 5n,
  user_id: 9n,
  name: "Licensed",
  unique_permalink: "abc",
  custom_permalink: null,
  price_currency_type: "usd",
  flags: 0,
};
const seller = { id: 9n, username: "seller", external_id: "9" };
const purchase = {
  id: 3n,
  link_id: 5n,
  seller_id: 9n,
  email: "buyer@example.com",
  quantity: 1,
  flags: 0,
  created_at: new Date("2026-01-01T00:00:00Z"),
};
const license = { id: 1n, purchase_id: 3n, serial: "AAAAAAAA-BBBBBBBB-CCCCCCCC-DDDDDDDD" };

afterEach(() => setSqlClient(async () => (await import("../../../lib/db.ts")).db));

describe("licensePurchaseJson", () => {
  it("serializes a plain purchase with the ping payload first and the whitelisted purchase keys after", async () => {
    database({ links: [{ ...link, flags: LICENSED }], users: [seller], licenses: [license] });

    const json = await licensePurchaseJson(purchase, license);

    expect(Object.keys(json).slice(-5)).toEqual(["id", "created_at", "variants", "custom_fields", "chargebacked"]);
    expect(json).toMatchObject({
      product_name: "Licensed",
      short_product_id: "abc",
      license_key: license.serial,
      refunded: false,
      chargebacked: false,
      variants: "",
      custom_fields: [],
    });
  });

  it("drops the license key of a product that is not licensed", async () => {
    database({ links: [link], users: [seller], licenses: [license] });

    expect(await licensePurchaseJson(purchase, license)).not.toHaveProperty("license_key");
  });

  it("hands back a gift receiver purchase", async () => {
    database({ links: [link], users: [seller] });

    await expect(licensePurchaseJson({ ...purchase, flags: FLAGS.is_gift_receiver_purchase }, license)).rejects.toThrow(
      /gift/u,
    );
  });

  it("hands back a preorder authorization", async () => {
    database({ links: [link], users: [seller] });

    await expect(licensePurchaseJson({ ...purchase, flags: FLAGS.is_preorder_authorization }, license)).rejects.toThrow(
      /preorder/u,
    );
  });

  it("hands back a purchase with an offer code", async () => {
    database({ links: [link], users: [seller] });

    await expect(licensePurchaseJson({ ...purchase, offer_code_id: 4n }, license)).rejects.toThrow(/offer code/u);
  });

  it("hands back a purchase with variants", async () => {
    database({ links: [link], users: [seller], base_variants_purchases: [{ purchase_id: 3n }] });

    await expect(licensePurchaseJson(purchase, license)).rejects.toThrow(/variants/u);
  });

  it("hands back a purchase of a subscription that is a recurring charge", async () => {
    database({ links: [link], users: [seller], subscriptions: [{ id: 2n, flags: 0 }] });

    await expect(licensePurchaseJson({ ...purchase, subscription_id: 2n }, license)).rejects.toThrow(
      /recurring charge/u,
    );
  });

  it("hands back a purchase whose license is another row", async () => {
    database({ links: [{ ...link, flags: LICENSED }], users: [seller], licenses: [{ ...license, id: 2n }] });

    await expect(licensePurchaseJson(purchase, license)).rejects.toThrow(/another license/u);
  });
});

describe("Api::V2::LicensesController#verify parameters", () => {
  const verify = registeredApiV2Routes().find((route) => route.pattern === "/v2/licenses/verify")!;
  const call = (params: Record<string, unknown>) => ({ params, routeParams: {}, state: {} }) as never;
  const body = (rendered: unknown) =>
    JSON.parse(String((rendered as { body: string }).body)) as Record<string, unknown>;

  it("answers 400 for a parameter that is not a string", async () => {
    for (const key of ["license_key", "product_id", "product_permalink", "id", "link_id"]) {
      const rendered = (await verify.before!(call({ [key]: ["x"] }))) as { status: number };

      expect(rendered.status).toBe(400);
      expect(body(rendered)).toEqual({ success: false, message: `The '${key}' parameter must be a string.` });
    }
  });

  it("hands back an empty list or hash, which Rails reads as blank", async () => {
    await expect(verify.before!(call({ license_key: [] }))).rejects.toThrow(HandBackToRails);
    await expect(verify.before!(call({ license_key: "x", product_id: {} }))).rejects.toThrow(HandBackToRails);
  });

  it("hands back a verification that carries a token", () => {
    const request = new Request("http://example.com/v2/licenses/verify", {
      method: "POST",
      headers: { authorization: "Bearer t" },
    });

    expect(() => verify.preAuth!({ request, params: {} } as never)).toThrow(HandBackToRails);
  });
});

describe("Api::V2::LicensesController writes", () => {
  it("authorizes the edit_products scope and keeps verify anonymous", () => {
    const routes = registeredApiV2Routes().filter((route) => route.pattern.startsWith("/v2/licenses/"));

    expect(routes.map((route) => [route.method, route.pattern, route.scopes, route.anonymous ?? false])).toEqual([
      ["POST", "/v2/licenses/verify", [], true],
      ["PUT", "/v2/licenses/enable", ["edit_products"], false],
      ["PUT", "/v2/licenses/disable", ["edit_products"], false],
      ["PUT", "/v2/licenses/decrement_uses_count", ["edit_products"], false],
      ["PUT", "/v2/licenses/rotate", ["edit_products"], false],
    ]);
  });

  it("hands back a license key that is not text", async () => {
    const enable = registeredApiV2Routes().find((route) => route.pattern === "/v2/licenses/enable")!;

    await expect(
      enable.before!({ params: { license_key: ["x"] }, routeParams: {}, state: {} } as never),
    ).rejects.toThrow(HandBackToRails);
  });
});
