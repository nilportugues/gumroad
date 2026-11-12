// The order of promoteBuildBang's writes and jobs against the `timeline` Rails recorded for POST /v2/products/:id/builds/:id/promote
// (parity/fixtures/requests/api/v2/product_builds_writes_parity_spec): the replay proves the row diffs, the response and the set of jobs,
// and this pins what a diff cannot show, and that every shape the port cannot prove stops before the first write.
import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.OBFUSCATE_IDS_CIPHER_KEY ??= "test-cipher-key";
process.env.OBFUSCATE_IDS_NUMERIC_CIPHER_KEY ??= "1";

const current: { writes: { model: string; op: string; id: unknown; data?: Record<string, unknown> }[] } = {
  writes: [],
};
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

const { resetLinkCollaborators, setLinkCollaborators } = await import("./link.ts");
const { setSqlClient } = await import("./sql.ts");
const { setTransactionRunner } = await import("./runtime/transaction.ts");
const { fakeDatabase } = await import("./runtime/testing.ts");
const { promoteBuildBang } = await import("./product-build-promote.ts");
const { encrypt } = await import("../../lib/obfuscate-ids.ts");

const FIXTURES = new URL(
  "../../../parity/fixtures/requests/api/v2/product_builds_writes_parity_spec/",
  import.meta.url,
);
type TimelineEvent = { type: string; op?: string; table?: string; index?: number };
type Exchange = { timeline: TimelineEvent[]; jobs: { class: string; args: unknown[] }[] };

const railsTimeline = (fragment: string): string[] => {
  const file = readFileSync(new URL(fragment, FIXTURES), "utf8");
  const exchange = (JSON.parse(file) as { exchanges: Exchange[] }).exchanges.at(-1)!;
  return exchange.timeline.map((event) =>
    event.type === "db" ? `${event.op} ${event.table}` : `job ${exchange.jobs[event.index!]!.class}`,
  );
};

const PREFIX = "api-v2-product-build-writes-post-products-link-id-builds-id-promote-";
const SUPERSEDES = `${PREFIX}supersedes-the-live-build-and-swaps-its-file-in-the-c47751c8.json`;
const FIRST_BUILD = `${PREFIX}promotes-the-first-build-of-a-product-with-no-pages.json`;
// Products::BuildsController#promote (parity/fixtures/requests/product_builds_promote_parity_spec) takes the same path.
const INTERNAL = new URL(
  "../../../parity/fixtures/requests/product_builds_promote_parity_spec/promoting-a-product-build-supersedes-the-live-build-and-swaps-its-file-in-the-pages.json",
  import.meta.url,
);
const TWO_PAGES = `${PREFIX}puts-the-file-on-the-first-page-only-and-keeps-the-o-a689e4f9.json`;

const T0 = new Date("2026-01-01T00:00:00Z");
const LINK = {
  id: 5n,
  user_id: 1n,
  name: "Playable",
  unique_permalink: "playable",
  flags: 0n,
  content_updated_at: T0,
  created_at: T0,
  updated_at: T0,
  native_type: "digital",
  price_currency_type: "usd",
  price_cents: 500,
  filetype: "link",
  filegroup: "url",
  draft: false,
  purchase_type: 0,
  deleted_at: null,
};
const build = (id: bigint, number: number, over: Record<string, unknown> = {}) => ({
  id,
  product_id: 5n,
  public_id: `public${id}`,
  number,
  status: "uploaded",
  source_url: "https://example.com/game.zip",
  storage_key: `builds/5/${number}/build.zip`,
  byte_size: 1024n,
  product_file_id: null,
  promoted_at: null,
  created_at: T0,
  updated_at: T0,
  ...over,
});
const OLD_FILE = {
  id: 10n,
  link_id: 5n,
  url: "http://localhost:9010/gumroad-specs/builds/5/1/build.zip",
  filetype: "zip",
  filegroup: "archive",
  flags: 0n,
  deleted_at: null,
  created_at: T0,
  updated_at: T0,
};
const embed = (id: number | bigint, uid: string) => ({ type: "fileEmbed", attrs: { id: encrypt(id), uid } });
const paragraph = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
const page = (id: bigint, position: number, description: unknown[]) => ({
  id,
  entity_id: 5n,
  entity_type: "Link",
  description,
  position,
  title: null,
  created_at: T0,
  updated_at: T0,
  deleted_at: null,
});

