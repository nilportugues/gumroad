// The order of the statements, jobs and search requests of a publish, against the `timeline` Rails recorded for the same request
// (parity/fixtures/requests/api/v2/product_enable_parity_spec): the replay proves the row diffs, the response and the jobs, and this pins
// what a diff cannot show.
import { readFileSync } from "node:fs";

import type { Link, User } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The search request and the job are recorded among the writes, where they ran.
const current: { writes: { model: string; op: string; id: unknown }[] } = { writes: [] };
// enqueueIndexUpdatesFor defers its request to the commit, as `enqueue_index_update_for`'s after_commit block does.
vi.mock("../search/product-indexing.ts", async () => {
  const { afterCommitEverywhere } = await import("./concerns/job-runtime.ts");
  return {
    enqueueIndexUpdatesFor: (_ids: unknown, fields: string[]) =>
      afterCommitEverywhere(
        async () => void current.writes.push({ model: "http", op: "update", id: fields.join(",") }),
      ),
  };
});
vi.mock("./concerns/job-runtime.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./concerns/job-runtime.ts")>()),
  performAsync: async (jobClass: string) => void current.writes.push({ model: "job", op: "create", id: jobClass }),
}));
vi.mock("../infra/flipper.ts", () => ({
  isFeatureEnabled: async () => false,
  userActor: (id: unknown) => `User;${String(id)}`,
}));

const { resetLinkCollaborators, setLinkCollaborators } = await import("./link.ts");
const { setSqlClient } = await import("./sql.ts");
const { setTransactionRunner } = await import("./runtime/transaction.ts");
const { fakeDatabase } = await import("./runtime/testing.ts");
const {
  assertPlainPublish,
  publishBang,
  EMAIL_CONFIRMATION_MESSAGE,
  PAYMENT_METHOD_MESSAGE,
  UNPUBLISHED_BY_ADMIN_MESSAGE,
} = await import("./link-publish.ts");

