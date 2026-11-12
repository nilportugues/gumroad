// Replays __fixtures__/stripe-requests.golden.json: the same calls, against a local server giving
// the same answers, must send the requests the stripe gem sent and return or raise what it did.
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { rubyInspect, RubySymbol } from "../models/concerns/ruby-values.ts";

import { StripeClient, sleepTime } from "./client.ts";
import { STRIPE_API_VERSION, stripeConfigFromEnv, type StripeConfig } from "./config.ts";
import { urlEncode } from "./encode.ts";
import { StripeError } from "./errors.ts";
import { Account, ApplePayDomain, Balance, Payout, Transfer } from "./resources.ts";

type Recorded = {
  method: string;
  path: string;
  query: string | null;
  headers: Record<string, string>;
  body: string | null;
};
type GoldenCase = {
  name: string;
  responses?: [number | "drop", Record<string, string>, string][];
  requests?: Recorded[];
  retries: number;
  result?: unknown;
  error?: {
    class: string;
    message: string;
    to_s: string;
    code: string | null;
    http_status: number | null;
    request_id: string | null;
    param: string | null;
  };
  api_base_port?: number;
};
const golden = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, "__fixtures__/stripe-requests.golden.json"), "utf8"),
) as {
  api_base: string;
  sleep_time: { retries: number; samples: [number, number] }[];
  cases: GoldenCase[];
};

type Opts = { client: StripeClient };
const CALLS: Record<string, (o: Opts) => Promise<unknown>> = {
  "account retrieve": (o) => Account.retrieve("acct_1", o),
  "account retrieve escapes the id": (o) => Account.retrieve("acct_ 1/x", o),
  "account update business profile url": (o) =>
    Account.update("acct_1", { business_profile: { url: "https://new.gumroad.com" } }, o),
  "account update lifts the charges pause": (o) =>
    Account.update("acct_1", { risk_controls: { charges: { pause_requested: false } } }, o),
  "payout retrieve expanded on a connected account": (o) =>
    Payout.retrieve({ id: "po_1", expand: ["balance_transaction"] }, { ...o, stripeAccount: "acct_1" }),
  "payout retrieve on a connected account": (o) => Payout.retrieve("po_1", { ...o, stripeAccount: "acct_1" }),
  "balance retrieve on a connected account": (o) => Balance.retrieve({ ...o, stripeAccount: "acct_1" }),
  "transfer create on a connected account": (o) =>
    Transfer.create({ amount: 1234, currency: "usd", destination: "acct_platform" }, { ...o, stripeAccount: "acct_1" }),
  "transfer retrieve": (o) => Transfer.retrieve("tr_1", o),
  "transfer list drops nil params": (o) =>
    Transfer.list({ destination: "acct_1", created: { lt: 1_700_000_000 }, limit: 100, starting_after: null }, o),
  "transfer list pages": (o) =>
    Transfer.list({ destination: "acct_1", created: { lt: 1_700_000_000 }, limit: 100, starting_after: "tr_2" }, o),
  "transfer reversal": (o) => Transfer.createReversal("tr_1", { amount: 500 }, o),
  "apple pay domain create": (o) => ApplePayDomain.create({ domain_name: "seller.gumroad.com" }, o),
  "apple pay domain retrieve": (o) => ApplePayDomain.retrieve("apwc_1", o),
  "apple pay domain delete": (o) => ApplePayDomain.delete("apwc_1", {}, o),
  "form encoding edge cases": (o) =>
    Account.update(
      "acct_1",
      {
        metadata: {
          "a b": "x&y=z+ü*~!'()",
          skipped: null,
          t: true,
          f: false,
          n: 12,
          neg: -3,
          float: 1.5,
          sym: new RubySymbol("value"),
        },
        individual: { address: { line1: "", line2: "Apt. #4 [rear]" } },
        list: ["a", { k: "v" }, ["x", "y"], null],
        empty_hash: {},
        empty_list: [],
      },
      { ...o, idempotencyKey: "idem-fixed", stripeAccount: "acct_9" },
    ),
  "post with no params": (o) => Account.update("acct_1", {}, o),
  "telemetry of the previous request": async (o) => {
    await Transfer.retrieve("tr_1", o);
    return Transfer.retrieve("tr_2", o);
  },
  "400 invalid request is not retried": (o) => Account.retrieve("acct_missing", o),
  "404 invalid request": (o) => Transfer.retrieve("tr_missing", o),
  "403 permission error": (o) => Account.update("acct_1", { business_profile: { url: "x" } }, o),
  "401 authentication error": (o) => Balance.retrieve({ ...o, stripeAccount: "acct_1" }),
  "402 card error": (o) => Transfer.create({ amount: 1, currency: "usd", destination: "acct_2" }, o),
  "400 idempotency error": (o) => Transfer.create({ amount: 1, currency: "usd", destination: "acct_2" }, o),
  "429 lock timeout is retried with the same idempotency key": (o) =>
    Transfer.create({ amount: 1, currency: "usd", destination: "acct_2" }, o),
  "429 rate limit is not retried": (o) => Account.retrieve("acct_1", o),
  "409 conflict is retried": (o) => Account.retrieve("acct_1", o),
  "500 is retried until max_network_retries": (o) => Account.retrieve("acct_1", o),
  "payout create is sent four times under one idempotency key when Stripe answers 500": (o) => payoutCreate(o, true),
  "payout create is sent four times under one idempotency key when the connection drops": (o) => payoutCreate(o, true),
  "payout create succeeds on the third attempt after two drops, keeping its key": (o) => payoutCreate(o, false),
  "payout create 429 rate limit is not retried": (o) => payoutCreate(o, false),
  "transfer create 500 is retried under one idempotency key": (o) =>
    Transfer.create({ amount: 1234, currency: "usd", destination: "acct_1" }, o),
  "transfer reversal is sent four times when the connection drops": (o) =>
    Transfer.createReversal("tr_1", { amount: 500 }, o),
  "stripe-should-retry false stops a 500 retry": (o) => Account.retrieve("acct_1", o),
  "stripe-should-retry true retries a 400": (o) => Account.retrieve("acct_1", o),
  "unparseable body": (o) => Account.retrieve("acct_1", o),
  "error body without an error key": (o) => Account.retrieve("acct_1", o),
  "oauth error": (o) => Account.retrieve("acct_1", o),
  "connection refused": (o) => Account.retrieve("acct_1", o),
};

