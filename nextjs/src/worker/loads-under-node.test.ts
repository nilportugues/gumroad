import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

// Production runs the worker with plain `node`, whose type stripping rejects what vitest and Next
// accept: extensionless relative imports, `@/` aliases and parameter properties. This loads the
// whole worker graph the way production does. The import is a cold type-stripping load of every worker module, so
// the vitest default of 5s only holds on a warm, idle machine.
const LOAD_TIMEOUT_MS = 180_000;

describe("worker entrypoint", () => {
  it("loads under plain Node type stripping", () => {
    const result = spawnSync(process.execPath, ["-e", 'await import("./src/worker/index.ts")'], {
      cwd: new URL("../..", import.meta.url),
      encoding: "utf8",
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  }, LOAD_TIMEOUT_MS);
});
