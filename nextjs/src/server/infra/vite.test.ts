import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { viteAssetPath } from "./vite.ts";

const MANIFEST = { "components/ui/Calendar.tsx": { file: "assets/Calendar-CiNM5enb.js" } };

describe("viteAssetPath", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "vite-"));
    for (const dir of ["vite-test", "vite"]) {
      mkdirSync(path.join(root, "public", dir, ".vite"), { recursive: true });
      writeFileSync(path.join(root, "public", dir, ".vite", "manifest.json"), JSON.stringify(MANIFEST));
    }
    vi.stubEnv("RAILS_ROOT", root);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it("prefixes the test output directory without a host", () => {
    vi.stubEnv("RAILS_ENV", "test");
    expect(viteAssetPath("components/ui/Calendar.tsx")).toBe("/vite-test/assets/Calendar-CiNM5enb.js");
  });

  it("adds the asset host in production", () => {
    vi.stubEnv("RAILS_ENV", "production");
    expect(viteAssetPath("components/ui/Calendar.tsx")).toMatch(
      /^https?:\/\/[^/]+\/vite\/assets\/Calendar-CiNM5enb\.js$/u,
    );
  });

  it("refuses an entry the manifest does not list", () => {
    vi.stubEnv("RAILS_ENV", "test");
    expect(() => viteAssetPath("components/ui/Missing.tsx")).toThrow("Missing.tsx");
  });
});
