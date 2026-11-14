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

  it("names the price and the email of the gifter's purchase on a gift receiver purchase", async () => {
    database({
      links: [link],
      users: [seller],
      gifts: [{ id: 1n, giftee_purchase_id: 3n, gifter_purchase_id: 2n, gifter_email: "named@example.com" }],
      purchases: [{ id: 2n, price_cents: 700, email: "gifter@example.com" }],
    });

    const json = await licensePurchaseJson({ ...purchase, flags: FLAGS.is_gift_receiver_purchase }, license);

    expect(json).toMatchObject({
      is_gift_receiver_purchase: true,
      gift_price: 700,
      gifter_email: "gifter@example.com",
    });
  });

  it("hands back a gift receiver purchase whose gift row is gone", async () => {
    database({ links: [link], users: [seller] });

    await expect(licensePurchaseJson({ ...purchase, flags: FLAGS.is_gift_receiver_purchase }, license)).rejects.toThrow(
      /without a gift row/u,
    );
  });

  it("flags a preorder authorization and leaves the key off the charge of a preorder", async () => {
    database({ links: [link], users: [seller] });

    expect(await licensePurchaseJson({ ...purchase, flags: FLAGS.is_preorder_authorization }, license)).toMatchObject({
      is_preorder_authorization: true,
    });
    expect(await licensePurchaseJson({ ...purchase, preorder_id: 6n }, license)).not.toHaveProperty(
      "is_preorder_authorization",
    );
  });

  it("serializes the offer code as the buyer got it, over the row's current amount", async () => {
    database({
      links: [link],
      users: [seller],
      offer_codes: [{ id: 4n, code: "SAVE10", amount_cents: 100, amount_percentage: null }],
      purchase_offer_code_discounts: [
        { purchase_id: 3n, offer_code_id: 4n, offer_code_amount: 25, offer_code_is_percent: true },
      ],
    });

    const json = await licensePurchaseJson({ ...purchase, offer_code_id: 4n }, license);

    expect(json).toMatchObject({
      offer_code: { code: "SAVE10", displayed_amount_off: "25%", name: "SAVE10" },
    });
  });

  it("formats a fixed offer code with the currency symbol", async () => {
    database({
      links: [link],
      users: [seller],
      offer_codes: [{ id: 4n, code: "SAVE", amount_cents: 1050, amount_percentage: null }],
    });

    const json = await licensePurchaseJson({ ...purchase, offer_code_id: 4n }, license);

    expect(json.offer_code).toEqual({ code: "SAVE", displayed_amount_off: "$10.50", name: "SAVE" });
  });

  it("serializes one variant as the tier name and a map of its category", async () => {
    database({
      links: [link],
      users: [seller],
      base_variants_purchases: [{ purchase_id: 3n, base_variant_id: 8n }],
      base_variants: [{ id: 8n, type: "Variant", variant_category_id: 2n, name: "Gold", flags: 0 }],
      variant_categories: [{ id: 2n, title: "Edition" }],
    });

    expect(await licensePurchaseJson(purchase, license)).toMatchObject({ variants: "(Gold)" });
  });

  it("hands back a purchase with several variants", async () => {
    database({
      links: [link],
      users: [seller],
      base_variants_purchases: [
        { purchase_id: 3n, base_variant_id: 8n },
        { purchase_id: 3n, base_variant_id: 9n },
      ],
    });

    await expect(licensePurchaseJson(purchase, license)).rejects.toThrow(/several variants/u);
  });

  it("names a SKU in the variants string and leaves sku_id to a SKU-enabled product", async () => {
    database({
      links: [link],
      users: [seller],
      base_variants_purchases: [{ purchase_id: 3n, base_variant_id: 8n }],
      base_variants: [{ id: 8n, type: "Sku", variant_category_id: null, name: "Large", flags: 0 }],
    });

    const json = await licensePurchaseJson(purchase, license);

    expect(json).toMatchObject({ variants: "(Large)" });
    expect(json).not.toHaveProperty("sku_id");
  });

  it("lists the custom fields as ping keys and as name and value strings", async () => {
    database({
      links: [link],
      users: [seller],
      purchase_custom_fields: [
        { id: 1n, purchase_id: 3n, field_type: "text", name: "Company", value: "Example Inc" },
        { id: 2n, purchase_id: 3n, field_type: "checkbox", name: "Newsletter", value: "1" },
      ],
    });

    const json = await licensePurchaseJson(purchase, license);

    expect(json).toMatchObject({
      Company: "Example Inc",
      Newsletter: true,
      custom_fields: ["Company: Example Inc", "Newsletter: true"],
    });
  });

  it("serializes a custom field whose name is a number", async () => {
    database({
      links: [link],
      users: [seller],
      purchase_custom_fields: [{ id: 1n, purchase_id: 3n, field_type: "text", name: "42", value: "answer" }],
    });

    expect(await licensePurchaseJson(purchase, license)).toMatchObject({
      "42": "answer",
      custom_fields: ["42: answer"],
    });
  });

  it("serializes a file custom field by its stored value", async () => {
    database({
      links: [link],
      users: [seller],
      purchase_custom_fields: [{ id: 1n, purchase_id: 3n, field_type: "file", name: "Upload", value: null }],
    });

    expect(await licensePurchaseJson(purchase, license)).toMatchObject({
      Upload: "",
      custom_fields: ["Upload: "],
    });
  });

  it("flags the purchase of a subscription that is not its original as a recurring charge", async () => {
    database({
      links: [link],
      users: [seller],
      subscriptions: [{ id: 2n, flags: 0, last_payment_option_id: null }],
      payment_options: [{ id: 8n, subscription_id: 2n, price_id: 9n, deleted_at: null }],
      prices: [{ id: 9n, recurrence: "monthly" }],
    });

    const json = await licensePurchaseJson({ ...purchase, subscription_id: 2n }, license);

    expect(json).toMatchObject({ is_recurring_charge: true, recurrence: "monthly" });
    expect(Object.keys(json).indexOf("is_recurring_charge")).toBeGreaterThan(
      Object.keys(json).indexOf("subscription_id"),
    );
  });

  it("keeps custom_fields at its place in the payload when only the original purchase has fields", async () => {
    const rows: Rows = {
      links: [link],
      users: [seller],
      subscriptions: [{ id: 2n, flags: 0, last_payment_option_id: null }],
      payment_options: [{ id: 8n, subscription_id: 2n, price_id: 9n, deleted_at: null }],
      prices: [{ id: 9n, recurrence: "monthly" }],
      purchases: [{ id: 1n, subscription_id: 2n, flags: 0 }],
    };
    setSqlClient(() => ({
      $queryRaw: (async (query: { sql: string; values: unknown[] }) => {
        const table = /FROM `(\w+)`/u.exec(query.sql)?.[1] ?? "";
        if (table === "purchase_custom_fields")
          return query.values.includes(1n)
            ? [{ id: 1n, purchase_id: 1n, field_type: "text", name: "Company", value: "A" }]
            : [];
        return rows[table] ?? [];
      }) as never,
      $executeRaw: (async () => 0) as never,
    }));

    const json = await licensePurchaseJson({ ...purchase, subscription_id: 2n }, license);

    expect(json.custom_fields).toEqual([]);
    expect(json).not.toHaveProperty("Company");
    expect(Object.keys(json).indexOf("custom_fields")).toBeLessThan(Object.keys(json).indexOf("recurrence"));
  });

  it("names the affiliate and the credit it earned", async () => {
    database({
      links: [link],
      users: [{ id: 11n, email: "collab@example.com", unconfirmed_email: null }, seller],
      affiliates: [{ id: 7n, type: "DirectAffiliate", affiliate_user_id: 11n }],
      affiliate_credits: [{ id: 1n, purchase_id: 3n }],
    });

    const json = await licensePurchaseJson({ ...purchase, affiliate_id: 7n, affiliate_credit_cents: 100 }, license);

    expect(json).toMatchObject({ affiliate: "collab@example.com", affiliate_credit_amount_cents: 100 });
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

  it("lets a verification without a token through", async () => {
    const request = new Request("http://example.com/v2/licenses/verify", {
      method: "POST",
      headers: { "user-agent": "gumroad-cli/1.2.3" },
    });

    await expect(verify.preAuth!({ request, params: {} } as never)).resolves.toBeUndefined();
  });

  it("hands back a verification whose token parameter is not text", async () => {
    const request = new Request("http://example.com/v2/licenses/verify", { method: "POST" });

    await expect(verify.preAuth!({ request, params: { access_token: { a: "b" } } } as never)).rejects.toThrow(
      HandBackToRails,
    );
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
