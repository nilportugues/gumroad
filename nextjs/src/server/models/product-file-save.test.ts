// The order of a new product's file inserts, the product update that follows and the jobs, against the `timeline` Rails recorded for
// POST /v2/products with files (parity/fixtures/requests/api/v2/product_create_parity_spec): the replay proves the row diffs, the response and
// the jobs, and this pins what a diff cannot show. PaperTrail is off in the Rails specs, so the versions Node writes are checked on their own.
import { readFileSync } from "node:fs";

import type { Link } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const current: { writes: { model: string; op: string; id: unknown }[] } = { writes: [] };
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
  performAsync: async (jobClass: string, args: unknown[]) =>
    void current.writes.push({ model: "job", op: "create", id: `${jobClass} ${JSON.stringify(args)}` }),
}));
vi.mock("../infra/storage.ts", () => ({
  storageConfig: () => ({ s3BaseUrl: "http://localhost:9010/gumroad-specs/" }),
}));

const { resetLinkCollaborators, setLinkCollaborators, Links } = await import("./link.ts");
const { setSqlClient } = await import("./sql.ts");
const { setTransactionRunner } = await import("./runtime/transaction.ts");
const { fakeDatabase } = await import("./runtime/testing.ts");
const { saveFilesForNewProduct } = await import("./product-file-save.ts");

const FIXTURE = new URL(
  "../../../parity/fixtures/requests/api/v2/product_create_parity_spec/api-v2-product-create-files-creates-a-draft-with-two-files-in-the-order-they-were-sent.json",
  import.meta.url,
);
type TimelineEvent = { type: string; op?: string; table?: string; index?: number };

// The writes Rails made after the product and its price: the files, then the product's own update.
const railsFileWrites = (): string[] => {
  const exchange = (
    JSON.parse(readFileSync(FIXTURE, "utf8")) as { exchanges: { timeline: TimelineEvent[] }[] }
  ).exchanges.at(-1)!;
  return exchange.timeline
    .filter((event) => event.type === "db")
    .map((event) => `${event.op} ${event.table}`)
    .filter((entry) => entry.includes("product_files") || entry === "update links");
};

const TABLES: Record<string, string> = { productFile: "product_files", link: "links", version: "versions" };
const OPS: Record<string, string> = { create: "insert", update: "update", delete: "delete" };
const LINK = {
  id: 5n,
  user_id: 1n,
  name: "Course",
  unique_permalink: "course",
  flags: 0n,
  content_updated_at: new Date(0),
  created_at: new Date(0),
  updated_at: new Date(0),
  native_type: "digital",
  price_currency_type: "usd",
  price_cents: 500,
  discover_fee_per_thousand: 100,
  filetype: "link",
  filegroup: "url",
  draft: true,
  purchase_type: 0,
  deleted_at: null,
} as unknown as Link;

const SELLER = { id: 1n, flags: 0n, username: "seller", created_at: new Date(0), updated_at: new Date(0) };

describe("saveFilesForNewProduct", () => {
  let database: ReturnType<typeof fakeDatabase>;
  beforeEach(() => {
    database = fakeDatabase();
    current.writes = database.writes;
    const answer = async (query: { sql: string }) => {
      if (query.sql.includes("FROM `users`")) return [SELLER];
      if (query.sql.includes("FROM `prices`"))
        return [
          {
            id: 1n,
            link_id: 5n,
            price_cents: 500,
            currency: "usd",
            flags: 0n,
            recurrence: null,
            deleted_at: null,
            variant_id: null,
          },
        ];
      if (query.sql.includes("COUNT(")) return [{ total: 0 }];
      return [];
    };
    const tx = new Proxy(database.tx, {
      get: (target, prop: string) => (prop === "$queryRaw" ? answer : target[prop as never]),
    });
    setTransactionRunner(async (fn) => fn(tx as never));
    setSqlClient(() => ({ $queryRaw: answer, $executeRaw: async () => 0 }) as never);
    setLinkCollaborators({ cacheDelete: async () => undefined, isFeatureEnabled: async () => false });
  });
  afterEach(() => resetLinkCollaborators());

  const files = [
    {
      url: "http://localhost:9010/gumroad-specs/attachments/123/abc/original/lesson.mp4",
      position: 2,
      stream_only: true,
    },
    { url: "http://localhost:9010/gumroad-specs/attachments/123/def/original/notes.txt", position: 1 },
  ];
  const writesOf = () =>
    database.writes
      .filter((write) => write.model !== "version" && write.model !== "http" && write.model !== "job")
      .map((write) => `${OPS[write.op]} ${TABLES[write.model] ?? write.model}`);

  it("inserts the files in the order they were sent, then updates the product, as Rails did", async () => {
    await saveFilesForNewProduct(Links.load(LINK), files);

    expect(writesOf()).toEqual(railsFileWrites().slice(0, 3));
  });

  it("writes a version for each file and enqueues its analysis after the commit", async () => {
    await saveFilesForNewProduct(Links.load(LINK), files);

    expect(
      database.writes.filter((write) => write.model === "version" && write.op === "create").length,
    ).toBeGreaterThanOrEqual(2);
    // Rails enqueued them in the order the files were inserted (the fixture's job events).
    const inserted = database.writes
      .filter((write) => write.model === "productFile" && write.op === "create")
      .map((write) => write.id);
    expect(database.writes.filter((write) => write.model === "job").map((write) => write.id)).toEqual(
      inserted.map((id) => `AnalyzeFileWorker [${String(id)},"ProductFile"]`),
    );
  });
});
