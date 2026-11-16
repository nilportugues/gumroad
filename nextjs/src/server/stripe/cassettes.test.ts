// Every request to api.stripe.com in the VCR cassettes Rails recorded (spec/support/fixtures/vcr_cassettes), sent again through the
// Node client: the same method, URL and form body, byte for byte. Cassette bodies are the flattened pairs stripe-ruby sent, so a
// request is rebuilt from those pairs and must encode back to the recorded string (this pins CGI.escape, the `[` `]` exemption,
// nil handling and the order of the pairs on thousands of real requests).
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { StripeClient, type HttpMethod, type RequestOptions, type TransportRequest } from "./client.ts";
import { STRIPE_API_VERSION, stripeConfigFromEnv } from "./config.ts";
import type { StripeParams } from "./encode.ts";
import {
  Account,
  AccountLink,
  Balance,
  BalanceTransaction,
  Charge,
  Customer,
  Dispute,
  PaymentIntent,
  PaymentMethod,
  Payout,
  Refund,
  SetupIntent,
  Token,
  Transfer,
} from "./resources.ts";

type Interaction = {
  request: { method: string; uri: string; body?: { string?: string }; headers?: Record<string, string[]> };
};

const CASSETTES = path.join(process.cwd(), "..", "spec", "support", "fixtures", "vcr_cassettes");

function* cassetteFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) yield* cassetteFiles(full);
    else if (entry.endsWith(".yml")) yield full;
  }
}

function stripeRequests(): {
  file: string;
  method: HttpMethod;
  path: string;
  query: string;
  body: string;
  headers: Record<string, string[]>;
}[] {
  const found = [];
  for (const file of cassetteFiles(CASSETTES)) {
    const text = readFileSync(file, "utf8");
    if (!text.includes("https://api.stripe.com/")) continue;
    let cassette: { http_interactions?: Interaction[] } | null;
    try {
      cassette = parse(text, { logLevel: "silent" }) as typeof cassette;
    } catch {
      continue; // a few old cassettes wrap a header value across lines, which YAML 1.2 rejects
    }
    for (const { request } of cassette?.http_interactions ?? []) {
      const url = new URL(request.uri);
      if (url.origin !== "https://api.stripe.com") continue;
      const method = request.method.toLowerCase();
      if (method !== "get" && method !== "post" && method !== "delete") continue;
      found.push({
        file: path.relative(CASSETTES, file),
        method: method as HttpMethod,
        path: url.pathname,
        query: url.search.replace(/^\?/u, ""),
        body: typeof request.body?.string === "string" ? request.body.string : "",
        headers: request.headers ?? {},
      });
    }
  }
  return found;
}

const cgiUnescape = (value: string) => decodeURIComponent(value.replace(/\+/gu, " "));

// A flat `a[b]=c&d=e` string as the ordered pairs it spells, or null when a key repeats (a Map would drop the second).
function pairsOf(encoded: string): Map<string, string> | null {
  const pairs = new Map<string, string>();
  if (encoded === "") return pairs;
  for (const pair of encoded.split("&")) {
    const index = pair.indexOf("=");
    const key = cgiUnescape(index === -1 ? pair : pair.slice(0, index));
    if (pairs.has(key)) return null;
    pairs.set(key, cgiUnescape(index === -1 ? "" : pair.slice(index + 1)));
  }
  return pairs;
}

