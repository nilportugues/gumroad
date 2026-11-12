// RendersCustomHtmlPages#profile_custom_html_document and pages_tailwind_head: the sandboxed document a profile's custom HTML is served in.
// The scripts and styles it embeds are the app's own constants, evaluated by nextjs/scripts/golden/custom-html-document.rb into
// custom-html-document.generated.json, so a change to one in Ruby shows up as a diff there and fails the golden here.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { railsRoot } from "../infra/rails-env.ts";
import { NotPortedError } from "../page-props/not-ported.ts";

import constants from "./custom-html-document.generated.json" with { type: "json" };

export const PREVIEW_CHANGED_MARKER_TEXT: string = constants.preview_changed_marker_text;
export const PREVIEW_CHANGED_MARKER = `<!--${PREVIEW_CHANGED_MARKER_TEXT}-->`;

const BLANK = /^[\t-\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*$/u;

// public/pages-tailwind-manifest.json: "logical name -> fingerprinted path"
const MANIFEST_ASSET = /^assets\/pages\/pages-tailwind-[0-9a-fA-F]+\.css$/u;
// JSON that Ruby's parser reads and JSON.parse does not: comments and non-finite numbers.
const NON_STANDARD_JSON = /\/\/|\/\*|NaN|Infinity/u;

function manifestAssetPath(root: string): string | null {
  const manifestPath = path.join(root, "public", "pages-tailwind-manifest.json");
  if (!existsSync(manifestPath)) return null;
  const text = readFileSync(manifestPath, "utf8");
  let manifest: unknown;
  try {
    manifest = JSON.parse(text);
  } catch {
    if (NON_STANDARD_JSON.test(text)) throw new NotPortedError("a Tailwind manifest with JSON extensions");
    return null;
  }
  // Ruby indexes whatever it parsed with a string: a list or a scalar raises, which is a 500 there.
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new NotPortedError("a Tailwind manifest that is not an object");
  }
  const assetPath = (manifest as Record<string, unknown>)["pages-tailwind.css"];
  if (typeof assetPath !== "string" || !MANIFEST_ASSET.test(assetPath)) return null;
  return existsSync(path.join(root, "public", assetPath)) ? assetPath : null;
}

// RendersCustomHtmlPages::ClassMethods#pages_tailwind_head. `assetHost` is "#{PROTOCOL}://#{ASSET_DOMAIN}".
export function pagesTailwindHead(assetHost: string, root: string = railsRoot()): string {
  const assetPath = manifestAssetPath(root);
  if (assetPath !== null) return `<link rel="stylesheet" href="${assetHost}/${assetPath}">`;
  const cssPath = path.join(root, "public", "pages-tailwind.css");
  if (!existsSync(cssPath)) return "";
  const css = readFileSync(cssPath, "utf8");
  if (css.includes("\ufffd")) throw new NotPortedError("a Tailwind stylesheet that is not valid UTF-8");
  return `<style>${css}</style>`;
}

const TAILWIND_V3_CDN_HOST = new RegExp(constants.tailwind_v3_cdn_host_pattern, "iu");
// Ruby's /i matches "ss" against the sharp s; JS's does not.
const SHARP_S = /[\u00df\u1e9e]/u;

// RendersCustomHtmlPages::ClassMethods#tailwind_v3_gradient_compat_head
function tailwindV3GradientCompatHead(customHtml: string): string {
  if (SHARP_S.test(customHtml))
    throw new NotPortedError("a page with a sharp s, which Ruby's case-insensitive match reads as ss");
  return TAILWIND_V3_CDN_HOST.test(customHtml) ? constants.tailwind_v3_gradient_compat_style : "";
}

export type ProfileDocumentOptions = {
  dataJson?: string;
  pricesJson?: string | null;
  scrollToChange?: boolean;
  tailwindHead: string;
};

// profile_custom_html_document with the bridges and live fields the preview does not pass.
export function profileCustomHtmlDocument(customHtml: string, options: ProfileDocumentOptions): string {
  const { dataJson = "{}", pricesJson = null, scrollToChange = false, tailwindHead } = options;
  const prices =
    pricesJson === null || BLANK.test(pricesJson)
      ? ""
      : `<script id="gumroad-prices" type="application/json">${pricesJson}</script>`;
  return [
    "<!doctype html>",
    "<html>",
    "  <head>",
    '    <meta charset="utf-8">',
    '    <meta name="viewport" content="width=device-width, initial-scale=1">',
    `    ${constants.sandbox_compat_script}`,
    `    ${tailwindHead}`,
    `    ${tailwindV3GradientCompatHead(customHtml)}`,
    "  </head>",
    "  <body>",
    `    <script id="gumroad-data" type="application/json">${dataJson}</script>`,
    `    ${prices}`,
    `    ${customHtml}`,
    "    ",
    "    ",
    "    ",
    `    ${constants.background_bridge_script}`,
    "    ",
    `    ${scrollToChange ? constants.preview_scroll_to_change_script : ""}`,
    "  </body>",
    "</html>",
    "",
  ].join("\n");
}
