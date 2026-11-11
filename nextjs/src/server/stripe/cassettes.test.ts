// Every request to api.stripe.com in the VCR cassettes Rails recorded (spec/support/fixtures/vcr_cassettes), sent again through the
// Node client: the same method, URL and form body, byte for byte. Cassette bodies are the flattened pairs stripe-ruby sent, so a
// request is rebuilt from those pairs and must encode back to the recorded string (this pins CGI.escape, the `[` `]` exemption,
// nil handling and the order of the pairs on thousands of real requests).
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { StripeClient, type HttpMethod, type TransportRequest } from "./client.ts";
import { STRIPE_API_VERSION, stripeConfigFromEnv } from "./config.ts";

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
