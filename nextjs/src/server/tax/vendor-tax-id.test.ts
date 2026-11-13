import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createRailsCache } from "../cache/rails-cache.ts";
import { createMemoryTransport } from "../cache/transport.ts";

import { REQUEST_TIMEOUT_MS, validateVendorTaxId, type VendorTaxIdService } from "./vendor-tax-id.ts";

// Recorded by scripts/golden/tax-id-vendors.rb: the real IRAS, Revenu Quebec and taxid.pro services called twice in a row against a
// WebMock stand-in, with the URL string HTTParty was handed, its options, the stand-in's requests and the cache keys written.
type Answer = { status?: number; body?: string; headers?: Record<string, string>; dropped?: boolean };
type GoldenCase = {
  name: string;
  service: string;
  args: (string | number | null)[];
  http_responses: Answer[];
  results: { value?: boolean | string | null; raised?: string }[];
  http: { method: string; body: string | null }[];
  httparty: {
    verb: string;
    url: string;
    options: { timeout: number; headers?: Record<string, string>; body?: string };
  }[];
  cache: [string, string][];
};
const golden = JSON.parse(
  readFileSync(new URL("./__fixtures__/tax-id-vendors.golden.json", import.meta.url), "utf8"),
) as GoldenCase[];
const PORTED: readonly string[] = ["GstValidationService", "QstValidationService", "TaxIdValidationService"];
const cases = golden.filter((entry) => PORTED.includes(entry.service));

// RegionalVatIdValidationService rescues these two of the recorded errors and answers false.
const RESCUED = ["Errno::ECONNRESET", "JSON::ParserError"];

beforeEach(() => {
  vi.stubEnv("RAILS_ENV", "test");
  vi.stubEnv("IRAS_ENDPOINT", "");
  vi.stubEnv("REVENU_QUEBEC_ENDPOINT", "");
  vi.stubEnv("TAX_ID_PRO_ENDPOINT", "");
  vi.stubEnv("IRAS_API_ID", "iras-id");
  vi.stubEnv("IRAS_API_SECRET", "iras-secret");
  vi.stubEnv("TAX_ID_PRO_API_KEY", "taxid-key");
});
afterEach(() => vi.unstubAllEnvs());

type Sent = {
  url: string;
  method: string;
  headers: Record<string, string> | undefined;
  body: string | undefined;
  signal: boolean;
};

function stand(answers: Answer[]) {
  const queue = [...answers];
  const sent: Sent[] = [];
  const fetcher = vi.fn((url: string | URL | Request, init?: RequestInit) => {
    sent.push({
      url: String(url),
      method: init?.method ?? "GET",
      headers: init?.headers as Record<string, string> | undefined,
      body: init?.body as string | undefined,
      signal: init?.signal instanceof AbortSignal,
    });
    // HttpCapture answers 200 {} once the case's answers run out.
    const answer = queue.shift() ?? {};
    if (answer.dropped) return Promise.reject(new TypeError("fetch failed"));
    const status = answer.status ?? 200;
    return Promise.resolve(
      new Response(status === 204 ? null : (answer.body ?? "{}"), { status, headers: answer.headers ?? {} }),
    );
  });
  return { fetcher: fetcher as unknown as typeof fetch, sent };
}

const truthy = (value: unknown) => value !== null && value !== undefined && value !== false;
// An is_valid that is neither a boolean nor null is Rails' to answer: Node would have to cache the raw JSON value.
const exotic = (value: unknown) =>
  value !== null && value !== undefined && typeof value !== "boolean" && value !== "is_valid";