describe("Stripe requests recorded in the VCR cassettes", () => {
  const requests = stripeRequests();

  it("finds a body of cassettes to check", () => {
    expect(requests.length).toBeGreaterThan(1000);
  });

  it("are re-sent by the Node client with the same method, URL, form data and fixed headers", async () => {
    const mismatches: string[] = [];
    let checked = 0;
    for (const recorded of requests) {
      const encoded = recorded.method === "post" ? recorded.body : recorded.query;
      const params = pairsOf(encoded);
      // VCR's filter_sensitive_data swaps secrets for <PLACEHOLDER>s after encoding, so those bytes are not what was sent.
      if (params === null || /<[A-Z_]+>/u.test(encoded)) continue;
      let sent: TransportRequest | undefined;
      const client = new StripeClient({
        config: { ...stripeConfigFromEnv(), apiKey: "<STRIPE_API_KEY>", apiVersion: STRIPE_API_VERSION },
        transport: async (request) => {
          sent = request;
          return { status: 200, headers: {}, body: "{}" };
        },
      });
      await client.request(recorded.method, recorded.path, params);
      const expectedUrl = `https://api.stripe.com${recorded.path}${recorded.method === "post" ? "" : `?${recorded.query}`}`;
      // VCR drops the `?` the gem puts after the path of a request with no parameters.
      // WebMock normalizes a request URI before VCR records it, which percent-encodes the brackets of a query; a body is stored as sent.
      const sentUrl = sent!.url.replace(/\?$/u, "").replace(/\[/gu, "%5B").replace(/\]/gu, "%5D");
      const expectedBody = recorded.method === "post" ? recorded.body : null;
      const contentType = recorded.headers["Content-Type"]?.[0];
      checked += 1;
      if (
        sent!.method !== recorded.method.toUpperCase() ||
        sentUrl !== expectedUrl.replace(/\?$/u, "") ||
        (sent!.body ?? null) !== expectedBody ||
        (contentType !== undefined && contentType !== sent!.headers["Content-Type"]) ||
        sent!.headers.Authorization !== "Bearer <STRIPE_API_KEY>"
      ) {
        mismatches.push(`${recorded.file}: ${recorded.method} ${recorded.path} sent ${sent!.url} ${sent!.body}`);
      }
    }
    expect(mismatches.slice(0, 10)).toEqual([]);
    expect(checked).toBeGreaterThan(1000);
  }, 300_000);
});

// A route of the resource wrappers in resources.ts: a recorded request must reach the same path through them.
type Dispatch = (match: string[], params: StripeParams, opts: RequestOptions) => Promise<unknown>;

