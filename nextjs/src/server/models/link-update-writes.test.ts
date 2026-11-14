// The order of the statements, jobs and search requests of the tag and price saves of Api::V2::LinksController#update, against the
// `timeline` Rails recorded for the same requests (parity/fixtures/requests/api/v2/products_throttled_parity_spec): the replay proves the
// row diffs, the response and the jobs, and this pins what a diff cannot show (the tag counter rows are taken in tag id order).
import { readFileSync } from "node:fs";

import type { Link } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const current: { writes: { model: string; op: string; id: unknown }[] } = { writes: [] };
// enqueueIndexUpdatesFor defers its request to the commit, as `enqueue_index_update_for` does.
vi.mock("../search/product-indexing.ts", async () => {
  const { afterCommitEverywhere } = await import("./concerns/job-runtime.ts");
  return {
    enqueueIndexUpdatesFor: (_ids: unknown, fields: string[]) =>
      afterCommitEverywhere(
        async () => void current.writes.push({ model: "http", op: "update", id: fields.join(",") }),
      ),
  };
});
vi.mock("../infra/flipper.ts", () => ({
  isFeatureEnabled: async () => false,
  userActor: (id: unknown) => `User;${String(id)}`,
}));

const { resetLinkCollaborators, setLinkCollaborators } = await import("./link.ts");
const { setSqlClient } = await import("./sql.ts");
const { setTransactionRunner, transaction } = await import("./runtime/transaction.ts");
const { fakeDatabase } = await import("./runtime/testing.ts");
const { planTagChanges, saveTags } = await import("./product-tags.ts");
const { planBuyPriceWrite, writeBuyPrice } = await import("./price-writes.ts");

const FIXTURES = new URL("../../../parity/fixtures/requests/api/v2/products_throttled_parity_spec/", import.meta.url);
type TimelineEvent = { type: string; op?: string; table?: string; index?: number };
type Exchange = { timeline: TimelineEvent[]; jobs: { class: string }[]; http: { body: string }[] };
const railsOrder = (name: string): string[] => {
  const file = `api-v2-throttled-routes-put-and-patch-v2-products-id-the-attributes-node-writes-${name}.json`;
  const exchange = (
    JSON.parse(readFileSync(new URL(file, FIXTURES), "utf8")) as { exchanges: Exchange[] }
  ).exchanges.at(-1)!;
  return exchange.timeline.flatMap((event) => {
    if (event.type === "db") return [`${event.op} ${event.table}`];
    if (event.type === "job") return [`job ${exchange.jobs[event.index!]!.class}`];
    const body = JSON.parse(exchange.http[event.index!]!.body) as { doc?: Record<string, unknown> };
    return body.doc ? [`http update ${Object.keys(body.doc).join(",")}`] : [];
  });
};

const OPS: Record<string, string> = { create: "insert", update: "update", delete: "delete" };
const TABLES: Record<string, string> = {
  link: "links",
  tag: "tags",
  productTagging: "product_taggings",
  basePrice: "prices",
  version: "versions",
};

type Answer = (sql: string, values: unknown[]) => unknown[];

