import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { memoryJobs } from "../src/channels";
import { prismaExecutor, type SqlExecutor } from "../src/db";
import type { Exchange, Fixture } from "../src/fixture";
import { assertParity, formatReplay, replayFixture, routeHandlers, type Transport } from "../src/replay";

// Needs a MySQL database it may wipe, e.g. one built with `prisma db push`:
//   PARITY_DATABASE_URL=mysql://root:password@127.0.0.1:3306/parity_test npm run parity
// The fixtures below are hand-written in the recorder's format, not recorded from Rails.
const url = process.env.PARITY_DATABASE_URL;

describe.skipIf(!url)("replay against MySQL", () => {
  let client: PrismaClient;
  let sql: SqlExecutor;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    client = new PrismaClient({ datasourceUrl: url });
    sql = prismaExecutor(client);
    for (const table of ["parity_test_users", "parity_test_followers", "parity_test_pairs"]) {
      await sql.execute(`DROP TABLE IF EXISTS ${table}`);
    }
    await sql.execute(`CREATE TABLE parity_test_users (
      id bigint NOT NULL AUTO_INCREMENT PRIMARY KEY, email varchar(191) NOT NULL, flags bigint NOT NULL DEFAULT 0,
      avatar blob, created_at datetime(6) NOT NULL, updated_at datetime(6) NOT NULL)`);
    await sql.execute(`CREATE TABLE parity_test_followers (
      id bigint NOT NULL AUTO_INCREMENT PRIMARY KEY, followed_id bigint NOT NULL, email varchar(191) NOT NULL,
      confirmed_on date, created_at datetime NOT NULL)`);
    await sql.execute("CREATE TABLE parity_test_pairs (a bigint NOT NULL, b bigint NOT NULL)");
  });

  afterAll(async () => {
    await client?.$disconnect();
  });

  const exchange: Exchange = {
    seed: {
      tables: {
        parity_test_users: {
          columns: {
            id: "bigint",
            email: "varchar",
            flags: "bigint",
            avatar: "blob",
            created_at: "datetime",
            updated_at: "datetime",
          },
          primaryKey: ["id"],
          rows: [
            {
              id: 1,
              email: "seller@example.com",
              flags: { $big: "9007199254740993" },
              avatar: { $base64: "iVBORw==" },
              created_at: "<now-48h>",
              updated_at: "<now-48h>",
            },
          ],
        },
        parity_test_pairs: { columns: { a: "bigint", b: "bigint" }, primaryKey: [], rows: [{ a: 1, b: 2 }] },
      },
      // A row created and destroyed during the spec's setup leaves the counter past MAX(id) + 1.
      autoIncrement: { parity_test_users: 2, parity_test_followers: 3 },
    },
    request: {
      source: "request",
      method: "POST",
      path: "/follow",
      headers: { host: "app.test.gumroad.com", "content-type": "application/json" },
      body: '{"seller_id":1,"email":"buyer@example.com"}',
    },
    response: {
      status: 302,
      location: "http://app.test.gumroad.com/follow/confirm",
      headers: {},
      cookies: { flash: { value: "Check your email", path: "/" } },
    },
    db: {
      parity_test_followers: {
        inserted: [{ id: 3, followed_id: 1, email: "buyer@example.com", confirmed_on: "<today>", created_at: "<now>" }],
      },
      parity_test_pairs: { inserted: [{ a: 1, b: 3 }] },
      parity_test_users: { updated: [{ key: { id: 1 }, changes: { updated_at: ["<now-48h>", "<now>"] } }] },
    },
    jobs: [{ class: "SendFollowerConfirmationJob", args: [3], queue: "default" }],
    mails: [],
    http: [
      {
        method: "POST",
        url: "https://api.example.com/v1/subscribers",
        contentType: "application/json",
        body: '{"email":"buyer@example.com"}',
        response: { status: 200, contentType: "application/json", body: '{"ok":true}' },
      },
    ],
  };
  const fixture: Fixture = { version: 1, spec: "spec/requests/follow_spec.rb", example: "follows a seller", exchanges: [exchange] };

  function followHandler(jobs: ReturnType<typeof memoryJobs>, options: { touchSeller: boolean }): Transport {
    return async (request) => {
      const { seller_id, email } = (await request.json()) as { seller_id: number; email: string };
      await sql.execute(
        "INSERT INTO parity_test_followers (followed_id, email, confirmed_on, created_at) VALUES (?, ?, UTC_DATE(), UTC_TIMESTAMP())",
        [seller_id, email],
      );
      const [{ id }] = (await sql.query("SELECT MAX(id) AS id FROM parity_test_followers")) as [{ id: bigint }];
      await sql.execute("INSERT INTO parity_test_pairs (a, b) VALUES (?, ?)", [seller_id, id]);
      if (options.touchSeller) await sql.execute("UPDATE parity_test_users SET updated_at = UTC_TIMESTAMP(6) WHERE id = ?", [seller_id]);
      await fetch("https://api.example.com/v1/subscribers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      jobs.push({ class: "SendFollowerConfirmationJob", args: [Number(id)], queue: "default" });
      const headers = new Headers({ location: "http://app.test.gumroad.com/follow/confirm" });
      headers.append("set-cookie", "flash=Check+your+email; path=/");
      return new Response(null, { status: 302, headers });
    };
  }

  it("replays green when the port's response, writes, jobs and outbound calls match", async () => {
    const jobs = memoryJobs();
    const result = await replayFixture(fixture, { sql, transport: followHandler(jobs, { touchSeller: true }), jobs });

    expect(formatReplay(result)).toContain("identical");
    assertParity(result);
  });

  it("seeds exact bigints, blobs, keyless rows and auto-increment counters", async () => {
    const jobs = memoryJobs();
    await replayFixture(fixture, { sql, transport: followHandler(jobs, { touchSeller: true }), jobs });

    const [user] = await sql.query("SELECT CAST(flags AS CHAR) AS flags, TO_BASE64(avatar) AS avatar FROM parity_test_users");
    expect(user).toEqual({ flags: "9007199254740993", avatar: "iVBORw==" });
    expect(await sql.query("SELECT CAST(a AS CHAR) AS a, CAST(b AS CHAR) AS b FROM parity_test_pairs ORDER BY b")).toEqual([
      { a: "1", b: "2" },
      { a: "1", b: "3" },
    ]);
  });

  it("names every channel that diverges when the port misses a write", async () => {
    const jobs = memoryJobs();
    const result = await replayFixture(fixture, { sql, transport: followHandler(jobs, { touchSeller: false }), jobs });

    expect(result.exchanges[0]!.differences.map((difference) => difference.path)).toEqual(["db.parity_test_users"]);
    expect(() => assertParity(result)).toThrow(/db\.parity_test_users {2}missing in next/);
  });

  it("replays the real /api/health route handler in-process", async () => {
    const health = await import("@/app/api/health/route");
    const healthFixture: Fixture = {
      version: 1,
      spec: "hand-written",
      example: "health check",
      exchanges: [
        {
          seed: { tables: {}, autoIncrement: {} },
          request: { source: "request", method: "GET", path: "/api/health", headers: { host: "localhost" } },
          response: { status: 200, headers: { "content-type": "application/json" }, json: { ok: true } },
          db: {},
          jobs: [],
          mails: [],
          http: [],
        },
      ],
    };

    assertParity(await replayFixture(healthFixture, { sql, transport: routeHandlers(health) }));
  });
});
