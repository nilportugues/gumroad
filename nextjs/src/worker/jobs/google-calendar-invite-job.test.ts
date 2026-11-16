// Replays google-calendar-invite-job.golden.json (scripts/golden/google-calendar-invite-job.rb): GoogleCalendarInviteJob run by the
// real app as a Sidekiq job, Google answered by WebMock. Node reads what Rails read, sends the requests Rails sent (event insert,
// token refresh, retry; each counted in the shared rate limit), writes the refreshed token and the event id as Rails did and fails
// with the same Ruby error on an answer it cannot index. A calendar id Ruby's URI parser rejects is handed back before the request.
import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createJobsRuntime } from "../../server/jobs/runtime.ts";
import { parseRubyJson, type JsonValue } from "../../server/jobs/sidekiq/ruby-json.ts";

import {
  asSidekiqJob,
  contextFor,
  recordingSidekiqRedis,
  rubyRuntimeRegistry,
  sequentialJids,
  type RedisSnapshot,
} from "./__fixtures__/golden.ts";
import { sqlReplay, type Statement } from "./__fixtures__/sql-replay.ts";

const hashes = new Map<string, Map<string, number>>();
const expiring = new Set<string>();
const fakeRedis = {
  multi: () => {
    const calls: (() => number)[] = [];
    const chain = {
      hincrby: (key: string, field: string, count: number) => {
        calls.push(() => {
          const hash = hashes.get(key) ?? new Map<string, number>();
          hash.set(field, (hash.get(field) ?? 0) + count);
          hashes.set(key, hash);
          return hash.get(field)!;
        });
        return chain;
      },
      expire: (key: string) => {
        calls.push(() => Number(expiring.add(key).size));
        return chain;
      },
      exec: () => Promise.resolve(calls.map((call) => [null, call()])),
    };
    return chain;
  },
  hmget: (key: string, ...fields: string[]) =>
    Promise.resolve(
      fields.map((field) => hashes.get(key)?.get(field)).map((v) => (v === undefined ? null : String(v))),
    ),
  hkeys: (key: string) => Promise.resolve([...(hashes.get(key)?.keys() ?? [])]),
  hdel: () => Promise.resolve(0),
};
vi.mock("../../server/infra/redis.ts", () => ({ getRedis: () => fakeRedis }));

const { googleCalendarInviteJobWith } = await import("./google-calendar-invite-job.ts");

type Request = { method: string; url: string; headers: Record<string, string>; body: string | null };
type Answer = { status?: number; body?: string; headers?: Record<string, string> };
type Case = {
  name: string;
  args: JsonValue[];
  error: { class: string; message: string } | null;
  statements: Statement[];
  redis: RedisSnapshot;
  http: Request[];
  http_responses: Answer[];
};
const golden = parseRubyJson(
  readFileSync(new URL("./__fixtures__/google-calendar-invite-job.golden.json", import.meta.url), "utf8"),
) as unknown as { now: number; cases: Case[] };
const handler = googleCalendarInviteJobWith({ now: () => new Date(Math.round(golden.now * 1000)) });

// The client credentials Rails boots with are in the body of the first token request it recorded.
const refresh = golden.cases.flatMap((c) => c.http).find((r) => r.url.includes("/token"))!;
const credentials = new URLSearchParams(refresh.body!);

// Failures of Node's own, where Rails instead fails inside the answer it got or writes a Ruby rendering Node does not reproduce.
const NOT_PORTED = new Set(["the answer has a list for an id"]);
// Rails sends this request and fails inside URI; Node hands it back before the rate limit.
const HANDED_BACK = new Set(["the calendar id needs escaping"]);

beforeEach(() => {
  // The rate limit buckets Date.now() into five seconds.
  vi.useFakeTimers({ now: Math.round(golden.now * 1000), toFake: ["Date"] });
  vi.stubEnv("GOOGLE_CLIENT_ID", credentials.get("client_id")!);
  vi.stubEnv("GOOGLE_CLIENT_SECRET", credentials.get("client_secret")!);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  hashes.clear();
  expiring.clear();
});

function runtime() {
  const recording = recordingSidekiqRedis();
  return createJobsRuntime({
    sidekiqRedis: recording.redis,
    bullmqRedis: recording.redis,
    registry: rubyRuntimeRegistry(),
    now: () => golden.now,
    newJid: sequentialJids(),
  });
}

const withoutPort = (url: string) => url.replace(":443/", "/");

describe("GoogleCalendarInviteJob", () => {
  for (const c of golden.cases) {
    it(c.name, async () => {
      const sql = sqlReplay(c.statements);
      const sent: Request[] = [];
      const answers = [...c.http_responses];
      vi.stubGlobal("fetch", (url: string | URL, init: RequestInit = {}) => {
        sent.push({
          method: init.method ?? "GET",
          url: String(url),
          headers: Object.fromEntries(new Headers(init.headers)),
          body: typeof init.body === "string" ? init.body : null,
        });
        const answer = answers.shift() ?? {};
        return Promise.resolve(
          new Response(answer.body ?? "{}", { status: answer.status ?? 200, headers: answer.headers }),
        );
      });
      let error: unknown = null;
      try {
        await asSidekiqJob(() => handler(c.args, contextFor(runtime())), golden.now);
      } catch (e) {
        error = e;
      }

      if (HANDED_BACK.has(c.name)) {
        expect((error as Error).name).toBe("HandBackToRuby");
        expect(sent).toEqual([]);
        expect(hashes.size).toBe(0);
      } else if (NOT_PORTED.has(c.name)) {
        expect((error as Error).name).toBe("NotPortedError");
      } else {
        expect(error === null ? null : (error as Error).message).toEqual(c.error?.message ?? null);
        expect(sent.map((r) => [r.method, r.url, r.body, r.headers.authorization])).toEqual(
          c.http.map((r) => [r.method, withoutPort(r.url), r.body, r.headers.Authorization]),
        );
        const snapshot = Object.fromEntries(
          [...hashes].map(([key, hash]) => [
            key,
            {
              type: "hash",
              value: Object.fromEntries([...hash].map(([field, count]) => [field, String(count)])),
              expires: expiring.has(key),
            },
          ]),
        );
        expect(snapshot).toEqual(c.redis);
        expect(sql.log).toEqual(sql.expected);
      }
    });
  }

  for (const args of [["abc"], [null], [1.5]] as JsonValue[][]) {
    it(`hands ${JSON.stringify(args)} back before any statement`, async () => {
      const sql = sqlReplay([]);
      await expect(asSidekiqJob(() => handler(args, contextFor(runtime())), golden.now)).rejects.toMatchObject({
        name: "HandBackToRuby",
      });
      expect(sql.log).toEqual([]);
    });
  }
});
