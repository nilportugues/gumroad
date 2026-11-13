import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import type { RecordedExchange } from "../support/recorder.ts";

import { diffReplays, formatMarkdown, isClean } from "./diff.ts";
import { maskBody, maskLocation, maskPath } from "./mask.ts";
import { mapHost, replay } from "./replay.ts";

type Variant = { token: string; stamp: string; id: number; discoverStatus?: number; discoverExtra?: string };

const servers: http.Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

const startServer = async (variant: Variant) => {
  const seen: { host: string | undefined; cookie: string | undefined; path: string | undefined }[] = [];
  const server = http.createServer((req, res) => {
    seen.push({ host: req.headers.host, cookie: req.headers.cookie, path: req.url });
    if (req.url === "/discover") {
      res.writeHead(variant.discoverStatus ?? 200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        `<meta name="csrf-token" content="${variant.token}"><p data-page="{&quot;id&quot;:${variant.id},&quot;created_at&quot;:&quot;${variant.stamp}&quot;}">hi ${variant.discoverExtra ?? ""}</p>`,
      );
    } else if (req.url === "/login") {
      res.writeHead(302, {
        location: `http://localhost:9/library/${variant.id}`,
        "set-cookie": [`sid=${variant.token}; Path=/; HttpOnly`],
      });
      res.end();
    } else if (req.url === "/whoami") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ cookie: req.headers.cookie ? "yes" : "no" }));
    } else {
      res.writeHead(404);
      res.end("nope");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { url: `http://127.0.0.1:${port}`, seen };
};

const exchange = (overrides: Partial<RecordedExchange>): RecordedExchange => ({
  ts: "2026-01-01T00:00:00.000Z",
  session: "s1",
  step: 1,
  actor: "buyer",
  action: "browse",
  method: "GET",
  host: "localhost:3003",
  path: "/discover",
  status: 200,
  resourceType: "document",
  requestHeaders: { accept: "text/html" },
  responseHeaders: {},
  setCookieNames: [],
  requestBodyHash: null,
  requestBodyBytes: 0,
  responseBodyHash: null,
  responseBodyBytes: 0,
  ...overrides,
});

describe("mask", () => {
  it("masks CSRF tokens, timestamps and id keys in raw and HTML-escaped JSON", () => {
    const masked = maskBody(
      `<meta name="csrf-token" content="abc"> {"product_id":"xyz","id":7,"authenticity_token":"t"} &quot;id&quot;:&quot;q&quot; 2026-05-05T10:11:12.123Z`,
    );
    expect(masked).not.toMatch(/abc|xyz|"t"|2026|:7|&quot;q&quot;/u);
  });

  it("keeps stable content untouched", () => {
    expect(maskBody("<h1>Beautiful widget</h1> $5")).toBe("<h1>Beautiful widget</h1> $5");
  });

  it("masks numeric and opaque path segments and volatile query values but keeps permalinks", () => {
    expect(maskPath("/l/demo")).toBe("/l/demo");
    expect(maskPath("/purchases/123/receipt?token=abcdef&x=1")).toBe("/purchases/:id/receipt?token=<masked>&x=1");
    expect(maskPath("/download/abcdefghij0123456789xyz")).toBe("/download/:id");
  });

  it("compares Location headers by masked path only", () => {
    expect(maskLocation("http://localhost:3003/library/55")).toBe(maskLocation("http://localhost:3004/library/9"));
  });
});

describe("mapHost", () => {
  const base = new URL("http://127.0.0.1:4000");
  it("keeps the subdomain and swaps host and port", () => {
    expect(mapHost("seller.localhost:3003", base)).toBe("seller.localhost:4000");
    expect(mapHost("localhost:3003", base)).toBe("127.0.0.1:4000");
  });
  it("refuses recorded hosts outside the local guard", () => {
    expect(() => mapHost("gumroad.com", base)).toThrow(/Refusing/u);
  });
});

