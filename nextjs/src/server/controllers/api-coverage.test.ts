import { spawnSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("docs/nextjs-rewrite/api-coverage.md", () => {
  it("matches what scripts/api-coverage.ts generates from routes.rb, routes.json and the registered controllers", () => {
    const nextjsRoot = path.resolve(import.meta.dirname, "../../..");
    const result = spawnSync("node", ["scripts/api-coverage.ts", "--check"], { cwd: nextjsRoot, encoding: "utf8" });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });
});
