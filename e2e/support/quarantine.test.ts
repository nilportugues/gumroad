import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { loadQuarantine, quarantinePatterns } from "./quarantine.ts";

const write = (content: string) => {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), "quarantine-")), "quarantine.json");
  writeFileSync(file, content);
  return file;
};

describe("loadQuarantine", () => {
  it("treats a missing file as an empty list", () => {
    expect(loadQuarantine("/nonexistent/quarantine.json")).toEqual([]);
  });

  it("returns valid entries and builds patterns that match only that spec", () => {
    const entries = loadQuarantine(
      write(JSON.stringify([{ file: "e2e/specs/discover.spec.ts", reason: "search index lag", since: "2026-11-13" }])),
    );
    const [pattern] = quarantinePatterns(entries);
    expect(pattern?.test("/repo/e2e/specs/discover.spec.ts")).toBe(true);
    expect(pattern?.test("/repo/e2e/specs/discover.spec.ts.bak")).toBe(false);
    expect(pattern?.test("/repo/e2e/specs/profile.spec.ts")).toBe(false);
  });

  it("rejects entries without a reason, a since date or a spec path", () => {
    expect(() => loadQuarantine(write(JSON.stringify([{ file: "e2e/specs/a.spec.ts", since: "x" }])))).toThrow(
      /reason/u,
    );
    expect(() =>
      loadQuarantine(write(JSON.stringify([{ file: "../../etc/passwd", reason: "r", since: "x" }]))),
    ).toThrow(/file/u);
    expect(() => loadQuarantine(write("{}"))).toThrow(/array/u);
  });
});
