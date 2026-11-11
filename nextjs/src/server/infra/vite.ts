// ViteRuby's `vite_asset_path`: the manifest entry of a source file, prefixed with the output directory and Rails' asset host.
import { readFileSync } from "node:fs";
import path from "node:path";

import { NotPortedError } from "../page-props/not-ported.ts";

import { domainConfig } from "./domain.ts";
import { railsEnv, railsRoot } from "./rails-env.ts";

type Manifest = Record<string, { file: string }>;

let cached: { file: string; manifest: Manifest } | undefined;

// config/vite.json: `publicOutputDir` per environment.
const OUTPUT_DIRS = { test: "vite-test", development: "vite-dev" } as const;

export function viteAssetPath(name: string): string {
  const env = railsEnv();
  const local = env === "test" || env === "development";
  const dir = local ? OUTPUT_DIRS[env] : "vite";
  const file = path.join(railsRoot(), "public", dir, ".vite", "manifest.json");
  if (cached?.file !== file) {
    try {
      cached = { file, manifest: JSON.parse(readFileSync(file, "utf8")) as Manifest };
    } catch {
      throw new NotPortedError(`the Vite manifest at ${file}`);
    }
  }
  const entry = cached.manifest[name];
  if (!entry) throw new NotPortedError(`${name} in the Vite manifest`);
  // `path_to_asset` adds the asset host only where config.asset_host is set (staging and production).
  return `${local ? "" : (domainConfig().assetHost ?? "")}/${dir}/${entry.file}`;
}