describe("IRAS, Revenu Quebec and taxid.pro against the Ruby golden", () => {
  it("records every case twice, with the stand-in's calls", () => {
    expect(cases.length).toBeGreaterThan(120);
    expect(cases.every((entry) => entry.results.length === 2)).toBe(true);
  });

  it.each(cases.map((entry) => [`${entry.service.slice(0, 3)} ${entry.name}`, entry] as const))(
    "%s",
    async (_name, entry) => {
      const { fetcher, sent } = stand(entry.http_responses);
      const cache = createRailsCache({ transport: createMemoryTransport(), namespace: null });
      const [taxId, countryCode] = entry.args as [string | null, string | undefined];
      // Ruby reads NaN where JSON.parse fails.
      const handedBack =
        entry.results.some((result) => exotic(result.value)) || entry.name === "GST with a NaN inside the JSON";
      const outcomes = [];
      for (const _ of entry.results) {
        outcomes.push(
          await validateVendorTaxId(entry.service as VendorTaxIdService, taxId, countryCode, { fetch: fetcher, cache }),
        );
      }

      // Nothing is cached for a hand-back, so the repeat calls the vendor again (and meets the default answer).
      if (handedBack) {
        expect(outcomes[0]).toEqual({ kind: "unsupported", reason: expect.any(String) as string });
        expect(sent).toHaveLength(2);
        expect(sent[0]!.url).toBe(entry.httparty[0]!.url);
        return;
      }

      expect(outcomes).toEqual(
        entry.results.map((result) =>
          result.raised === undefined
            ? { kind: "valid", valid: truthy(result.value) }
            : RESCUED.includes(result.raised)
              ? { kind: "valid", valid: false }
              : { kind: "unsupported", reason: expect.any(String) as string },
        ),
      );

      // The same calls, in order: URL as HTTParty was handed it, verb, headers, body, and a timeout.
      expect(sent.map(({ url, method }) => [url, method.toLowerCase()])).toEqual(
        entry.httparty.map(({ url, verb }) => [url, verb]),
      );
      expect(sent.map(({ headers }) => headers)).toEqual(entry.httparty.map(({ options }) => options.headers));
      expect(sent.map(({ body }) => body)).toEqual(entry.httparty.map(({ options }) => options.body));
      expect(entry.httparty.every(({ options }) => options.timeout * 1000 === REQUEST_TIMEOUT_MS)).toBe(true);
      expect(sent.every(({ signal }) => signal)).toBe(true);

      // The ten-minute memo: the key Ruby writes holds the answer, and a repeat inside it calls nobody.
      for (const [, key] of entry.cache) expect(await cache.exist(key)).toBe(true);
      expect(sent).toHaveLength(entry.http.length);
    },
  );

  it("leaves a redirect to Rails, which follows it, and writes nothing", async () => {
    const cache = createRailsCache({ transport: createMemoryTransport(), namespace: null });
    const { fetcher, sent } = stand([{ status: 302, headers: { location: "https://example.com/elsewhere" } }]);
    const outcome = await validateVendorTaxId("QstValidationService", "1234567890TQ0001", undefined, {
      fetch: fetcher,
      cache,
    });
    expect(outcome.kind).toBe("unsupported");
    expect(await cache.exist("revenu_quebec_validation_1234567890TQ0001")).toBe(false);
    expect(sent).toHaveLength(1);
    expect((fetcher as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]![1].redirect).toBe(
      "manual",
    );
  });

  it("calls nobody when the vendor credentials are missing", async () => {
    vi.stubEnv("IRAS_API_ID", "");
    const { fetcher, sent } = stand([]);
    const outcome = await validateVendorTaxId("GstValidationService", "M12345678X", "SG", { fetch: fetcher });
    expect(outcome.kind).toBe("unsupported");
    expect(sent).toHaveLength(0);
  });

  it("memoises for ten minutes", async () => {
    const entry = cases.find((candidate) => candidate.name === "a registered QST id")!;
    let now = 1_000_000;
    const cache = createRailsCache({ transport: createMemoryTransport(() => now), namespace: null, now: () => now });
    const { fetcher, sent } = stand(entry.http_responses);
    const ask = () =>
      validateVendorTaxId("QstValidationService", "1234567890TQ0001", undefined, { fetch: fetcher, cache });
    await ask();
    now += 599;
    await ask();
    expect(sent).toHaveLength(1);
    now += 2;
    await ask();
    expect(sent).toHaveLength(2);
  });
});
