// The routes auto-import loader points every `Routes.x` in app/javascript at this module, and Turbopack
// fails the whole page's compile on an export it lacks, so a missing helper only shows up as a 500 in
// whichever replay first renders a component that uses it.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import * as routes from "./routes";

const appJavascript = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../app/javascript");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx|js|jsx)$/u.test(entry.name) ? [full] : [];
  });
}

describe("route helpers", () => {
  it("define every Routes helper app/javascript calls", () => {
    const used = new Set(sourceFiles(appJavascript).flatMap((file) => [...readFileSync(file, "utf8").matchAll(/(?:^|[^.\w$])Routes\.(\w+)/gu)].map((m) => m[1]!)));
    expect([...used].filter((name) => !(name in routes)).sort()).toEqual([]);
  });
});