const S = "([^/]+)";
// `retrieve({ id:, **params })`: the retrieve params ride beside the id.
const withId = (id: string, params: StripeParams) => ({
  id,
  ...Object.fromEntries(params instanceof Map ? params : Object.entries(params)),
});
const route = (method: HttpMethod, pattern: string, run: Dispatch) => ({
  method,
  pattern: new RegExp(`^${pattern}$`, "u"),
  run,
});
const ROUTES = [
  route("get", "/v1/account", (_m, _p, o) => Account.retrieve(null, o)),
  route("post", "/v1/accounts", (_m, p, o) => Account.create(p, o)),
  route("get", `/v1/accounts/${S}`, (m, p, o) => Account.retrieve(withId(m[1]!, p), o)),
  route("post", `/v1/accounts/${S}`, (m, p, o) => Account.update(m[1], p, o)),
  route("delete", `/v1/accounts/${S}`, (m, p, o) => Account.delete(m[1], p, o)),
  route("post", `/v1/accounts/${S}/reject`, (m, p, o) => Account.reject(m[1], p, o)),
  route("get", `/v1/accounts/${S}/persons`, (m, p, o) => Account.listPersons(m[1], p, o)),
  route("post", `/v1/accounts/${S}/persons`, (m, p, o) => Account.createPerson(m[1], p, o)),
  route("get", `/v1/accounts/${S}/persons/${S}`, (m, p, o) => Account.retrievePerson(m[1], m[2], p, o)),
  route("post", `/v1/accounts/${S}/persons/${S}`, (m, p, o) => Account.updatePerson(m[1], m[2], p, o)),
  route("delete", `/v1/accounts/${S}/persons/${S}`, (m, p, o) => Account.deletePerson(m[1], m[2], p, o)),
  route("get", `/v1/accounts/${S}/external_accounts`, (m, p, o) => Account.listExternalAccounts(m[1], p, o)),
  route("post", `/v1/accounts/${S}/external_accounts`, (m, p, o) => Account.createExternalAccount(m[1], p, o)),
  route("get", `/v1/accounts/${S}/external_accounts/${S}`, (m, p, o) =>
    Account.retrieveExternalAccount(m[1], m[2], p, o),
  ),
  route("post", `/v1/accounts/${S}/external_accounts/${S}`, (m, p, o) =>
    Account.updateExternalAccount(m[1], m[2], p, o),
  ),
  route("delete", `/v1/accounts/${S}/external_accounts/${S}`, (m, p, o) =>
    Account.deleteExternalAccount(m[1], m[2], p, o),
  ),
  route("post", "/v1/account_links", (_m, p, o) => AccountLink.create(p, o)),
  route("get", "/v1/balance", (_m, p, o) => Balance.retrieve(p, o)),
  route("get", "/v1/balance_transactions", (_m, p, o) => BalanceTransaction.list(p, o)),
  route("get", `/v1/balance_transactions/${S}`, (m, p, o) => BalanceTransaction.retrieve(withId(m[1]!, p), o)),
  route("post", "/v1/payouts", (_m, p, o) => Payout.create(p, o)),
  route("get", "/v1/payouts", (_m, p, o) => Payout.list(p, o)),
  route("get", `/v1/payouts/${S}`, (m, p, o) => Payout.retrieve(withId(m[1]!, p), o)),
  route("post", `/v1/payouts/${S}/cancel`, (m, p, o) => Payout.cancel(m[1], p, o)),
  route("post", "/v1/payment_intents", (_m, p, o) => PaymentIntent.create(p, o)),
  route("get", "/v1/payment_intents", (_m, p, o) => PaymentIntent.list(p, o)),
  route("get", `/v1/payment_intents/${S}`, (m, p, o) => PaymentIntent.retrieve(withId(m[1]!, p), o)),
  route("post", `/v1/payment_intents/${S}`, (m, p, o) => PaymentIntent.update(m[1], p, o)),
  route("post", `/v1/payment_intents/${S}/confirm`, (m, p, o) => PaymentIntent.confirm(m[1], p, o)),
  route("post", `/v1/payment_intents/${S}/capture`, (m, p, o) => PaymentIntent.capture(m[1], p, o)),
  route("post", `/v1/payment_intents/${S}/cancel`, (m, p, o) => PaymentIntent.cancel(m[1], p, o)),
  route("post", "/v1/setup_intents", (_m, p, o) => SetupIntent.create(p, o)),
  route("get", `/v1/setup_intents/${S}`, (m, p, o) => SetupIntent.retrieve(withId(m[1]!, p), o)),
  route("post", `/v1/setup_intents/${S}/confirm`, (m, p, o) => SetupIntent.confirm(m[1], p, o)),
  route("post", `/v1/setup_intents/${S}/cancel`, (m, p, o) => SetupIntent.cancel(m[1], p, o)),
  route("get", "/v1/charges", (_m, p, o) => Charge.list(p, o)),
  route("get", `/v1/charges/${S}`, (m, p, o) => Charge.retrieve(withId(m[1]!, p), o)),
  route("post", `/v1/charges/${S}`, (m, p, o) => Charge.update(m[1], p, o)),
  route("post", `/v1/charges/${S}/capture`, (m, p, o) => Charge.capture(m[1], p, o)),
  route("post", "/v1/refunds", (_m, p, o) => Refund.create(p, o)),
  route("get", `/v1/refunds/${S}`, (m, p, o) => Refund.retrieve(withId(m[1]!, p), o)),
  route("get", `/v1/disputes/${S}`, (m, p, o) => Dispute.retrieve(withId(m[1]!, p), o)),
  route("post", `/v1/disputes/${S}`, (m, p, o) => Dispute.update(m[1], p, o)),
  route("post", `/v1/disputes/${S}/close`, (m, p, o) => Dispute.close(m[1], p, o)),
  route("post", "/v1/customers", (_m, p, o) => Customer.create(p, o)),
  route("get", `/v1/customers/${S}`, (m, p, o) => Customer.retrieve(withId(m[1]!, p), o)),
  route("post", "/v1/payment_methods", (_m, p, o) => PaymentMethod.create(p, o)),
  route("get", "/v1/payment_methods", (_m, p, o) => PaymentMethod.list(p, o)),
  route("get", `/v1/payment_methods/${S}`, (m, p, o) => PaymentMethod.retrieve(withId(m[1]!, p), o)),
  route("post", `/v1/payment_methods/${S}/attach`, (m, p, o) => PaymentMethod.attach(m[1], p, o)),
  route("post", "/v1/tokens", (_m, p, o) => Token.create(p, o)),
  route("get", `/v1/tokens/${S}`, (m, p, o) => Token.retrieve(withId(m[1]!, p), o)),
  route("post", "/v1/transfers", (_m, p, o) => Transfer.create(p, o)),
  route("get", "/v1/transfers", (_m, p, o) => Transfer.list(p, o)),
  route("get", `/v1/transfers/${S}`, (m, p, o) => Transfer.retrieve(withId(m[1]!, p), o)),
  route("post", `/v1/transfers/${S}/reversals`, (m, p, o) => Transfer.createReversal(m[1]!, p, o)),
];

