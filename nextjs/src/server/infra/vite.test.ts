import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { viteAssetPath, viteEntrypointStylesheets } from "./vite.ts";

const MANIFEST = {
  "components/ui/Calendar.tsx": { file: "assets/Calendar-CiNM5enb.js" },
  "entrypoints/overlay.ts": { file: "assets/overlay.js", css: ["assets/overlay.css"], imports: ["_utils.js"] },
  "entrypoints/design.ts": { file: "assets/design.js", imports: ["_styled.js"] },
  "_utils.js": { file: "assets/utils.js" },
  "_styled.js": { file: "assets/styled.js", css: ["assets/styled.css"] },
};

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

  it("lists the css of an entrypoint's TypeScript file under the output directory", () => {
    vi.stubEnv("RAILS_ENV", "test");
    expect(viteEntrypointStylesheets("overlay")).toEqual(["/vite-test/assets/overlay.css"]);
  });

  it("refuses an entrypoint whose imported chunk carries css", () => {
    vi.stubEnv("RAILS_ENV", "test");
    expect(() => viteEntrypointStylesheets("design")).toThrow("imports");
  });

  it("refuses an entry the manifest does not list", () => {
    vi.stubEnv("RAILS_ENV", "test");
    expect(() => viteAssetPath("components/ui/Missing.tsx")).toThrow("Missing.tsx");
  });
});
