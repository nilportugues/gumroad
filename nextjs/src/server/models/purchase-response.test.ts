// purchase_response against the line item Rails answered for each served shape of the free checkout recording
// (spec/requests/orders_free_purchase_parity_spec.rb). The inputs are the rows the recording seeded and inserted.
import { readdirSync } from "node:fs";

import { Prisma, type Link, type Purchase, type UrlRedirect, type User } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  lastExchange,
  RECORDED_NOW,
  type RecordedExchange,
  type RecordedRow,
} from "./__fixtures__/free-purchase-recording.ts";
import { INTEGRATION_NAMES, purchaseResponse, type PurchaseResponseFacts } from "./purchase-response.ts";

const saved = { ...process.env };
beforeAll(() => {
  // The recording ran with config/test's keys; the numeric key is unset there and `nil.to_i` is 0.
  process.env.OBFUSCATE_IDS_CIPHER_KEY = "test-cipher-key";
  process.env.OBFUSCATE_IDS_NUMERIC_CIPHER_KEY = "0";
  process.env.RAILS_ENV = "test";
  process.env.DEV_LANE_PORT = "31337";
});
afterAll(() => {
  process.env = saved;
});

// A recorded row as Prisma returns it: BigInt and DateTime columns converted, "<now>" stamped.
function prismaRow(model: Prisma.ModelName, row: RecordedRow) {
  const fields = Prisma.dmmf.datamodel.models.find((m) => m.name === model)!.fields;
  const out: Record<string, unknown> = {};
  for (const field of fields.filter((f) => f.kind === "scalar")) {
    const value = row[field.name];
    if (value === undefined) continue;
    if (value === null) out[field.name] = null;
    else if (field.type === "BigInt") out[field.name] = BigInt(value as number);
    else if (field.type === "DateTime") out[field.name] = value === "<now>" ? RECORDED_NOW : new Date(value as string);
    else out[field.name] = value;
  }
  return out;
}

const fixtures = readdirSync(
  new URL("../../../parity/fixtures/requests/orders_free_purchase_parity_spec/", import.meta.url),
)
  .filter((file) => file.endsWith(".json") && !file.startsWith("orders-free-purchase-hands"))
  .map((file) => file.replace(/\.json$/u, ""));

function factsFor(exchange: RecordedExchange): PurchaseResponseFacts {
  const seed = exchange.seed as { tables: Record<string, { rows: RecordedRow[] }> };
  const purchase = (prismaRow as (m: Prisma.ModelName, r: RecordedRow) => Purchase)(
    "Purchase",
    exchange.db.purchases!.inserted![0]!,
  );
  const link = (prismaRow as (m: Prisma.ModelName, r: RecordedRow) => Link)(
    "Link",
    seed.tables.links!.rows.find((row) => Number(row.id) === Number(purchase.link_id))!,
  );
  const users = seed.tables.users!.rows.map((row) =>
    (prismaRow as (m: Prisma.ModelName, r: RecordedRow) => User)("User", row),
  );
  const redirect = exchange.db.url_redirects?.inserted?.[0];
  const parameters = exchange.db.purchase_url_parameters?.inserted?.[0];
  return {
    purchase,
    link,
    seller: users.find((user) => user.id === link.user_id)!,
    purchaser: users.find((user) => user.id === purchase.purchaser_id) ?? null,
    urlRedirect: redirect
      ? (prismaRow as (m: Prisma.ModelName, r: RecordedRow) => UrlRedirect)("UrlRedirect", redirect)
      : null,
    hasFiles: (seed.tables.product_files?.rows.length ?? 0) > 0,
    hasStampablePdfs: false,
    isFollowing: false,
    hasThirdPartyAnalytics: false,
    enabledIntegrations: Object.fromEntries(
      INTEGRATION_NAMES.map((name) => [name, false]),
    ) as PurchaseResponseFacts["enabledIntegrations"],
    urlParameters: parameters ? (JSON.parse(parameters.params as string) as Record<string, unknown>) : null,
  };
}

// The recorder masks a stamped time as "<now>".
const unmask = (value: unknown): unknown =>
  value instanceof Date || (typeof value === "string" && value === RECORDED_NOW.toISOString()) ? "<now>" : value;
const masked = (object: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(object).map(([key, value]) => [key, unmask(value)]));

describe("Purchase#purchase_response of a free checkout", () => {
  it("covers the 13 served shapes", () => {
    expect(fixtures).toHaveLength(13);
  });

  for (const name of fixtures) {
    it(`renders the recorded line item: ${name.replace("orders-free-purchase-", "").replaceAll("-", " ")}`, () => {
      const exchange = lastExchange(name);
      const [expected] = Object.values(
        (exchange.response.json as { line_items: Record<string, Record<string, unknown>> }).line_items,
      );
      expect(masked(purchaseResponse(factsFor(exchange)))).toEqual(expected);
    });
  }
});

describe("purchase_response refuses what it cannot render", () => {
  it.each([
    [
      "a priced purchase",
      (facts: PurchaseResponseFacts) => ({ ...facts, purchase: { ...facts.purchase, price_cents: 100 } }),
    ],
    [
      "a purchase limit",
      (facts: PurchaseResponseFacts) => ({ ...facts, link: { ...facts.link, max_purchase_count: 5 } }),
    ],
    [
      "an affiliate sale",
      (facts: PurchaseResponseFacts) => ({ ...facts, purchase: { ...facts.purchase, affiliate_id: 9n } }),
    ],
    ["a purchase without a url redirect", (facts: PurchaseResponseFacts) => ({ ...facts, urlRedirect: null })],
  ])("refuses %s", (_label, change) => {
    const facts = factsFor(lastExchange(fixtures[0]));
    expect(() => purchaseResponse(change(facts))).toThrow("not ported");
  });
});
