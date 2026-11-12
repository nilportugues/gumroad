// ViteRuby's `vite_asset_path`: the manifest entry of a source file, prefixed with the output directory and Rails' asset host.
import { readFileSync } from "node:fs";
import path from "node:path";

import { NotPortedError } from "../page-props/not-ported.ts";

import { domainConfig } from "./domain.ts";
import { railsEnv, railsRoot } from "./rails-env.ts";

type Manifest = Record<string, { file: string; css?: string[]; imports?: string[] }>;

let cached: { file: string; manifest: Manifest } | undefined;

// config/vite.json: `publicOutputDir` per environment.
const OUTPUT_DIRS = { test: "vite-test", development: "vite-dev" } as const;

function loadManifest(): { dir: string; local: boolean; manifest: Manifest } {
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
  return { dir, local, manifest: cached.manifest };
}

// `ViteRuby.instance.manifest.resolve_entries(name, type: :typescript)[:stylesheets]`: the css of the entry's TypeScript file, as
// paths under the output directory (no asset host). A chunk it imports that carries css of its own is not modelled.
export function viteEntrypointStylesheets(name: string): string[] {
  if (railsEnv() === "development") throw new NotPortedError("the Vite dev server's stylesheet entries");
  const { dir, manifest } = loadManifest();
  const entry = manifest[`entrypoints/${name}.ts`];
  if (!entry) throw new NotPortedError(`entrypoints/${name}.ts in the Vite manifest`);
  if ((entry.imports ?? []).some((chunk) => (manifest[chunk]?.css ?? []).length > 0))
    throw new NotPortedError(`the stylesheets of the chunks entrypoints/${name}.ts imports`);
  return [...new Set(entry.css ?? [])].map((file) => `/${dir}/${file}`);
}

export function viteAssetPath(name: string): string {
  const { dir, local, manifest } = loadManifest();
  const entry = manifest[name];
  if (!entry) throw new NotPortedError(`${name} in the Vite manifest`);
  // `path_to_asset` adds the asset host only where config.asset_host is set (staging and production).
  return `${local ? "" : (domainConfig().assetHost ?? "")}/${dir}/${entry.file}`;
}

// `vite_entrypoint_stylesheet_tag` with crossorigin: "anonymous": the stylesheet link, and the `Link: ...; rel=preload` header
// Rails' stylesheet_link_tag adds for it.
export function viteEntrypointStylesheet(entry: string): { tag: string; linkHeader: string } {
  if (railsEnv() === "development") throw new NotPortedError("the Vite dev server's stylesheet tags");
  const href = viteAssetPath(entry);
  return {
    tag: `<link rel="stylesheet" crossorigin="anonymous" href="${href}" />`,
    linkHeader: `<${href}>; rel=preload; as=style; crossorigin=anonymous; nopush`,
  };
}