describe("replay", () => {
  it("refuses a base URL outside the local guard before sending anything", async () => {
    await expect(replay([exchange({})], "https://gumroad.com")).rejects.toThrow(/Refusing/u);
    await expect(replay([exchange({})], "http://10.0.0.5:3000")).rejects.toThrow(/Refusing/u);
  });

  it("sends each request with the mapped Host header and writes status, headers and hashes", async () => {
    const server = await startServer({ token: "tok", stamp: "2026-01-01T00:00:00Z", id: 1 });
    const [result] = await replay([exchange({ host: "seller.localhost:3003" })], server.url);
    expect(server.seen[0]?.host).toBe(`seller.localhost:${new URL(server.url).port}`);
    expect(result).toMatchObject({ status: 200, session: "s1", actor: "buyer", method: "GET", path: "/discover" });
    expect(result?.responseHeaders["content-type"]).toBe("text/html; charset=utf-8");
    expect(result?.responseBodyHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(result?.normalizedBodyHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("keeps one cookie jar per actor and does not follow redirects", async () => {
    const server = await startServer({ token: "tok", stamp: "2026-01-01T00:00:00Z", id: 1 });
    const results = await replay(
      [
        exchange({ actor: "buyer", path: "/login" }),
        exchange({ actor: "buyer", path: "/whoami", step: 2 }),
        exchange({ actor: "seller", path: "/whoami", step: 2 }),
      ],
      server.url,
    );
    expect(results[0]).toMatchObject({ status: 302, setCookieNames: ["sid"] });
    expect(results[0]?.responseHeaders.location).toContain("/library/1");
    expect(server.seen[1]?.cookie).toBe("sid=tok");
    expect(server.seen[2]?.cookie).toBeUndefined();
  });

  it("writes exchanges that had a request body as skipped instead of sending them empty", async () => {
    const server = await startServer({ token: "tok", stamp: "2026-01-01T00:00:00Z", id: 1 });
    const [result] = await replay([exchange({ method: "POST", requestBodyBytes: 12 })], server.url);
    expect(result).toMatchObject({ status: 0, replay: { skipped: "request body was not recorded" } });
    expect(server.seen).toHaveLength(0);
  });

  it("records a connection failure as skipped and continues", async () => {
    const server = await startServer({ token: "tok", stamp: "2026-01-01T00:00:00Z", id: 1 });
    const url = server.url;
    server.seen.length = 0;
    servers.pop()?.close();
    const [result] = await replay([exchange({})], url, { timeoutMs: 2000 });
    expect(result?.replay?.skipped).toMatch(/request failed/u);
  });
});

describe("diffReplays", () => {
  const run = async (variant: Variant) => {
    const server = await startServer(variant);
    return replay(
      [exchange({}), exchange({ actor: "seller", path: "/login", step: 2 }), exchange({ path: "/missing", step: 3 })],
      server.url,
    );
  };

  it("reports no difference when only masked fields (csrf token, timestamp, id, cookie value) differ", async () => {
    const a = await run({ token: "tokA", stamp: "2026-01-01T00:00:00Z", id: 1 });
    const b = await run({ token: "tokB", stamp: "2027-02-02T09:09:09Z", id: 2 });
    expect(a[0]?.responseBodyHash).not.toBe(b[0]?.responseBodyHash);
    expect(diffReplays(a, b)).toMatchObject({ paired: 3, differences: [], onlyInA: [], onlyInB: [] });
    expect(isClean(diffReplays(a, b))).toBe(true);
  });

  it("reports a status difference", async () => {
    const a = await run({ token: "t", stamp: "2026-01-01T00:00:00Z", id: 1 });
    const b = await run({ token: "t", stamp: "2026-01-01T00:00:00Z", id: 1, discoverStatus: 500 });
    const report = diffReplays(a, b);
    expect(report.byField).toMatchObject({ status: 1 });
    expect(isClean(report)).toBe(false);
  });

  it("reports a real body difference that the mask must not hide", async () => {
    const a = await run({ token: "t", stamp: "2026-01-01T00:00:00Z", id: 1 });
    const b = await run({ token: "t", stamp: "2026-01-01T00:00:00Z", id: 1, discoverExtra: "different" });
    expect(diffReplays(a, b).differences).toEqual([expect.objectContaining({ field: "body" })]);
  });

  it("reports a differing set of cookie names", async () => {
    const a = await run({ token: "t", stamp: "2026-01-01T00:00:00Z", id: 1 });
    const b = a.map((item, index) => (index === 1 ? { ...item, setCookieNames: ["sid", "extra"] } : item));
    expect(diffReplays(a, b).byField).toEqual({ "set-cookie names": 1 });
  });

  it("reports a path that differs after masking", async () => {
    const a = await run({ token: "t", stamp: "2026-01-01T00:00:00Z", id: 1 });
    const b = a.map((item, index) => (index === 0 ? { ...item, path: "/other" } : item));
    expect(diffReplays(a, b).byField).toMatchObject({ path: 1 });
  });

  it("reports exchanges present on one side only and ignores skipped ones", async () => {
    const a = await run({ token: "t", stamp: "2026-01-01T00:00:00Z", id: 1 });
    const b = a.slice(0, 2);
    expect(diffReplays(a, b).onlyInA).toHaveLength(1);
    const skipped = a.map((item, index) => (index === 0 ? { ...item, status: 0, replay: { skipped: "x" } } : item));
    expect(diffReplays(a, skipped)).toMatchObject({ skipped: 1, differences: [] });
  });

  it("names the request behind each difference in the Markdown report", async () => {
    const a = await run({ token: "t", stamp: "2026-01-01T00:00:00Z", id: 1 });
    const b = await run({ token: "t", stamp: "2026-01-01T00:00:00Z", id: 1, discoverStatus: 500 });
    const report = diffReplays(a, b);
    expect(report.differences[0]?.request).toMatch(/^GET .*\/discover/u);
    expect(formatMarkdown(report, { a: "Rails", b: "Node" })).toMatch(/\| `GET [^`]*\/discover` .*\| status \| `200` \| `500` \|/u);
  });
});
