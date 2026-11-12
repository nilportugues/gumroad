// Drives the Node Stripe client through the Stripe calls of every case of purchase-paid-order.golden.json (the real POST /orders,
// Stripe answered by WebMock) and compares what it puts on the wire with what stripe-ruby 12.5.0 sent: the same attempts, in the same
// order, under the same idempotency key, with the same headers and bodies. The calls are the recorded ones, not the checkout's own
// code, so this pins the client's behaviour (4 attempts per call on a 5xx or a dropped connection, 1 on a 429) on the paid-order timeline.
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { parseRubyJson } from "../jobs/sidekiq/ruby-json.ts";
import { parseForm } from "../models/__fixtures__/stripe-paid-order-fake.ts";

import { NetworkError, StripeClient, type TransportRequest, type TransportResponse } from "./client.ts";
import { STRIPE_API_VERSION, stripeConfigFromEnv } from "./config.ts";
import { APIConnectionError, CardError, RateLimitError } from "./errors.ts";
import { PaymentIntent, PaymentMethod, Charge } from "./resources.ts";

type Attempt = {
  method: string;
  path: string;
  query: string | null;
  body: string | null;
  status?: number;
  raised?: string;
};
type Sent = { method: string; url: string; headers: Record<string, string>; body: string | null };
type Case = { name: string; statements: { http?: Attempt }[]; http: Sent[] };

const here = import.meta.dirname;
const golden = parseRubyJson(
  readFileSync(path.join(here, "../models/__fixtures__/purchase-paid-order.golden.json"), "utf8"),
) as unknown as { cases: Case[] };
const decline = readFileSync(path.join(here, "../../../scripts/golden/support/stripe_paid_order/decline.json"), "utf8");

// A retry follows an attempt that was lost or answered 5xx; anything else ends the logical call.
const retried = (attempt: Attempt) => attempt.raised !== undefined || (attempt.status ?? 0) >= 500;

function logicalCalls(c: Case): Attempt[][] {
  const calls: Attempt[][] = [];
  let open = false;
  for (const attempt of c.statements.flatMap((entry) => (entry.http ? [entry.http] : []))) {
    if (attempt.path.startsWith("/v2/")) continue; // TaxJar is not Stripe
    if (open) calls.at(-1)!.push(attempt);
    else calls.push([attempt]);
    open = retried(attempt);
  }
  return calls;
}

const PAYMENT_METHOD_ID = /^\/v1\/payment_methods\/([^/]+)$/u;
const CONFIRM = /^\/v1\/payment_intents\/([^/]+)\/confirm$/u;
const INTENT = /^\/v1\/payment_intents\/([^/]+)$/u;
const CHARGE = /^\/v1\/charges\/([^/]+)$/u;

function send(client: StripeClient, first: Attempt) {
  if (first.method === "GET" && PAYMENT_METHOD_ID.test(first.path))
    return PaymentMethod.retrieve(PAYMENT_METHOD_ID.exec(first.path)![1]!, { client });
  if (first.method === "GET" && INTENT.test(first.path))
    return PaymentIntent.retrieve(INTENT.exec(first.path)![1]!, { client });
  if (first.method === "GET" && CHARGE.test(first.path))
    return Charge.retrieve(
      { id: CHARGE.exec(first.path)![1]!, expand: ["balance_transaction", "application_fee.balance_transaction"] },
      { client },
    );
  if (first.method === "POST" && CONFIRM.test(first.path))
    return PaymentIntent.confirm(CONFIRM.exec(first.path)![1], {}, { client });
  if (first.method === "POST" && first.path === "/v1/payment_intents")
    return PaymentIntent.create(parseForm(first.body) as never, { client });
  throw new Error(`no resource call for ${first.method} ${first.path}`);
}

// WebMock records a request normalised: no default port, no bare `?`, `expand[0]=` as `expand[]=` and the pairs sorted.
function wire(method: string, url: string): string {
  const parsed = new URL(url);
  const query = decodeURIComponent(parsed.search.slice(1))
    .replaceAll(/\[\d+\]/gu, "[]")
    .split("&")
    .sort()
    .join("&");
  return `${method} ${parsed.origin}${parsed.pathname}${query === "" ? "" : `?${query}`}`;
}

// The headers that carry meaning; the bindings' own User-Agents differ by design, the key by identity.
const COMPARED = ["Accept", "Accept-Encoding", "Content-Type", "Stripe-Version", "Stripe-Account"];

