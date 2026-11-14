// RendersCustomHtmlPages#profile_custom_html_document and pages_tailwind_head: the sandboxed document a profile's custom HTML is served in.
// The scripts and styles it embeds are the app's own constants, evaluated by nextjs/scripts/golden/custom-html-document.rb into
// custom-html-document.generated.json, so a change to one in Ruby shows up as a diff there and fails the golden here.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { railsRoot } from "../infra/rails-env.ts";
import { storageConfig } from "../infra/storage.ts";
import { domainConfig } from "../page-props/domain.ts";
import { NotPortedError } from "../page-props/not-ported.ts";
import { jsonEscape } from "../services/pages-profile-data.ts";

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
export function tailwindV3GradientCompatHead(customHtml: string): string {
  if (SHARP_S.test(customHtml))
    throw new NotPortedError("a page with a sharp s, which Ruby's case-insensitive match reads as ss");
  return TAILWIND_V3_CDN_HOST.test(customHtml) ? constants.tailwind_v3_gradient_compat_style : "";
}

// RendersCustomHtmlPages::CUSTOM_HTML_SANDBOX_TOKENS
const SANDBOX = "allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox";

// RendersCustomHtmlPages::CUSTOM_HTML_CSP
export function customHtmlCsp(): string {
  const { protocol, assetDomain } = domainConfig(process.env);
  const { cdnS3ProxyHost, publicStorageCdnS3ProxyHost } = storageConfig();
  const assetHosts = [...new Set([cdnS3ProxyHost, publicStorageCdnS3ProxyHost])].join(" ");
  return `${[
    `sandbox ${SANDBOX}`,
    "default-src 'none'",
    "script-src 'unsafe-inline' https://cdn.tailwindcss.com https://cdn.jsdelivr.net https://unpkg.com",
    `style-src 'unsafe-inline' ${protocol}://${assetDomain} https://cdn.tailwindcss.com https://fonts.googleapis.com https://fonts.bunny.net`,
    `img-src data: blob: ${assetHosts}`,
    `media-src data: blob: ${assetHosts}`,
    "font-src data: https://fonts.gstatic.com https://fonts.bunny.net",
    "connect-src 'none'",
    "form-action 'self'",
  ].join("; ")};`;
}

export const FOLLOW_BRIDGE_SCRIPT: string = constants.follow_bridge_script;
export const PRODUCTS_BRIDGE_SCRIPT: string = constants.products_bridge_script;

// ERB::Util.json_escape(list.to_json)
const hostListJson = (hosts: readonly string[]): string => jsonEscape(JSON.stringify(hosts));

// RendersCustomHtmlPages#custom_html_navigation_allowlist_js
export const customHtmlNavigationAllowlistJs = (validRequestHosts: readonly string[]): string =>
  constants.navigation_allowlist_template.replace("@@VALID_REQUEST_HOSTS@@", () => hostListJson(validRequestHosts));

// RendersCustomHtmlPages#custom_html_navigation_bridge_script. `validRequestHosts` is VALID_REQUEST_HOSTS of the running environment.
export function customHtmlNavigationBridgeScript(
  allowedHostnames: readonly string[],
  validRequestHosts: readonly string[],
): string {
  return constants.navigation_bridge_template
    .replace("@@STORE_HOSTNAMES@@", () => hostListJson(allowedHostnames))
    .replace("@@VALID_REQUEST_HOSTS@@", () => hostListJson(validRequestHosts));
}

// ERB::Util.h
export const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/gu, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const fill = (template: string, values: Record<string, string>): string =>
  Object.entries(values).reduce((text, [placeholder, value]) => text.split(placeholder).join(value), template);

// RendersCustomHtmlPages#custom_html_follow_wrapper_script
export const customHtmlFollowWrapperScript = (sellerExternalId: string, nonce: string): string =>
  fill(constants.follow_wrapper_template, {
    '"@@SELLER_ID@@"': jsonEscape(JSON.stringify(sellerExternalId)),
    "@@NONCE@@": escapeHtml(nonce),
  });

// RendersCustomHtmlPages#custom_html_background_wrapper_script
export const customHtmlBackgroundWrapperScript = (nonce: string): string =>
  fill(constants.background_wrapper_template, { "@@NONCE@@": escapeHtml(nonce) });

// RendersCustomHtmlPages#custom_html_live_reload_script
export const customHtmlLiveReloadScript = (versionSrc: string, nonce: string): string =>
  fill(constants.live_reload_template, {
    '"@@VERSION_SRC@@"': jsonEscape(JSON.stringify(versionSrc)),
    "@@NONCE@@": escapeHtml(nonce),
  });

// custom_html_wrapper_theme_background_css for the seller profile's background colour; HexColorValidator.safe_for_css?
const CSS_HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/iu;
export const themeBackgroundCss = (color: string | null): string =>
  color !== null && CSS_HEX_COLOR.test(color) ? `html{background:${color}}` : "";

export type ProfileDocumentOptions = {
  dataJson?: string;
  pricesJson?: string | null;
  scrollToChange?: boolean;
  liveFields?: boolean;
  navigationBridge?: string;
  followBridge?: string;
  productsBridge?: string;
  tailwindHead: string;
};

// profile_custom_html_document
export function profileCustomHtmlDocument(customHtml: string, options: ProfileDocumentOptions): string {
  const {
    dataJson = "{}",
    pricesJson = null,
    scrollToChange = false,
    liveFields = false,
    navigationBridge = "",
    followBridge = "",
    productsBridge = "",
    tailwindHead,
  } = options;
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
    `    ${navigationBridge}`,
    `    ${followBridge}`,
    `    ${productsBridge}`,
    `    ${constants.background_bridge_script}`,
    `    ${liveFields ? constants.profile_fields_preview_script : ""}`,
    `    ${scrollToChange ? constants.preview_scroll_to_change_script : ""}`,
    "  </body>",
    "</html>",
    "",
  ].join("\n");
}