type Scenario = {
  build?: Record<string, unknown>;
  previous?: Record<string, unknown> | null;
  pages?: Record<string, unknown>[];
  variants?: boolean;
  folderArchive?: boolean;
  foreignFiles?: bigint[];
};

describe("promoteBuildBang", () => {
  let database: ReturnType<typeof fakeDatabase>;
  const setUp = (scenario: Scenario = {}) => {
    database = fakeDatabase();
    current.writes = database.writes;
    const answer = async (query: { sql: string }) => {
      const sql = query.sql;
      if (sql.includes("FROM `links`")) return [LINK];
      if (sql.includes("FROM `product_builds`") && sql.includes("`status` ="))
        return scenario.previous ? [scenario.previous] : [];
      if (sql.includes("FROM `product_builds`")) return [scenario.build ?? build(2n, 2)];
      if (sql.includes("FROM `base_variants`")) return scenario.variants ? [{ one: 1 }] : [];
      if (sql.includes("FROM `product_files_archives`")) return scenario.folderArchive ? [{ one: 1 }] : [];
      if (sql.includes("FROM `product_files`") && sql.includes("`link_id` !="))
        return (scenario.foreignFiles ?? []).map((id) => ({ id }));
      if (sql.includes("FROM `product_files`")) return [OLD_FILE];
      if (sql.includes("FROM `rich_contents`")) return scenario.pages ?? [];
      if (sql.includes("COUNT(")) return [{ total: 0 }];
      return [];
    };
    const tx = new Proxy(database.tx, {
      get: (target, prop: string) => (prop === "$queryRaw" ? answer : target[prop as never]),
    });
    setTransactionRunner(async (fn) => fn(tx as never));
    setSqlClient(() => ({ $queryRaw: answer, $executeRaw: async () => 0 }) as never);
    setLinkCollaborators({ cacheDelete: async () => undefined, isFeatureEnabled: async () => false });
  };
  afterEach(() => resetLinkCollaborators());
  beforeEach(() => setUp());

  const TABLES: Record<string, string> = {
    productFile: "product_files",
    productBuild: "product_builds",
    richContent: "rich_contents",
    link: "links",
  };
  const OPS: Record<string, string> = { create: "insert", update: "update", delete: "delete" };
  const writesOf = () =>
    database.writes
      .filter((write) => !["version", "http"].includes(write.model))
      .map((write) =>
        write.model === "job"
          ? `job ${String(write.id).split(" ")[0]}`
          : `${OPS[write.op]} ${TABLES[write.model] ?? write.model}`,
      );
  const uuid = () => "11111111-1111-4111-8111-111111111111";

  it("supersedes the live build, swaps the embed and queues the unpack in the order Rails did", async () => {
    setUp({
      previous: build(1n, 1, { status: "live", product_file_id: 10n, promoted_at: T0 }),
      pages: [page(7n, 0, [paragraph("Intro"), embed(10, "old"), paragraph("Outro")])],
    });

    await promoteBuildBang(5n, 2n, { uuid });

    expect(writesOf()).toEqual(railsTimeline(SUPERSEDES));
    const internal = (JSON.parse(readFileSync(INTERNAL, "utf8")) as { exchanges: Exchange[] }).exchanges.at(-1)!;
    expect(
      internal.timeline.map((event) =>
        event.type === "db" ? `${event.op} ${event.table}` : `job ${internal.jobs[event.index!]!.class}`,
      ),
    ).toEqual(railsTimeline(SUPERSEDES));
    const update = database.writes.find((write) => write.model === "richContent")!;
    const file = database.writes.find((write) => write.model === "productFile" && write.op === "create")!;
    expect(update.data!.description).toEqual([
      paragraph("Intro"),
      paragraph("Outro"),
      { type: "fileEmbed", attrs: { id: encrypt(file.id as number), uid: uuid() } },
    ]);
  });

  it("creates the zip of a first build and queues the unpack, with no page to touch", async () => {
    await promoteBuildBang(5n, 2n, { uuid });

    expect(writesOf()).toEqual(railsTimeline(FIRST_BUILD));
    const file = database.writes.find((write) => write.model === "productFile" && write.op === "create")!;
    expect(file.data).toMatchObject({
      url: "http://localhost:9010/gumroad-specs/builds/5/2/build.zip",
      display_name: "Playable build 2.zip",
    });
    expect(database.writes.find((write) => write.model === "productBuild")!.data).toMatchObject({
      status: "live",
      product_file_id: file.id,
    });
  });

  it("puts the zip on the first page by position only and rewrites a page only when it changes", async () => {
    setUp({
      previous: build(1n, 1, { status: "live", product_file_id: 10n, promoted_at: T0 }),
      pages: [
        page(7n, 1, [embed(10, "old"), embed(99, "other")]),
        page(8n, 0, [paragraph("Start")]),
        page(9n, 2, [paragraph("Untouched")]),
      ],
    });

    await promoteBuildBang(5n, 2n, { uuid });

    expect(writesOf().filter((entry) => entry === "update rich_contents")).toHaveLength(2);
    expect(railsTimeline(TWO_PAGES).filter((entry) => entry === "update rich_contents")).toHaveLength(2);
    const [first, second] = database.writes.filter((write) => write.model === "richContent");
    expect([first!.id, second!.id]).toEqual([7n, 8n]);
    expect(first!.data!.description).toEqual([embed(99, "other")]);
  });

  it("queues the unpack after every write, as Rails queues it outside the lock", async () => {
    await promoteBuildBang(5n, 2n, { uuid });

    expect(writesOf().at(-1)).toBe("job ProductBuildUnpackJob");
    expect(writesOf().indexOf("job AnalyzeFileWorker")).toBeLessThan(writesOf().indexOf("job ProductBuildUnpackJob"));
  });

  describe("hands back before the first write", () => {
    const refused = async (scenario: Scenario, message: RegExp) => {
      setUp(scenario);
      await expect(promoteBuildBang(5n, 2n, { uuid })).rejects.toThrow(message);
      expect(database.writes).toEqual([]);
    };

    it("a build that is already live", () => refused({ build: build(2n, 2, { status: "live" }) }, /live build/u));
    it("a product with versions", () => refused({ variants: true }, /versions/u));
    it("a product with a folder archive", () => refused({ folderArchive: true }, /folder archive/u));
    it("a page with a folder", () =>
      refused(
        {
          pages: [
            page(7n, 0, [{ type: "fileEmbedGroup", attrs: { name: "Pack", uid: "g" }, content: [embed(1, "a")] }]),
          ],
        },
        /folder/u,
      ));
    it("a page whose description is not a list of nodes", () =>
      refused({ pages: [page(7n, 0, "not a list" as never)] }, /description the port does not read/u));
    it("a build that no longer validates", () =>
      refused({ build: build(2n, 2, { byte_size: 0n }) }, /no longer validates/u));
    it("a superseded build that no longer validates", () =>
      refused({ previous: build(1n, 1, { status: "live", source_url: "" }) }, /no longer validates/u));
    it("a page that embeds a file of another product", () =>
      refused(
        {
          pages: [page(7n, 0, [embed(77, "x")])],
          foreignFiles: [77n],
          previous: build(1n, 1, { status: "live", product_file_id: 10n }),
        },
        /file of another product/u,
      ));
    it("a page with a link to a blocked scheme", () =>
      refused(
        {
          previous: build(1n, 1, { status: "live", product_file_id: 10n }),
          pages: [
            page(7n, 0, [
              {
                type: "paragraph",
                content: [{ type: "text", text: "x", marks: [{ type: "link", attrs: { href: "javascript:x" } }] }],
              },
              embed(10, "old"),
            ]),
          ],
        },
        /blocked scheme/u,
      ));
  });
});
