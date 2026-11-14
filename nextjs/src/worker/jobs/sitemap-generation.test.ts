// Replays sitemap-generation.golden.json (scripts/golden/sitemap-generation.rb): RefreshWishlistSitemapDailyWorker run by the real app
// as a Sidekiq job against a scratch database, on the production path (S3 upload, search engine ping) with every request answered by
// WebMock. Node sends the statements Rails sent and makes the same S3 call (key, content type, ACL, cache control, inflated XML), the
// same delete for an emptied sitemap and the same ping. The gzip header carries the wall clock, so bodies are compared inflated.
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { storageConfig } from "../../server/infra/storage.ts";
import { createJobsRuntime } from "../../server/jobs/runtime.ts";
import { parseRubyJson } from "../../server/jobs/sidekiq/ruby-json.ts";

import {
  asSidekiqJob,
  contextFor,
  recordingSidekiqRedis,
  rubyRuntimeRegistry,
  sequentialJids,
} from "./__fixtures__/golden.ts";
import { sqlReplay, type Statement } from "./__fixtures__/sql-replay.ts";
import { defaultSitemapDeps, type SitemapDeps, type SitemapUpload } from "./sitemap-generation.ts";
import { refreshWishlistSitemapDailyWorkerWith } from "./sitemap-workers.ts";

type Http = { method: string; url: string; headers: Record<string, string>; inflated_body: string | null };
type Case = {
  name: string;
  error: { class: string; message: string } | null;
  statements: Statement[];
  http: Http[];
};
const golden = parseRubyJson(
  readFileSync(new URL("./__fixtures__/sitemap-generation.golden.json", import.meta.url), "utf8"),
) as unknown as { now: number; cases: Case[] };

const LOCK = "sitemap_generation_lock";
const TEST_STORAGE = storageConfig("test");
// The recording's MinIO stand-in for S3: path-style, on the test bucket.
const RECORDED_OBJECT_PREFIX = `http://localhost:9010/${TEST_STORAGE.publicStorageS3Bucket}/`;
const RECORDED_PING_PREFIX = "http://www.google.com:80/webmasters/tools/ping?sitemap=";

// Rails transliterates "Café ünïcode" through I18n; Node hands a non-ASCII name back instead of guessing.
const HANDED_BACK = new Set(["a wishlist with a name that needs transliteration"]);

type Calls = { redis: unknown[][]; puts: SitemapUpload[]; deletes: unknown[]; pings: string[]; expired: number };

function deps(calls: Calls, locked = false): Partial<SitemapDeps> {
  return {
    redis: () => ({
      set: (...args) => {
        calls.redis.push(["set", ...args]);
        return Promise.resolve(locked ? null : "OK");
      },
      eval: (_script, _keys, ...args) => {
        calls.redis.push(["eval", ...args]);
        return Promise.resolve(1);
      },
    }),
    env: () => "production",
    storage: () => TEST_STORAGE,
    s3: () => ({
      put: (input) => {
        calls.puts.push(input);
        return Promise.resolve();
      },
      delete: (input) => {
        calls.deletes.push(input);
        return Promise.resolve();
      },
    }),
    ping: (url) => {
      calls.pings.push(url);
      return Promise.resolve();
    },
    expireSitemapConfigsCache: () => {
      calls.expired += 1;
      return Promise.resolve();
    },
    uuid: () => "lock-token",
  };
}

function jobsRuntime() {
  const recording = recordingSidekiqRedis();
  return {
    recording,
    runtime: createJobsRuntime({
      sidekiqRedis: recording.redis,
      bullmqRedis: recording.redis,
      registry: rubyRuntimeRegistry(),
      now: () => golden.now,
      newJid: sequentialJids(),
    }),
  };
}

const newCalls = (): Calls => ({ redis: [], puts: [], deletes: [], pings: [], expired: 0 });

