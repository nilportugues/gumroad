// EmailStylesheetLoader (lib/utilities/email_stylesheet_loader.rb) for the one stylesheet our own
// layouts link: the Vite build of entrypoints/email.ts, read from public/ as Rails reads it.
// Remote hrefs (seller HTML in post bodies) go through SsrfFilter in Ruby; no Node mailer renders
// seller HTML yet, so they are refused here.
import { readFileSync } from "node:fs";
import path from "node:path";

import { domainConfig } from "../infra/domain.ts";
import { railsRoot } from "../infra/rails-env.ts";

export class StylesheetNotPortedError extends Error {}

// EmailStylesheetLoader#unwrap_layers
export function unwrapLayers(css: string): string {
  if (!css.includes("@layer")) return css;
  const layer = /@layer\b(?:[^{};@/]|\/\*[^@]*?\*\/)*([;{])/y;
  const chunk = /"(?:\\[\s\S]|[^"\\])*(?:"|(?![\s\S]))|'(?:\\[\s\S]|[^'\\])*(?:'|(?![\s\S]))|\/\*[\s\S]*?(?:\*\/|(?![\s\S]))|[^{}"'/@]+|[\s\S]/y;
  let output = "";
  const closesLayer: boolean[] = [];
  let pos = 0;
  while (pos < css.length) {
    layer.lastIndex = pos;
    const m = layer.exec(css);
    if (m) {
      if (m[1] === "{") closesLayer.push(true);
      pos = layer.lastIndex;
    } else if (css[pos] === "{") {
      closesLayer.push(false);
      output += "{";
      pos++;
    } else if (css[pos] === "}") {
      if (!closesLayer.pop()) output += "}";
      pos++;
    } else {
      chunk.lastIndex = pos;
      const c = chunk.exec(css)!;
      output += c[0];
      pos = chunk.lastIndex;
    }
  }
  return output;
}

type ViteManifest = Record<string, { file: string; css?: string[] }>;

let manifestCache: { publicDir: string; manifest: ViteManifest } | undefined;
const cssCache = new Map<string, string>();

function publicDir(): string {
  return process.env.MAIL_PUBLIC_DIR ?? path.join(railsRoot(), "public");
}

function viteManifest(): ViteManifest {
  const dir = publicDir();
  if (manifestCache?.publicDir !== dir) {
    // vite_ruby's publicOutputDir is "vite" in staging and production (config/vite.json).
    const file = path.join(dir, "vite", ".vite", "manifest.json");
    manifestCache = { publicDir: dir, manifest: JSON.parse(readFileSync(file, "utf8")) as ViteManifest };
  }
  return manifestCache.manifest;
}

// ApplicationHelper#vite_entrypoint_stylesheet_tag's hrefs for an entrypoint, with the asset host
// stylesheet_link_tag prepends.
export function entrypointStylesheetHrefs(name: string): string[] {
  const entry = viteManifest()[`entrypoints/${name}.ts`];
  if (!entry?.css?.length) throw new StylesheetNotPortedError(`no stylesheet for entrypoints/${name}.ts in the Vite manifest`);
  const host = domainConfig().assetHost ?? "";
  return entry.css.map((file) => `${host}/vite/${file}`);
}

// EmailStylesheetLoader.load for an href under public/, with CSSHelper's production cache.
export function loadEmailStylesheet(href: string): string {
  const cached = cssCache.get(href);
  if (cached !== undefined) return cached;
  const urlPath = new URL(href, "http://localhost").pathname;
  const dir = publicDir();
  const file = path.resolve(path.join(dir, urlPath));
  if (!file.startsWith(`${dir}${path.sep}`)) throw new StylesheetNotPortedError(`stylesheet outside public/: ${href}`);
  let css: string;
  try {
    css = readFileSync(file, "utf8");
  } catch {
    throw new StylesheetNotPortedError(`remote or missing stylesheet: ${href}`);
  }
  const unwrapped = unwrapLayers(css);
  cssCache.set(href, unwrapped);
  return unwrapped;
}
