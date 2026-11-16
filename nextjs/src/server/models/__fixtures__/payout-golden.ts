// Replays a golden recorded by scripts/golden/payouts-*.rb: the real Ruby models ran against a scratch database with Stripe answered by
// WebMock. A case here runs the Node port with the same rows answered statement by statement and the same Stripe answers in order,
// and the test compares what Node sent: the SQL, the Stripe requests (method, path, the Stripe-Account and Idempotency-Key headers,
// body) and how many statements preceded each request, which is what holds the order of writes against calls.
import { readFileSync } from "node:fs";

import {
  recordingSidekiqRedis,
  rubyRuntimeRegistry,
  sequentialJids,
} from "../../../worker/jobs/__fixtures__/golden.ts";
import { sqlReplay, type Statement } from "../../../worker/jobs/__fixtures__/sql-replay.ts";
import { createJobsRuntime } from "../../jobs/runtime.ts";
import { parseRubyJson } from "../../jobs/sidekiq/ruby-json.ts";
import { esRecorder } from "../../search/__fixtures__/job-harness.ts";
import { NetworkError, StripeClient, setStripeClientForTesting, type TransportRequest } from "../../stripe/client.ts";
import { stripeConfigFromEnv } from "../../stripe/config.ts";
import { withJobsRuntime } from "../concerns/job-runtime.ts";
import { resetLinkCollaborators, setLinkCollaborators } from "../link.ts";
import { setSellerProfileCacheForTesting } from "../seller-profile.ts";
import { resetUserCollaborators, setUserCollaborators } from "../user.ts";

export type StripeCall = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
  after_statement?: number;
  response?: { dropped: boolean };
};
export type GoldenStripeAnswer = {
  status?: number;
  body?: string;
  headers?: Record<string, string>;
  dropped?: boolean;
};
export type GoldenCase = {
  name: string;
  statements: Statement[];
  error: { class: string; message: string } | null;
  redis: Record<string, unknown>;
  cache: [string, string][];
  http: StripeCall[];
  http_responses?: GoldenStripeAnswer[];
};
export type Golden = { now: number; cases: GoldenCase[] };

export const loadGolden = (file: URL): Golden => parseRubyJson(readFileSync(file, "utf8")) as unknown as Golden;

const API_BASE = "https://api.stripe.com";

// WebMock rewrites the query it hands the hook (`expand[0]=` as `expand[]=`, percent-encoded, no bare `?`); the gem's own bytes are
// pinned by stripe-requests.golden.json, so both sides are compared in that normal form.
const normalizeUrl = (url: string) =>
  decodeURIComponent(url.replace(`${API_BASE}:443`, "").replace(API_BASE, ""))
    .replace(/\[\d+\]/gu, "[]")
    .replace(/\?$/u, "");

// What a test compares: the call as the gem's WebMock hook saw it, or as Node's transport got it.
export function normalizeCall(call: {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
}) {
  const headers: Record<string, string> = {};
  for (const name of ["Stripe-Account", "Idempotency-Key"]) {
    const key = Object.keys(call.headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
    if (key !== undefined) headers[name] = call.headers[key]!;
  }
  return {
    method: call.method,
    url: normalizeUrl(call.url),
    headers,
    body: call.body ?? "",
  };
}

export type Replay = {
  sqlLog: string[];
  expectedSql: string[];
  error: unknown;
  calls: ReturnType<typeof normalizeCall>[];
  statementsBeforeCall: number[];
  cache: [string, string][];
  redis: unknown;
};

// ActiveJob mints a random job_id; everything else in an enqueued item is compared as recorded.
export const withoutJobIds = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value).replace(/\\"job_id\\":\\"[0-9a-f-]{36}\\"/gu, '\\"job_id\\":\\"<uuid>\\"'));

// Runs `action` inside the case's world. The Idempotency-Key the client generates is random, so it is numbered by first appearance as
// the golden's was.
export async function replayCase(golden: Golden, c: GoldenCase, action: () => Promise<unknown>): Promise<Replay> {
  const sql = sqlReplay(c.statements);
  const recording = recordingSidekiqRedis();
  const runtime = createJobsRuntime({
    sidekiqRedis: recording.redis,
    bullmqRedis: recording.redis,
    registry: rubyRuntimeRegistry(),
    now: () => golden.now,
    newJid: sequentialJids(),
  });
  const now = () => new Date(Math.round(golden.now * 1000));
  const cache: [string, string][] = [];
  setSellerProfileCacheForTesting({ delete: (name) => Promise.resolve(void cache.push(["cache_delete", name])) });
  setUserCollaborators({ now });
  setLinkCollaborators({
    isFeatureEnabled: () => Promise.resolve(false),
    redis: () => {
      throw new Error("unexpected $redis read");
    },
    cacheDelete: (name) => Promise.resolve(void cache.push(["cache_delete", name])),
  });

  const answers = [...(c.http_responses ?? [])];
  const calls: Replay["calls"] = [];
  const statementsBeforeCall: number[] = [];
  const keys: string[] = [];
  const client = new StripeClient({
    config: { ...stripeConfigFromEnv(), apiKey: "sk_test_replay" },
    sleep: () => Promise.resolve(),
    random: () => 0,
    transport: (request: TransportRequest) => {
      const call = normalizeCall(request);
      const key = call.headers["Idempotency-Key"];
      if (key !== undefined) {
        if (!keys.includes(key)) keys.push(key);
        call.headers["Idempotency-Key"] = `key-${keys.indexOf(key) + 1}`;
      }
      calls.push(call);
      statementsBeforeCall.push(sql.log.length);
      const answer = answers.shift() ?? {};
      if (answer.dropped) return Promise.reject(new NetworkError("connection", "Connection reset by peer"));
      return Promise.resolve({
        status: answer.status ?? 200,
        headers: answer.headers ?? {},
        body: answer.body ?? "{}",
      });
    },
  });
  setStripeClientForTesting(client);

  const es = esRecorder();
  let error: unknown = null;
  try {
    await withJobsRuntime(runtime, action);
  } catch (e) {
    error = e;
  } finally {
    es.restore();
    setStripeClientForTesting(undefined);
    resetUserCollaborators();
    resetLinkCollaborators();
  }
  return {
    sqlLog: sql.log,
    expectedSql: sql.expected,
    error,
    calls,
    statementsBeforeCall,
    cache,
    redis: withoutJobIds(recording.snapshot()),
  };
}

// The calls the golden recorded, in the same shape. A dropped answer is recorded once per attempt by the gem, as it is by Node's client.
export const goldenCalls = (c: GoldenCase) => c.http.map((call) => normalizeCall(call));
export const goldenStatementsBeforeCall = (c: GoldenCase) => c.http.map((call) => call.after_statement);