describe("tag and price saves of the v2 product update", () => {
  let database: ReturnType<typeof fakeDatabase>;
  let answers: Answer;

  beforeEach(() => {
    database = fakeDatabase();
    current.writes = database.writes;
    answers = () => [];
    const client = {
      $queryRaw: async (query: { sql: string; values: unknown[] }) => answers(query.sql, query.values),
      // The relative counter update of counter_cache and the update_column of set_customizable_price.
      $executeRaw: async (query: { sql: string }) => {
        const written = /^UPDATE `(\w+)`/u.exec(query.sql)?.[1];
        if (written) database.writes.push({ model: written, op: "update", id: null });
        return 1;
      },
    };
    const tx = new Proxy(database.tx, {
      get: (target, prop: string) => (prop in client ? client[prop as keyof typeof client] : target[prop as never]),
    });
    setTransactionRunner(async (fn) => fn(tx as never));
    setSqlClient(() => client as never);
    setLinkCollaborators({ cacheDelete: async () => undefined, isFeatureEnabled: async () => false });
  });
  afterEach(() => resetLinkCollaborators());

  const order = () =>
    database.writes
      .filter((write) => write.model !== "version")
      .map((write) =>
        write.model === "http"
          ? `http update ${String(write.id)}`
          : `${OPS[write.op]} ${TABLES[write.model] ?? write.model}`,
      );

  // Tags by name: mango (1) and apple (2) exist; the product holds apple and zebra (3).
  const tagIds: Record<string, number> = { mango: 1, apple: 2, zebra: 3 };
  const tagAnswers: Answer = (sql, values) => {
    if (sql.includes("FROM `links`")) return [{ one: 1 }];
    if (sql.includes("INNER JOIN `product_taggings`")) return [{ name: "apple" }, { name: "zebra" }];
    if (sql.includes("FROM `product_taggings`") && sql.includes("ORDER BY"))
      return [{ id: 9, tag_id: tagIds.apple, product_id: 1, created_at: new Date(0), updated_at: new Date(0) }];
    if (sql.includes("FROM `tags` WHERE `tags`.`name` =") && !sql.includes("BINARY")) {
      const name = String(values[0]);
      return name in tagIds ? [{ id: tagIds[name], name }] : [];
    }
    return [];
  };

  it("takes the counter rows in tag id order, removals first", async () => {
    answers = tagAnswers;
    const work = await planTagChanges(1, ["zebra", "mango", "pear"]);
    expect(work.map((item) => `${item.action} ${item.name}`)).toEqual(["add mango", "remove apple", "add pear"]);

    await transaction(() => saveTags(1, work));

    expect(order()).toEqual(railsOrder("the-tags-takes-the-counter-rows-in-tag-i-ce5f3615"));
  });

  it("refuses names it cannot prove without reading further", async () => {
    answers = tagAnswers;
    await expect(planTagChanges(1, ["Mango", "mango"])).rejects.toThrow("two spellings");
    await expect(planTagChanges(1, ["two words"])).rejects.toThrow("printable ASCII without spaces");
    await expect(planTagChanges(1, ["#tag"])).rejects.toThrow("no recording holds");
    await expect(planTagChanges(1, ["a-very-long-tag-name-over-twenty"])).rejects.toThrow("no recording holds");
    expect(database.writes).toEqual([]);
  });

  it("hands back a name that matches a tag spelled differently", async () => {
    answers = (sql, values) =>
      sql.includes("FROM `tags` WHERE `tags`.`name` =") && values[0] === "cafe"
        ? [{ id: 4, name: "café" }]
        : tagAnswers(sql, values);
    await expect(planTagChanges(1, ["zebra", "cafe"])).rejects.toThrow("spelled differently");
  });

  const product = (overrides: Partial<Link> = {}) =>
    ({
      id: 1n,
      price_currency_type: "usd",
      native_type: "digital",
      purchase_type: 0,
      flags: 65_536n,
      ...overrides,
    }) as Link;
  const priceRow = {
    id: 1,
    link_id: 1,
    price_cents: 100,
    currency: "usd",
    recurrence: null,
    flags: 0,
    deleted_at: null,
    suggested_price_cents: null,
    created_at: new Date(0),
    updated_at: new Date(0),
  };

  it("updates the price row, then touches the product just before the commit and updates the search index", async () => {
    answers = (sql) =>
      sql.includes("FROM `prices`")
        ? [priceRow]
        : sql.includes("FROM `links`")
          ? [{ id: 1n, price_currency_type: "usd", updated_at: new Date(0), created_at: new Date(0) }]
          : [];

    await transaction(() => writeBuyPrice({ id: 1n, price_currency_type: "usd" }, 250));

    expect(order()).toEqual(railsOrder("the-price-changes-the-price-of-a-publish-4b86f5ef"));
  });

  it("saves nothing for the price the product already has", async () => {
    answers = (sql) =>
      sql.includes("FROM `prices`")
        ? [priceRow]
        : sql.includes("FROM `links`")
          ? [{ id: 1n, price_currency_type: "usd", updated_at: new Date(0), created_at: new Date(0) }]
          : [];

    await transaction(() => writeBuyPrice({ id: 1n, price_currency_type: "usd" }, 100));

    expect(order()).toEqual([]);
  });

  describe("planBuyPriceWrite", () => {
    beforeEach(() => {
      answers = (sql) => (sql.includes("FROM `prices`") ? [priceRow] : []);
    });

    it("reads a whole number of cents or a text of digits", async () => {
      expect(await planBuyPriceWrite(product(), 250)).toEqual({ cents: 250 });
      expect(await planBuyPriceWrite(product(), "450")).toEqual({ cents: 450 });
      expect(await planBuyPriceWrite(product(), 2_147_483_648)).toEqual({ tooLarge: true });
    });

    it.each([["3.50"], [""], [-5], [1.5], [null], ["1e3"], [["1"]]])("hands back %j", async (value) => {
      await expect(planBuyPriceWrite(product(), value)).rejects.toThrow("whole number of cents");
    });

    it("hands back products with another shape", async () => {
      await expect(planBuyPriceWrite(product({ price_currency_type: "eur" }), 300)).rejects.toThrow("USD");
      await expect(planBuyPriceWrite(product({ native_type: "coffee" }), 300)).rejects.toThrow("coffee");
      await expect(planBuyPriceWrite(product({ purchase_type: 1 }), 300)).rejects.toThrow("rented");
      answers = (sql) =>
        sql.includes("FROM `prices`") ? [priceRow, { ...priceRow, id: 2, recurrence: "monthly" }] : [];
      await expect(planBuyPriceWrite(product(), 300)).rejects.toThrow("single buy price");
    });
  });
});