// Wrappers no cassette exercises; resources.test.ts covers their paths.
const UNRECORDED = [
  "delete /v1/accounts/([^/]+)/persons/([^/]+)",
  "get /v1/payment_intents",
  "post /v1/accounts/([^/]+)/external_accounts/([^/]+)",
  "post /v1/accounts/([^/]+)/reject",
  "post /v1/charges/([^/]+)",
  "post /v1/charges/([^/]+)/capture",
  "post /v1/disputes/([^/]+)/close",
  "post /v1/payment_intents/([^/]+)/capture",
  "post /v1/payment_methods/([^/]+)/attach",
  "post /v1/payouts/([^/]+)/cancel",
];

describe("Stripe resource wrappers against the VCR cassettes", () => {
  const requests = stripeRequests();

  it("send every recorded request of a ported resource to the recorded method and path", async () => {
    const mismatches: string[] = [];
    const exercised = new Set<RegExp>();
    for (const recorded of requests) {
      const found = ROUTES.find(
        (candidate) => candidate.method === recorded.method && candidate.pattern.test(recorded.path),
      );
      const encoded = recorded.method === "post" ? recorded.body : recorded.query;
      const params = pairsOf(encoded);
      if (!found || params === null || /<[A-Z_]+>/u.test(encoded)) continue;
      let sent: TransportRequest | undefined;
      const client = new StripeClient({
        config: { ...stripeConfigFromEnv(), apiKey: "<STRIPE_API_KEY>", apiVersion: STRIPE_API_VERSION },
        transport: async (request) => {
          sent = request;
          return { status: 200, headers: {}, body: "{}" };
        },
      });
      await found.run(found.pattern.exec(recorded.path)!.map(cgiUnescape), params, { client });
      exercised.add(found.pattern);
      const url = new URL(sent!.url);
      const sentQuery = url.search.replace(/^\?/u, "").replace(/%5B/giu, "[").replace(/%5D/giu, "]");
      const expectedQuery = recorded.query.replace(/%5B/giu, "[").replace(/%5D/giu, "]");
      if (
        sent!.method !== recorded.method.toUpperCase() ||
        url.pathname !== recorded.path ||
        (recorded.method !== "post" && sentQuery !== expectedQuery) ||
        (sent!.body ?? "") !== (recorded.method === "post" ? recorded.body : "")
      ) {
        mismatches.push(
          `${recorded.file}: ${recorded.method} ${recorded.path} sent ${sent!.method} ${sent!.url} ${sent!.body}`,
        );
      }
    }
    expect(mismatches.slice(0, 10)).toEqual([]);
    const unexercised = ROUTES.filter((candidate) => !exercised.has(candidate.pattern)).map(
      (candidate) => `${candidate.method} ${candidate.pattern.source.slice(1, -1).replaceAll("\\/", "/")}`,
    );
    expect(unexercised.sort()).toEqual([...UNRECORDED].sort());
  }, 300_000);
});
