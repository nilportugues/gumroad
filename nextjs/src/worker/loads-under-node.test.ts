import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

// Production runs the worker with plain `node`, whose type stripping rejects what vitest and Next
// accept: extensionless relative imports, `@/` aliases and parameter properties. This loads the
// whole worker graph the way production does.
describe("worker entrypoint", () => {
  it("loads under plain Node type stripping", () => {
    const result = spawnSync(process.execPath, ["-e", 'await import("./src/worker/index.ts")'], {
      cwd: new URL("../..", import.meta.url),
      encoding: "utf8",
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });
});
