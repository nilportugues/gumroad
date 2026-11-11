// Replays submit-to-indexnow-job.golden.json (scripts/golden/submit-to-indexnow-job.rb): SubmitToIndexnowJob run by the real app as a
// Sidekiq job with WebMock answering every outbound request. Node sends the statements Rails sent (the products, then their sellers) and
// the same POSTs (URL, Content-Type, body) in the same order, and raises the same error on a non-2xx answer.
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
} from "./__fixtures__/golden.ts";
import { sqlReplay, type Statement } from "./__fixtures__/sql-replay.ts";
import { submitToIndexnowJobWith } from "./submit-to-indexnow-job.ts";

type Case = {
  name: string;
  args: JsonValue[];
  error: { class: string; message: string } | null;
  statements: Statement[];
  http: { method: string; url: string; headers: Record<string, string>; body: string }[];
  http_responses: { status?: number; body?: string }[];
};
const golden = parseRubyJson(
  readFileSync(new URL("./__fixtures__/submit-to-indexnow-job.golden.json", import.meta.url), "utf8"),
) as unknown as {
  now: number;
  key: string;
  cases: Case[];
};
const handler = submitToIndexnowJobWith({ now: () => new Date(Math.round(golden.now * 1000)) });

// Ruby's id casts (a float, a word) are not reproduced.
const HANDED_BACK = new Map<string, JsonValue[]>([
  ["a float id", [[1.5]]],
  ["a word for an id", [["abc"]]],
  ["a nested list", [[[1]]]],
]);

describe("SubmitToIndexnowJob", () => {
  const original = {
    key: process.env.INDEXNOW_KEY,
    railsEnv: process.env.RAILS_ENV,
    customDomain: process.env.CUSTOM_DOMAIN,
  };
  let requests: { method: string; url: string; contentType: string | null; body: string }[];
  let answers: { status?: number; body?: string }[];

  beforeEach(() => {
    process.env.RAILS_ENV = "test";
    delete process.env.CUSTOM_DOMAIN;
    requests = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init: RequestInit) => {
        requests.push({
          method: String(init.method),
          url: String(url),
          contentType: new Headers(init.headers).get("content-type"),
          body: String(init.body),
        });
        const answer = answers.shift() ?? {};
        return new Response(answer.status === 204 ? null : (answer.body ?? "{}"), { status: answer.status ?? 200 });
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    if (original.key === undefined) delete process.env.INDEXNOW_KEY;
    else process.env.INDEXNOW_KEY = original.key;
    if (original.railsEnv === undefined) delete process.env.RAILS_ENV;
    else process.env.RAILS_ENV = original.railsEnv;
    if (original.customDomain !== undefined) process.env.CUSTOM_DOMAIN = original.customDomain;
  });

  async function run(c: Case, args: JsonValue[], statements: Statement[], key: string | null) {
    if (key === null) delete process.env.INDEXNOW_KEY;
    else process.env.INDEXNOW_KEY = key;
    answers = [...c.http_responses];
    const sql = sqlReplay(statements);
    const recording = recordingSidekiqRedis();
    const runtime = createJobsRuntime({
      sidekiqRedis: recording.redis,
      bullmqRedis: recording.redis,
      registry: rubyRuntimeRegistry(),
      now: () => golden.now,
      newJid: sequentialJids(),
    });
    let error: Error | null = null;
    try {
      await asSidekiqJob(() => handler(args, contextFor(runtime)), golden.now);
    } catch (e) {
      error = e as Error;
    }
    return { sql, error };
  }

  // The generator sets the key per case: absent for "no key configured", empty for "a blank key", the golden key otherwise.
  const keyOf = (c: Case) => (c.name === "no key configured" ? null : c.name === "a blank key" ? "" : golden.key);

  for (const c of golden.cases) {
    it(c.name, async () => {
      const { sql, error } = await run(c, c.args, c.statements, keyOf(c));

      expect(error === null ? null : error.message).toEqual(c.error?.message ?? null);
      expect(sql.log).toEqual(sql.expected);
      expect(requests).toEqual(
        c.http.map((r) => ({
          method: r.method,
          url: r.url.replace(":443", ""),
          contentType: r.headers["Content-Type"],
          body: r.body,
        })),
      );
    });
  }

  for (const [name, args] of HANDED_BACK) {
    it(`hands ${name} back before any statement or request`, async () => {
      const { sql, error } = await run(golden.cases[0]!, args, [], golden.key);

      expect(error?.name).toBe("HandBackToRuby");
      expect(sql.log).toEqual([]);
      expect(requests).toEqual([]);
    });
  }

  it("hands a key URI.join would reject back before any statement or request", async () => {
    const { sql, error } = await run(golden.cases[0]!, [[1]], [], "a key with spaces");

    expect(error?.name).toBe("HandBackToRuby");
    expect(sql.log).toEqual([]);
    expect(requests).toEqual([]);
  });
});