beforeEach(() => {
  vi.stubEnv("RAILS_ENV", "test");
  // The recording's keys: .env.test sets the cipher key and leaves the numeric one blank, which Ruby reads as 0.
  vi.stubEnv("OBFUSCATE_IDS_CIPHER_KEY", "test-cipher-key");
  vi.stubEnv("OBFUSCATE_IDS_NUMERIC_CIPHER_KEY", "0");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("RefreshWishlistSitemapDailyWorker generation", () => {
  for (const c of golden.cases) {
    it(c.name, async () => {
      const sql = sqlReplay(c.statements);
      const calls = newCalls();
      const { recording, runtime } = jobsRuntime();
      let error: unknown = null;
      try {
        await asSidekiqJob(
          () => refreshWishlistSitemapDailyWorkerWith(deps(calls))([], contextFor(runtime)),
          golden.now,
        );
      } catch (e) {
        error = e;
      }

      // The lock is taken with SET NX EX and released with the token whatever the run did.
      expect(calls.redis).toEqual([
        ["set", LOCK, "lock-token", "EX", 3600, "NX"],
        ["eval", LOCK, "lock-token"],
      ]);
      expect(recording.snapshot()).toEqual({});

      if (HANDED_BACK.has(c.name)) {
        expect((error as Error).name).toBe("HandBackToRuby");
        expect([calls.puts, calls.deletes, calls.pings, calls.expired]).toEqual([[], [], [], 0]);
        return;
      }

      expect(error === null ? null : (error as Error).message).toEqual(c.error?.message ?? null);
      expect(sql.log).toEqual(sql.expected);

      const puts = c.http.filter((request) => request.method === "PUT");
      expect(
        calls.puts.map(({ Body, ...input }) => ({ ...input, inflated: gunzipSync(Body).toString("utf8") })),
      ).toEqual(
        puts.map((request) => ({
          Bucket: TEST_STORAGE.publicStorageS3Bucket,
          Key: request.url.slice(RECORDED_OBJECT_PREFIX.length),
          ACL: request.headers["X-Amz-Acl"],
          CacheControl: request.headers["Cache-Control"],
          ContentType: request.headers["Content-Type"],
          inflated: request.inflated_body,
        })),
      );
      expect(calls.deletes).toEqual(
        c.http
          .filter((request) => request.method === "DELETE")
          .map((request) => ({
            Bucket: TEST_STORAGE.publicStorageS3Bucket,
            Key: request.url.slice(RECORDED_OBJECT_PREFIX.length),
          })),
      );
      expect(calls.pings).toEqual(
        c.http
          .filter((request) => request.method === "GET")
          .map((request) => request.url.slice(RECORDED_PING_PREFIX.length)),
      );
      expect(calls.expired).toBe(c.error === null ? 1 : 0);
    });
  }

  it("re-enqueues itself after the retry delay when another run holds the lock", async () => {
    const calls = newCalls();
    const { recording, runtime } = jobsRuntime();
    await asSidekiqJob(
      () => refreshWishlistSitemapDailyWorkerWith(deps(calls, true))([], contextFor(runtime)),
      golden.now,
    );
    expect(calls.redis).toEqual([["set", LOCK, "lock-token", "EX", 3600, "NX"]]);
    expect(Object.keys(recording.snapshot())).toEqual(["schedule"]);
  });

  it.each(["development", "test"] as const)("hands a %s run back before writing anything", async (env) => {
    const calls = newCalls();
    const { runtime } = jobsRuntime();
    const sql = sqlReplay([]);
    await expect(
      asSidekiqJob(
        () => refreshWishlistSitemapDailyWorkerWith({ ...deps(calls), env: () => env })([], contextFor(runtime)),
        golden.now,
      ),
    ).rejects.toMatchObject({ name: "HandBackToRuby" });
    expect(sql.log).toEqual([]);
    expect([calls.puts, calls.deletes, calls.pings, calls.expired]).toEqual([[], [], [], 0]);
  });

  it("hands a run back when the uploader has no credentials", async () => {
    const calls = newCalls();
    const { runtime } = jobsRuntime();
    await expect(
      asSidekiqJob(
        () => refreshWishlistSitemapDailyWorkerWith({ ...deps(calls), s3: () => null })([], contextFor(runtime)),
        golden.now,
      ),
    ).rejects.toMatchObject({ name: "HandBackToRuby" });
    expect(calls.redis.map(([name]) => name)).toEqual(["set", "eval"]);
  });

  it("hands a run back when an owner's host would need XML escaping", async () => {
    const calls = newCalls();
    const { runtime } = jobsRuntime();
    const c = structuredClone(golden.cases.find((candidate) => candidate.name === "one wishlist with three products")!);
    const owners = c.statements[1]!.result!;
    owners.rows![0]![owners.fields!.indexOf("username")] = "a&b";
    sqlReplay(c.statements);
    await expect(
      asSidekiqJob(() => refreshWishlistSitemapDailyWorkerWith(deps(calls))([], contextFor(runtime)), golden.now),
    ).rejects.toMatchObject({ name: "HandBackToRuby" });
    expect([calls.puts, calls.deletes, calls.pings, calls.expired]).toEqual([[], [], [], 0]);
    expect(calls.redis.map(([name]) => name)).toEqual(["set", "eval"]);
  });

  it("does not ping search engines outside production", async () => {
    const calls = newCalls();
    const { runtime } = jobsRuntime();
    const c = golden.cases.find((candidate) => candidate.name === "one wishlist with three products")!;
    const sql = sqlReplay(c.statements);
    await asSidekiqJob(
      () => refreshWishlistSitemapDailyWorkerWith({ ...deps(calls), env: () => "staging" })([], contextFor(runtime)),
      golden.now,
    );
    expect(sql.log).toEqual(sql.expected);
    expect(calls.puts).toHaveLength(1);
    expect(calls.pings).toEqual([]);
  });

  it("pings Google with the CGI-escaped sitemap URL and swallows a failure", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response("")).mockRejectedValueOnce(new Error("timeout"));
    vi.stubGlobal("fetch", fetchMock);
    const url = "https://public-files.gumroad.com/sitemap/wishlists/sitemap.xml.gz";
    await defaultSitemapDeps.ping(url);
    await expect(defaultSitemapDeps.ping(url)).resolves.toBeUndefined();
    expect(fetchMock.mock.calls[0]![0]).toBe(
      "http://www.google.com/webmasters/tools/ping?sitemap=https%3A%2F%2Fpublic-files.gumroad.com%2Fsitemap%2Fwishlists%2Fsitemap.xml.gz",
    );
  });
});
