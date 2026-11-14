// The order of the statements inside a version's save, against the `timeline` Rails recorded for the same request
// (parity/fixtures/requests/api/v2/variants_writes_parity_spec): the replay proves the row diffs, the response and the jobs, and this pins
// what a diff cannot show.
import { readFileSync } from "node:fs";

import type { BaseVariant } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The search index update is an HTTP request in Rails' timeline; it is recorded among the writes, where it ran.
const current: { writes: { model: string; op: string; id: unknown }[] } = { writes: [] };
vi.mock("../search/product-indexing.ts", () => ({
  enqueueIndexUpdatesFor: async (_ids: unknown, fields: string[]) =>
    void current.writes.push({ model: "http", op: "update", id: fields.join(",") }),
}));

const { resetLinkCollaborators, setLinkCollaborators } = await import("./link.ts");
const { setSqlClient } = await import("./sql.ts");
const { setTransactionRunner } = await import("./runtime/transaction.ts");
const { fakeDatabase } = await import("./runtime/testing.ts");
const { buildVariant, loadVariantRecord, Variants } = await import("./variant-writes.ts");

const FIXTURES = new URL("../../../parity/fixtures/requests/api/v2/variants_writes_parity_spec/", import.meta.url);
type TimelineEvent = { type: string; op?: string; table?: string };
const railsOrder = (name: string): string[] => {
  const fixture = JSON.parse(readFileSync(new URL(`${name}.json`, FIXTURES), "utf8")) as {
    exchanges: { timeline: TimelineEvent[]; http?: { body: string }[] }[];
  };
  const exchange = fixture.exchanges.at(-1)!;
  return exchange.timeline.map((event) =>
    event.type === "db"
      ? `${event.op} ${event.table}`
      : `http update ${Object.keys(JSON.parse(exchange.http![0]!.body).doc).join(",")}`,
  );
};

const TABLES: Record<string, string> = { baseVariant: "base_variants", link: "links", version: "versions" };
const OPS: Record<string, string> = { create: "insert", update: "update", delete: "delete" };

const LINK = { id: 5n, flags: 0n, user_id: 1n, name: "Book", price_currency_type: "usd" };
const answer = (sql: string, positions: { last: number | null; count: number }) => {
  if (sql.includes("FROM `variant_categories`")) return [{ link_id: 5 }];
  if (sql.includes("FROM `links`")) return [LINK];
  if (sql.includes("COUNT(*)")) return [{ total: positions.count }];
  if (sql.includes("ORDER BY `base_variants`.`position_in_category` DESC"))
    return positions.last === null ? [] : [{ position_in_category: positions.last }];
  if (sql.includes("AS sales")) return [{ sales: 0 }];
  return [];
};

const variantRow = (overrides: Partial<BaseVariant> = {}): BaseVariant =>
  ({
    id: 1,
    variant_category_id: 3,
    price_difference_cents: 0,
    name: "Small",
    max_purchase_count: null,
    deleted_at: null,
    created_at: new Date(0),
    updated_at: new Date(0),
    type: "Variant",
    link_id: null,
    custom_sku: null,
    flags: 0,
    description: null,
    position_in_category: 0,
    customizable_price: null,
    subscription_price_change_effective_date: null,
    subscription_price_change_message: null,
    duration_in_minutes: null,
    sales_count_for_inventory_cache: 0,
    ...overrides,
  }) as BaseVariant;

describe("Variant save order", () => {
  let positions = { last: null as number | null, count: 0 };
  let database: ReturnType<typeof fakeDatabase>;

  beforeEach(() => {
    positions = { last: null, count: 0 };
    database = fakeDatabase();
    current.writes = database.writes;
    const tx = new Proxy(database.tx, {
      get: (target, prop: string) =>
        prop === "$queryRaw" ? async (query: { sql: string }) => answer(query.sql, positions) : target[prop as never],
    });
    setTransactionRunner(async (fn) => fn(tx as never));
    setSqlClient(
      () =>
        ({
          $queryRaw: async (query: { sql: string }) => answer(query.sql, positions),
          $executeRaw: async () => 0,
        }) as never,
    );
    setLinkCollaborators({ cacheDelete: async () => undefined, isFeatureEnabled: async () => false });
  });
  afterEach(() => resetLinkCollaborators());

  // The statements the save sent, in order, with the search index update where it ran among them.
  const order = () =>
    database.writes
      .filter((write) => write.model !== "version")
      .map((write) =>
        write.model === "http"
          ? `http update ${String(write.id)}`
          : `${OPS[write.op]} ${TABLES[write.model] ?? write.model}`,
      );

  it("inserts the version, updates the index, then touches the product when the price is set", async () => {
    positions = { last: 0, count: 1 };
    const record = buildVariant({ variant_category_id: 3, name: "Large", price_difference_cents: 250 });
    await Variants.save(record);

    expect(order()).toEqual(
      railsOrder("api-v2-version-writes-post-create-creates-a-version-with-a-price-a-description-and-a-limit"),
    );
    expect(record.get("position_in_category")).toBe(1);
  });

  it("inserts the version and touches the product when no price is set", async () => {
    await Variants.save(buildVariant({ variant_category_id: 3, name: "Red" }));

    expect(order()).toEqual(
      railsOrder("api-v2-version-writes-post-create-creates-the-first-version-of-an-empty-category"),
    );
  });

  it("updates the version and touches the product on a rename", async () => {
    const record = loadVariantRecord(variantRow());
    record.assign({ name: "Large" });
    await Variants.save(record);

    expect(order()).toEqual(railsOrder("api-v2-version-writes-put-update-updates-the-name-of-a-version"));
  });

  it("writes nothing when the request changes nothing", async () => {
    const record = loadVariantRecord(variantRow());
    record.assign({ name: "Small" });
    await Variants.save(record);

    expect(order()).toEqual(
      railsOrder("api-v2-version-writes-put-update-keeps-a-version-whose-request-changes-nothing"),
    );
  });

  it("soft-deletes the version without validations and touches the product", async () => {
    const record = loadVariantRecord(variantRow());
    record.set("deleted_at", new Date(1000));
    await Variants.save(record, { validate: false });

    // The deletion audit is written after the save's commit; the timeline lists it last.
    expect([...order(), "insert product_variant_deletion_audits"]).toEqual(
      railsOrder("api-v2-version-writes-delete-destroy-deletes-a-live-version-and-records-the-deletion"),
    );
  });

  it("refuses a blank name, a negative price and a limit below the sales without writing", async () => {
    const blank = buildVariant({ variant_category_id: 3, name: "  " });
    expect(await Variants.save(blank)).toBe(false);
    expect(blank.errors.fullMessages()).toEqual(["Name can't be blank"]);

    const negative = buildVariant({ variant_category_id: 3, name: "x", price_difference_cents: -1 });
    expect(await Variants.save(negative)).toBe(false);
    expect(negative.errors.fullMessages()).toEqual([
      "Please enter a price that is equal to or greater than the price of the product.",
    ]);

    const limited = loadVariantRecord(variantRow({ sales_count_for_inventory_cache: 0 }));
    limited.assign({ max_purchase_count: 99_999_999 });
    expect(await Variants.save(limited)).toBe(true);
    expect(limited.get("max_purchase_count")).toBe(10_000_000);
    expect(database.writes.filter((write) => write.model === "baseVariant")).toHaveLength(1);
  });
});