function answer(attempt: Attempt): TransportResponse {
  if (attempt.raised !== undefined) throw new NetworkError("read_timeout", attempt.raised);
  const status = attempt.status!;
  return { status, headers: {}, body: status === 402 ? decline : JSON.stringify({ id: "obj_1", object: "object" }) };
}

async function replay(c: Case) {
  const sent: TransportRequest[] = [];
  const calls = logicalCalls(c);
  const attempts = calls.flat();
  const client = new StripeClient({
    config: { ...stripeConfigFromEnv(), apiKey: "sk_test_replay", apiVersion: STRIPE_API_VERSION },
    sleep: () => Promise.resolve(),
    transport: (request) => {
      sent.push(request);
      return Promise.resolve(answer(attempts[sent.length - 1]!));
    },
  });
  const outcomes: unknown[] = [];
  for (const call of calls) outcomes.push(await send(client, call[0]!).catch((error: unknown) => error));
  return { sent, calls, outcomes };
}

describe("the Stripe client on the timeline of purchase-paid-order.golden.json", () => {
  for (const c of golden.cases) {
    it(`sends what stripe-ruby sent for ${c.name}`, async () => {
      const { sent, calls } = await replay(c);
      const recorded = c.http.filter((request) => request.url.includes("api.stripe.com"));
      expect(sent).toHaveLength(recorded.length);
      expect(sent.map((request) => wire(request.method, request.url))).toEqual(
        recorded.map((request) => wire(request.method, request.url)),
      );
      expect(sent.map((request) => request.body)).toEqual(recorded.map((request) => request.body));
      sent.forEach((request, i) => {
        for (const name of COMPARED) expect(request.headers[name]).toEqual(recorded[i]!.headers[name]);
        expect(Object.keys(request.headers).includes("Idempotency-Key")).toBe(recorded[i]!.method === "POST");
      });
      // One key per logical call, shared by its attempts and by no other call.
      const keysOfCalls = calls.map((call, n) => {
        const first = calls.slice(0, n).reduce((count, previous) => count + previous.length, 0);
        return new Set(sent.slice(first, first + call.length).map((request) => request.headers["Idempotency-Key"]));
      });
      keysOfCalls.forEach((keys) => expect(keys.size).toBe(1));
      const posts = keysOfCalls.filter((_, n) => calls[n]![0]!.method === "POST").map((keys) => [...keys][0]);
      expect(new Set(posts).size).toBe(posts.length);
    });
  }

  it("gives up with APIConnectionError after four attempts when every answer of the intent create is lost", async () => {
    const c = golden.cases.find((candidate) => candidate.name === "the PaymentIntent create loses every answer")!;
    const { calls, outcomes } = await replay(c);
    const create = calls.findIndex((call) => call[0]!.path === "/v1/payment_intents");
    expect(calls[create]).toHaveLength(4);
    expect(outcomes[create]).toBeInstanceOf(APIConnectionError);
    expect((outcomes[create] as Error).message).toContain("Request was retried 3 times.");
  });

  it("goes on with the answer of the second attempt when only the first confirm answer is lost", async () => {
    const c = golden.cases.find((candidate) => candidate.name === "the confirm loses its first answer")!;
    const { calls, outcomes } = await replay(c);
    const confirm = calls.findIndex((call) => call[0]!.path.endsWith("/confirm"));
    expect(calls[confirm]).toHaveLength(2);
    expect(outcomes[confirm]).toEqual({ id: "obj_1", object: "object" });
  });

  it("raises a CardError at once for a declined confirm, without a retry", async () => {
    const { calls, outcomes } = await replay(golden.cases.find((candidate) => candidate.name === "a declined card")!);
    const confirm = calls.findIndex((call) => call[0]!.path.endsWith("/confirm"));
    expect(calls[confirm]).toHaveLength(1);
    expect(outcomes[confirm]).toBeInstanceOf(CardError);
  });

  it("sends a 429 once and raises RateLimitError", async () => {
    const sent: TransportRequest[] = [];
    const client = new StripeClient({
      config: { ...stripeConfigFromEnv(), apiKey: "sk_test_replay", apiVersion: STRIPE_API_VERSION },
      sleep: () => Promise.resolve(),
      transport: (request) => {
        sent.push(request);
        return Promise.resolve({
          status: 429,
          headers: {},
          body: JSON.stringify({ error: { type: "rate_limit_error", message: "Too many requests" } }),
        });
      },
    });
    await expect(PaymentIntent.create({ amount: 500, currency: "usd" }, { client })).rejects.toBeInstanceOf(
      RateLimitError,
    );
    expect(sent).toHaveLength(1);
  });
});