const payoutCreate = (o: Opts, instant: boolean) =>
  Payout.create(
    { amount: 1234, currency: "usd", ...(instant ? { method: "instant" } : {}) },
    { ...o, stripeAccount: "acct_1" },
  );

// The headers that carry meaning; User-Agent and X-Stripe-Client-User-Agent describe the
// bindings and differ by design. Idempotency keys are random, so they compare by identity.
const COMPARED_HEADERS = [
  "authorization",
  "content-type",
  "stripe-version",
  "stripe-account",
  "idempotency-key",
  "x-stripe-client-telemetry",
  "accept",
  "accept-encoding",
  "content-length",
];

function normalize(requests: Recorded[]) {
  const keys = new Map<string, string>();
  return requests.map((request) => {
    const headers: Record<string, string> = {};
    for (const name of COMPARED_HEADERS) {
      let value = request.headers[name];
      if (value === undefined) continue;
      if (
        name === "idempotency-key" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)
      ) {
        if (!keys.has(value)) keys.set(value, `<uuid ${keys.size + 1}>`);
        value = keys.get(value)!;
      }
      if (name === "x-stripe-client-telemetry") {
        const parsed = JSON.parse(value) as { last_request_metrics: { request_duration_ms: number } };
        expect(Number.isInteger(parsed.last_request_metrics.request_duration_ms)).toBe(true);
        parsed.last_request_metrics.request_duration_ms = 0;
        value = JSON.stringify(parsed);
      }
      headers[name] = value;
    }
    return { method: request.method, path: request.path, query: request.query, body: request.body, headers };
  });
}

let server: http.Server;
let port: number;
const recorded: Recorded[] = [];
let script: [number, Record<string, string>, string][] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const [pathname, ...rest] = (req.url ?? "").split("?");
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(req.headers)) if (typeof value === "string") headers[name] = value;
      recorded.push({
        method: req.method!,
        path: pathname!,
        query: rest.length ? rest.join("?") : null,
        headers,
        body: req.headers["content-length"] ? Buffer.concat(chunks).toString("utf8") : null,
      });
      const [status, responseHeaders, body] = script.shift() ?? [500, {}, "no scripted response"];
      if (status === "drop") return void req.socket.destroy();
      res.writeHead(status, { ...responseHeaders, "Content-Length": Buffer.byteLength(body) });
      res.end(body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as net.AddressInfo).port;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

