import { describe, expect, it } from "vitest";

import { compareExchange, formatDifferences } from "../src/compare";
import type { CapturedExchange, Exchange } from "../src/fixture";

const recorded: Exchange = {
  seed: { tables: {}, autoIncrement: {} },
  request: { source: "request", method: "POST", path: "/follow", headers: {} },
  response: {
    status: 302,
    location: "http://app.test/follow/confirm",
    headers: { "content-type": "text/html; charset=utf-8" },
    cookies: { _session: { value: "opaque-1", path: "/", httponly: true } },
  },
  db: { followers: { inserted: [{ id: 1, email: "buyer@example.com", created_at: "<now>" }] } },
  jobs: [{ class: "SendFollowerConfirmationJob", args: [1], queue: "default" }],
  mails: [],
  http: [{ method: "POST", url: "https://api.example.com/v1/hooks", body: "{}", response: { status: 200, body: "ok" } }],
};

function actual(overrides: Partial<CapturedExchange> = {}): CapturedExchange {
  const { seed: _seed, request: _request, ...captured } = structuredClone(recorded);
  return { ...captured, http: captured.http.map((call) => ({ ...call, response: {} })), ...overrides };
}

describe("compareExchange", () => {
  it("finds nothing when every channel matches, ignoring the replayed http responses", () => {
    expect(compareExchange(recorded, actual())).toEqual([]);
  });

  it("reports a changed status and a missing job by path", () => {
    const differences = compareExchange(recorded, actual({ response: { ...recorded.response, status: 200 }, jobs: [] }));
    expect(differences).toEqual([
      { path: "response.status", kind: "changed", expected: 302, actual: 200 },
      { path: "jobs[0]", kind: "missing", expected: recorded.jobs[0] },
    ]);
  });

  it("reports a row the port inserted that Rails did not", () => {
    const db = { followers: { inserted: [...recorded.db.followers!.inserted!, { id: 2, email: "x@example.com" }] } };
    expect(compareExchange(recorded, actual({ db }))).toEqual([
      { path: "db.followers.inserted[1]", kind: "unexpected", actual: { id: 2, email: "x@example.com" } },
    ]);
  });

  it("allows extra response headers but not missing ones", () => {
    const headers = { "x-powered-by": "Next.js" };
    expect(compareExchange(recorded, actual({ response: { ...recorded.response, headers } }))).toEqual([
      { path: "response.headers.content-type", kind: "missing", expected: "text/html; charset=utf-8" },
    ]);
  });

  it("ignores the session cookie's encrypted value but still compares its attributes", () => {
    const cookies = { _session: { value: "opaque-2", path: "/", httponly: true } };
    const response = { ...recorded.response, cookies };
    expect(compareExchange(recorded, actual({ response }), { sessionCookie: "_session" })).toEqual([]);
    expect(compareExchange(recorded, actual({ response }))).toHaveLength(1);
  });

  it("skips paths matched by ignore patterns, with * for one segment and ** for any depth", () => {
    const db = { followers: { inserted: [{ id: 1, email: "buyer@example.com", created_at: "<now-5m>" }] } };
    expect(compareExchange(recorded, actual({ db }), { ignore: ["db.*.inserted.*.created_at"] })).toEqual([]);
    expect(compareExchange(recorded, actual({ db, jobs: [] }), { ignore: ["**.created_at", "jobs"] })).toEqual([]);
  });

  it("treats a missing key and null as the same, as the recorder drops nils", () => {
    const response = { ...recorded.response, location: undefined };
    const differences = compareExchange({ ...recorded, response: { ...recorded.response, location: undefined } }, actual({ response }));
    expect(differences).toEqual([]);
  });

  it("formats differences with Rails' value first", () => {
    const text = formatDifferences(compareExchange(recorded, actual({ response: { ...recorded.response, status: 200 } })));
    expect(text).toBe("response.status\n    rails: 302\n    next:  200");
  });
});
