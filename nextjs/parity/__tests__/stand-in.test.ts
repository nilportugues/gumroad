import { createHash } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import type { Exchange } from "../src/fixture";
import { interceptFetch, keptHttpHeaders } from "../src/http";
import { standInDifferences, timelineSegments, type StandInCall } from "../src/stand-in";

const now = new Date("2026-11-11T12:00:00Z");
const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;

describe("keptHttpHeaders", () => {
  it("keeps the headers that matter, hashes the credential and tokenises a random key", () => {
    const headers = new Headers({
      "Idempotency-Key": "3f2b8f3e-5c0e-4f6b-9a39-0d1f4a6b7c8d",
      "Stripe-Account": "acct_123",
      Authorization: "Bearer sk_test_fake",
      "User-Agent": "Stripe/v1",
      "X-Stripe-Client-Telemetry": "{}",
    });

    expect(keptHttpHeaders(headers)).toEqual({
      "idempotency-key": "<uuid>",
      "stripe-account": "acct_123",
      authorization: digest("Bearer sk_test_fake"),
    });
  });

  it("keeps a derived idempotency key verbatim", () => {
    expect(keptHttpHeaders({ "idempotency-key": "dispute_evidence_abc_1234", "paypal-request-id": "req-1" })).toEqual({
      "idempotency-key": "dispute_evidence_abc_1234",
      "paypal-request-id": "req-1",
    });
  });
});

describe("interceptFetch", () => {
  const original = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = original;
  });

  const post = (interceptor: ReturnType<typeof interceptFetch>) => {
    expect(interceptor).toBeDefined();
    return fetch("https://api.stripe.com/v1/refunds", {
      method: "POST",
      headers: { "Idempotency-Key": "3f2b8f3e-5c0e-4f6b-9a39-0d1f4a6b7c8d", Authorization: "Bearer k" },
      body: "charge=ch_1",
    });
  };

  it("records headers only when the fixture does, so recordings made before the timeline replay unchanged", async () => {
    const old = interceptFetch(
      [{ method: "POST", url: "https://api.stripe.com/v1/refunds", body: "charge=ch_1", response: {} }],
      now,
    );
    await post(old);
    expect(old.calls()[0]).not.toHaveProperty("headers");
    old.restore();

    const recorded = interceptFetch(
      [
        {
          method: "POST",
          url: "https://api.stripe.com/v1/refunds",
          body: "charge=ch_1",
          headers: { "idempotency-key": "<uuid>" },
          response: {},
        },
      ],
      now,
    );
    await post(recorded);
    expect(recorded.calls()[0]!.headers).toEqual({ "idempotency-key": "<uuid>", authorization: digest("Bearer k") });
    recorded.restore();
  });
});

describe("timelineSegments", () => {
  it("groups the tables written between outbound calls", () => {
    expect(
      timelineSegments([
        { type: "http", index: 0 },
        { type: "http", index: 1 },
        { type: "db", op: "insert", table: "refunds" },
        { type: "job", index: 0 },
        { type: "db", op: "update", table: "purchases" },
        { type: "db", op: "update", table: "refunds" },
      ]),
    ).toEqual([[], [], ["purchases", "refunds"]]);
  });
});

describe("standInDifferences", () => {
  const exchange = {
    http: [
      {
        method: "POST",
        url: "https://api.stripe.com/v1/refunds",
        body: "charge=ch_1",
        headers: { "idempotency-key": "<uuid>", authorization: "sha256:a" },
        response: {},
      },
    ],
    timeline: [
      { type: "http", index: 0 },
      { type: "db", op: "insert", table: "refunds" },
    ],
  } as unknown as Exchange;
  const call = (overrides: Partial<StandInCall> = {}): StandInCall => ({
    method: "POST",
    url: "https://api.stripe.com/v1/refunds",
    body: "charge=ch_1",
    headers: { "idempotency-key": "<uuid>", authorization: "sha256:b" },
    writtenBefore: [],
    ...overrides,
  });

  it("accepts the recorded order, headers and body", () => {
    expect(standInDifferences(exchange, { calls: [call()], writtenAfter: ["refunds"] })).toEqual([]);
  });

  it("flags a write that happened before the call", () => {
    expect(standInDifferences(exchange, { calls: [call({ writtenBefore: ["refunds"] })], writtenAfter: [] })).toEqual([
      expect.stringContaining("before call 1"),
      expect.stringContaining("after the last call"),
    ]);
  });

  it("flags a derived idempotency key where Rails sent a random one, and a missing key", () => {
    expect(
      standInDifferences(exchange, {
        calls: [call({ headers: { "idempotency-key": "refund_1", authorization: "sha256:b" } })],
        writtenAfter: ["refunds"],
      }),
    ).toEqual([expect.stringContaining("headers")]);
    expect(
      standInDifferences(exchange, {
        calls: [call({ headers: { authorization: "sha256:b" } })],
        writtenAfter: ["refunds"],
      }),
    ).toEqual([expect.stringContaining("headers")]);
  });

  it("compares the credential digest only when asked", () => {
    expect(
      standInDifferences(exchange, { calls: [call()], writtenAfter: ["refunds"] }, { compareAuthorization: true }),
    ).toEqual([expect.stringContaining("headers")]);
  });

  it("flags a missing call", () => {
    expect(standInDifferences(exchange, { calls: [], writtenAfter: ["refunds"] })[0]).toContain(
      "Rails made 1, Node made 0",
    );
  });
});