function config(apiBase: string): StripeConfig {
  return {
    ...stripeConfigFromEnv(),
    apiKey: "sk_test_golden",
    apiBase,
    apiVersion: "2023-10-16; risk_in_requirements_beta=v1; retrieve_tax_forms_beta=v1;",
  };
}

describe("requests match stripe-ruby 12.5.0", () => {
  it.each(golden.cases.map((c) => [c.name, c] as const))("%s", async (name, c) => {
    const call = CALLS[name];
    expect(call, `no Node call for golden case ${name}`).toBeDefined();
    recorded.length = 0;
    script = (c.responses ?? []).map(([status, headers, body]) => [status, { ...headers }, body]);
    const sleeps: number[] = [];
    const apiBase = c.api_base_port === undefined ? `http://127.0.0.1:${port}` : `http://127.0.0.1:${c.api_base_port}`;
    if (c.api_base_port !== undefined) {
      // Ruby's port was free when it ran; find one that is free now and expect it in the message.
      const probe = net.createServer();
      await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
      const freePort = (probe.address() as net.AddressInfo).port;
      await new Promise<void>((resolve) => probe.close(() => resolve()));
      c = JSON.parse(JSON.stringify(c).replaceAll(String(c.api_base_port), String(freePort))) as GoldenCase;
    }
    const base = c.api_base_port === undefined ? apiBase : `http://127.0.0.1:${c.api_base_port}`;
    const client = new StripeClient({ config: config(base), sleep: async (s) => void sleeps.push(s) });

    let outcome: { result?: unknown; error?: unknown };
    try {
      outcome = { result: await call!({ client }) };
    } catch (error) {
      if (!(error instanceof StripeError)) throw error;
      outcome = {
        error: {
          class: error.rubyClass,
          message: error.message,
          to_s: error.toString(),
          code: error.code,
          http_status: error.httpStatus,
          request_id: error.requestId,
          param: "param" in error ? error.param : null,
        },
      };
    }
    if (c.requests) expect(normalize(recorded)).toEqual(normalize(c.requests));
    expect(sleeps.length).toBe(c.retries);
    // The gem's messages name the port its own server listened on.
    if (c.error) {
      const fix = (text: string) => text.replaceAll(golden.api_base, base);
      c = { ...c, error: { ...c.error, message: fix(c.error.message), to_s: fix(c.error.to_s) } };
    }
    if (name === "connection refused") {
      // Net::HTTP's wording for ECONNREFUSED, reproduced from the errno.
      expect(outcome.error).toEqual(c.error);
    } else {
      expect(outcome).toEqual(c.error ? { error: c.error } : { result: c.result });
    }
  });
});

describe("retry backoff", () => {
  it.each(golden.sleep_time.map((s) => [s.retries, s] as const))(
    "stays within the gem's range after %i retries",
    (retries, s) => {
      const cfg = config("http://x");
      const [min, max] = [sleepTime(retries, cfg, () => 0), sleepTime(retries, cfg, () => 0.999999)];
      expect(min).toBeLessThanOrEqual(s.samples[0] + 1e-9);
      expect(max).toBeGreaterThanOrEqual(s.samples[1] - 1e-3);
      expect(max).toBeLessThanOrEqual(cfg.maxNetworkRetryDelay);
    },
  );
});

describe("configuration", () => {
  it("sends the plain API version in the test environment and the beta flags elsewhere", () => {
    const previous = process.env.RAILS_ENV;
    try {
      process.env.RAILS_ENV = "test";
      expect(stripeConfigFromEnv().apiVersion).toBe(STRIPE_API_VERSION);
      process.env.RAILS_ENV = "production";
      expect(stripeConfigFromEnv().apiVersion).toBe(
        "2023-10-16; risk_in_requirements_beta=v1; retrieve_tax_forms_beta=v1;",
      );
    } finally {
      process.env.RAILS_ENV = previous;
    }
  });

  it("refuses to send a request without an API key, as the gem does", async () => {
    const client = new StripeClient({ config: { ...config("http://127.0.0.1:1"), apiKey: undefined } });
    await expect(Account.retrieve("acct_1", { client })).rejects.toThrow(/No API key provided/u);
  });

  it("escapes as CGI.escape and quotes as String#inspect", () => {
    expect(urlEncode("a b[c]*")).toBe("a+b[c]%2A");
    expect(rubyInspect('a"b\\c\n#{x}')).toBe('"a\\"b\\\\c\\n\\#{x}"');
  });
});