const FIXTURES = new URL("../../../parity/fixtures/requests/api/v2/product_enable_parity_spec/", import.meta.url);
type TimelineEvent = { type: string; op?: string; table?: string; index?: number };
type Exchange = { timeline: TimelineEvent[]; jobs: { class: string }[]; http: { body: string }[] };
// The count of sales Rails asks Elasticsearch for before the first statement is not a write; the search update is.
const railsOrder = (name: string): string[] => {
  const exchange = (
    JSON.parse(readFileSync(new URL(`${name}.json`, FIXTURES), "utf8")) as { exchanges: Exchange[] }
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
  version: "versions",
  product_publish_schedule: "product_publish_schedules",
};
const link = (overrides: Partial<Link> = {}) =>
  ({
    id: 5n,
    user_id: 1n,
    name: "Pencil",
    unique_permalink: "pencil",
    filetype: "link",
    filegroup: "url",
    flags: 65_536n,
    draft: false,
    deleted_at: null,
    purchase_disabled_at: new Date(0),
    first_published_at: null,
    price_currency_type: "usd",
    native_type: "digital",
    discover_fee_per_thousand: 100,
    purchase_type: 0,
    created_at: new Date(0),
    updated_at: new Date(0),
    ...overrides,
  }) as Link;
const seller = {
  id: 1n,
  verified: false,
  confirmed_at: new Date(0),
  payment_address: "seller@example.com",
  tier_state: 0,
} as User;

// The rows the validations read: the seller, and the locked flags.
const baseAnswers = (sql: string, firstPublishedAt: Date | null): unknown[] => {
  if (sql.includes("FOR UPDATE") && sql.includes("`first_published_at`"))
    return [{ flags: 65_536n, first_published_at: firstPublishedAt }];
  if (sql.includes("FROM `prices`"))
    return [
      {
        id: 1n,
        link_id: 5n,
        price_cents: 100,
        currency: "usd",
        recurrence: null,
        flags: 0,
        deleted_at: null,
        created_at: new Date(0),
        updated_at: new Date(0),
      },
    ];
  if (sql.includes("FROM `users`")) return [{ ...seller, flags: 1n, email: "seller@example.com", username: "seller" }];
  return [];
};

describe("publishBang", () => {
  let database: ReturnType<typeof fakeDatabase>;
  let answers: (sql: string) => unknown[];

  beforeEach(() => {
    answers = (sql) => baseAnswers(sql, null);
    database = fakeDatabase();
    current.writes = database.writes;
    // Link#cancel_pending_publish_schedule: a delete_all, recorded where Rails' timeline has it
    const executeRaw = async (query: { sql: string }) => {
      if (query.sql.includes("DELETE FROM `product_publish_schedules`"))
        database.writes.push({ model: "product_publish_schedule", op: "delete", id: null });
      return 0;
    };
    const tx = new Proxy(database.tx, {
      get: (target, prop: string) =>
        prop === "$queryRaw"
          ? async (query: { sql: string }) => answers(query.sql)
          : prop === "$executeRaw"
            ? executeRaw
            : target[prop as never],
    });
    setTransactionRunner(async (fn) => fn(tx as never));
    setSqlClient(
      () => ({ $queryRaw: async (query: { sql: string }) => answers(query.sql), $executeRaw: executeRaw }) as never,
    );
    setLinkCollaborators({ cacheDelete: async () => undefined, isFeatureEnabled: async () => false });
  });
  afterEach(() => resetLinkCollaborators());

  const order = () =>
    database.writes
      .filter((write) => write.model !== "version")
      .map((write) =>
        write.model === "http"
          ? `http update ${String(write.id)}`
          : write.model === "job"
            ? `job ${String(write.id)}`
            : `${OPS[write.op]} ${TABLES[write.model] ?? write.model}`,
      );

  it("updates the product, queues the indexnow submission, then updates the search index when the product was disabled", async () => {
    expect(await publishBang(link(), seller)).toBeNull();

    expect(order()).toEqual(railsOrder("api-v2-product-enable-enables-a-product-that-was-disabled"));
  });

  it("updates the product and queues the submission for the first publication of a draft", async () => {
    expect(await publishBang(link({ draft: true, purchase_disabled_at: null }), seller)).toBeNull();

    expect(order()).toEqual(railsOrder("api-v2-product-enable-records-the-first-publication-of-a-draft"));
    const [write] = database.writes.filter((candidate) => candidate.model === "link");
    expect(write!.data).toMatchObject({ draft: false });
    expect(write!.data!.first_published_at).toBeInstanceOf(Date);
  });

  it("only sets the transcoding flag on a product that is already published", async () => {
    expect(await publishBang(link({ purchase_disabled_at: null }), seller)).toBeNull();

    expect(order()).toEqual(railsOrder("api-v2-product-enable-enables-a-product-that-is-already-published"));
    expect(database.writes.find((candidate) => candidate.model === "link")!.data).toMatchObject({ flags: 8_454_144n });
  });

  it("keeps the date of the first publication already recorded", async () => {
    answers = (sql) => baseAnswers(sql, new Date(1000));
    expect(await publishBang(link({ draft: true, purchase_disabled_at: null }), seller)).toBeNull();

    expect(database.writes.find((candidate) => candidate.model === "link")!.data!.first_published_at).toEqual(
      new Date(1000),
    );
  });

  it("refuses a seller whose email is not confirmed without writing", async () => {
    expect(await publishBang(link(), { ...seller, confirmed_at: null })).toBe(EMAIL_CONFIRMATION_MESSAGE);
    expect(database.writes).toEqual([]);
  });

  it("refuses a seller without a payment address, after the email check, without writing", async () => {
    const bare = { ...seller, payment_address: " " };
    expect(await publishBang(link(), bare)).toBe(PAYMENT_METHOD_MESSAGE);
    expect(await publishBang(link(), { ...bare, confirmed_at: null })).toBe(EMAIL_CONFIRMATION_MESSAGE);
    expect(database.writes).toEqual([]);
  });

  it("refuses a product unpublished by Gumroad, and one on a sales hold, without writing", async () => {
    expect(await publishBang(link({ flags: 65_536n | (1n << 28n) }), seller)).toBe(UNPUBLISHED_BY_ADMIN_MESSAGE);
    answers = (sql) => (sql.includes("product_sales_holds") ? [{ found: 1 }] : []);
    expect(await publishBang(link(), seller)).toBe(UNPUBLISHED_BY_ADMIN_MESSAGE);
    expect(database.writes).toEqual([]);
  });

  it("refuses a hold that appeared after the flags were read, under the lock, and rolls the save back", async () => {
    let holds = 0;
    answers = (sql) => {
      if (sql.includes("product_sales_holds")) return [{ found: holds++ === 0 ? 0 : 1 }];
      return baseAnswers(sql, null);
    };
    expect(await publishBang(link(), seller)).toBe(UNPUBLISHED_BY_ADMIN_MESSAGE);
    expect(database.writes).toEqual([]);
  });
});

describe("assertPlainPublish", () => {
  beforeEach(() => {
    setSqlClient(() => ({ $queryRaw: async () => [{ found: 0 }], $executeRaw: async () => 0 }) as never);
  });

  it("lets a seller without a payment address through when no merchant account, team flag or rejection note exists", async () => {
    await expect(assertPlainPublish(link(), { ...seller, payment_address: " " })).resolves.toBeUndefined();
  });

  it("hands back a seller without a payment address who may publish another way", async () => {
    const bare = { ...seller, payment_address: null };
    await expect(assertPlainPublish(link(), { ...bare, flags: 1n << 28n })).rejects.toThrow();
    setSqlClient(
      () =>
        ({
          $queryRaw: async (query: { sql: string }) => [{ found: query.sql.includes("merchant_accounts") ? 1 : 0 }],
          $executeRaw: async () => 0,
        }) as never,
    );
    await expect(assertPlainPublish(link(), bare)).rejects.toThrow();
  });

  it("lets a plain product through", async () => {
    await expect(assertPlainPublish(link(), seller)).resolves.toBeUndefined();
  });

  it.each([
    ["a deleted product", link({ deleted_at: new Date(0) }), seller],
    ["a physical product", link({ flags: (1n << 7n) | 65_536n }), seller],
    ["a seller whose videos are transcoded", link(), { ...seller, tier_state: 100_000 }],
  ])("hands back %s", async (_name, product, owner) => {
    await expect(assertPlainPublish(product, owner as User)).rejects.toThrow();
  });
});
