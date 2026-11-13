import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { VIES_TIMEOUT_MS, valvat, validShape, validateViesVatId } from "./vies-vat-id.ts";

// Recorded by scripts/golden/tax-id-vendors.rb: the real VatValidationService (valvat 1.4.4) called twice in a row against a WebMock
// stand-in for VIES, with the requests the stand-in saw.
type Answer = { status?: number; body?: string; headers?: Record<string, string>; dropped?: boolean };
type GoldenCase = {
  name: string;
  service: string;
  args: (string | null)[];
  http_responses: Answer[];
  results: { value?: boolean | null; raised?: string }[];
  http: { method: string; url: string; headers: Record<string, string>; body: string }[];
};
const cases = (
  JSON.parse(
    readFileSync(new URL("./__fixtures__/tax-id-vendors.golden.json", import.meta.url), "utf8"),
  ) as GoldenCase[]
).filter((entry) => entry.service === "VatValidationService");

// Bodies Ruby reads in ways Node does not model, and that could say "not registered": left to Rails.
const HANDED_BACK = new Set([
  "VIES an answer with whitespace between its elements",
  "VIES an answer with a Header element and whitespace around the Body",
  "VIES an answer with another prefix for the envelope",
  "VIES a CDATA valid element",
  "VIES a comment inside the response",
  "VIES a nested element",
  "VIES an attribute on the valid element",
  "VIES an unregistered answer with a request date that does not parse",
]);

beforeEach(() => {
  vi.stubEnv("VIES_ENDPOINT", "");
  vi.stubEnv("VAT_REGISTRATION_NUMBER", "");
});
afterEach(() => vi.unstubAllEnvs());

function stand(answers: Answer[]) {
  const queue = [...answers];
  const sent: { url: string; method: string; headers: Record<string, string>; body: string; signal: boolean }[] = [];
  const fetcher = vi.fn((url: string | URL | Request, init?: RequestInit) => {
    sent.push({
      url: String(url),
      method: init?.method ?? "GET",
      headers: init?.headers as Record<string, string>,
      body: init?.body as string,
      signal: init?.signal instanceof AbortSignal,
    });
    // HttpCapture answers 200 {} once the case's answers run out.
    const answer = queue.shift() ?? {};
    if (answer.dropped) return Promise.reject(new TypeError("fetch failed", { cause: { code: "ECONNRESET" } }));
    return Promise.resolve(
      new Response(answer.body ?? "{}", { status: answer.status ?? 200, headers: answer.headers ?? {} }),
    );
  });
  return { fetcher: fetcher as unknown as typeof fetch, sent };
}

describe("VatValidationService against the Ruby golden", () => {
  it("records every case twice", () => {
    expect(cases.length).toBeGreaterThan(65);
    expect(cases.every((entry) => entry.results.length === 2)).toBe(true);
  });

  it.each(cases.map((entry) => [entry.name, entry] as const))("%s", async (name, entry) => {
    const { fetcher, sent } = stand(entry.http_responses);
    const outcomes = [];
    for (const _ of entry.results) outcomes.push(await validateViesVatId(entry.args[0], { fetch: fetcher }));

    if (HANDED_BACK.has(name)) {
      expect(outcomes[0]).toEqual({ kind: "unsupported", reason: expect.any(String) as string });
      return;
    }
    expect(outcomes).toEqual(entry.results.map((result) => ({ kind: "valid", valid: result.value === true })));

    // VIES is asked exactly what Ruby asked it, in the same order (the ECONNRESET retry included).
    expect(sent.map(({ url, method }) => [url, method])).toEqual(
      entry.http.map(({ url, method }) => [url.replace(":443", ""), method]),
    );
    expect(sent.map(({ body }) => body)).toEqual(entry.http.map(({ body }) => body));
    expect(sent.map(({ headers }) => headers)).toEqual(
      entry.http.map(({ headers }) => ({
        Accept: headers.Accept,
        "Content-Type": headers["Content-Type"],
        SOAPAction: headers.Soapaction,
      })),
    );
    expect(sent.every(({ signal }) => signal)).toBe(true);
  });

  it("gives the lookup thirty seconds", () => {
    expect(VIES_TIMEOUT_MS).toBe(30_000);
  });

  it("sends the configured registration number as the requester", async () => {
    vi.stubEnv("VAT_REGISTRATION_NUMBER", "DE 811.128.135");
    const { fetcher, sent } = stand([]);
    await validateViesVatId("FR12345678901", { fetch: fetcher });
    expect(sent[0]!.body).toContain("<urn:requesterCountryCode>DE</urn:requesterCountryCode>");
    expect(sent[0]!.body).toContain("<urn:requesterVatNumber>811128135</urn:requesterVatNumber>");
  });

  it("normalises and splits an id like Valvat.new", () => {
    expect(valvat("de 123.456-789")).toEqual({ raw: "DE123456789", vatCountryCode: "DE", withoutCountry: "123456789" });
    expect(valvat("EL123456789").vatCountryCode).toBe("EL");
    expect(valvat("US123456789").vatCountryCode).toBeNull();
    expect(validShape(valvat("GR123456789"))).toBe(false);
  });
});
