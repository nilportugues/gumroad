import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { registeredApiV2Routes } from "./base.ts";
import "./index.ts";

type Entry = { flag: string | null; handler?: string };

const table = JSON.parse(readFileSync(path.join(process.cwd(), "routes.json"), "utf8")) as Record<string, Entry>;

// "POST api:/v2/products" and "POST /api/v2/products" are the same route on the API host and the Gumroad domain.
function normalized(key: string): string {
  const [method, rest] = /^(POST|PUT|PATCH|DELETE) /.test(key) ? [key.split(" ")[0]!, key.slice(key.indexOf(" ") + 1)] : ["GET", key];
  return `${method} ${rest.replace(/^api:/, "").replace(/^\/api\/v2\//, "/v2/")}`;
}

describe("v2 API routes", () => {
  const served = Object.entries(table).filter(([, entry]) => entry.handler === "api-v2");
  const registered = new Set(registeredApiV2Routes().map((route) => `${route.method} ${route.pattern}`));

  it("registers every route routes.json sends to the dispatcher", () => {
    expect(served.length).toBeGreaterThan(0);
    for (const [key] of served) expect(registered, key).toContain(normalized(key));
  });

  it("lists every registered route on both hosts", () => {
    const keys = new Set(served.map(([key]) => key));
    for (const route of registered) {
      const [method, pattern] = route.split(" ") as [string, string];
      const prefix = method === "GET" ? "" : `${method} `;
      // The aliases of WS-17c (/ifttt, /muse, /.well-known, /notion) live on the Gumroad domain only.
      if (!pattern.startsWith("/v2/")) {
        expect(keys, route).toContain(`${prefix}${pattern}`);
        continue;
      }
      expect(keys, route).toContain(`${prefix}api:${pattern}`);
      expect(keys, route).toContain(`${prefix}/api${pattern}`);
    }
  });
});
