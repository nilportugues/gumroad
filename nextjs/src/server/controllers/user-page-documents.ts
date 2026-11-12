// The two documents UserPagesController builds around a seller's slugged custom HTML page: the sandboxed embed and the trusted wrapper
// that frames it. The scripts they embed come from custom-html-document.ts.
import { jsonEscape } from "../services/pages-profile-data.ts";

import constants from "./custom-html-document.generated.json" with { type: "json" };
import {
  customHtmlBackgroundWrapperScript,
  customHtmlFollowWrapperScript,
  customHtmlLiveReloadScript,
  customHtmlNavigationAllowlistJs,
  escapeHtml,
  tailwindV3GradientCompatHead,
} from "./custom-html-document.ts";

// RendersCustomHtmlPages::CUSTOM_HTML_SANDBOX_TOKENS
const SANDBOX = "allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox";
const ALLOWLIST_INDENT = 16;

// UserPagesController#landing_iframe_content: no data or price payload, and the bridges follow the page.
export function userPageEmbedDocument(
  interpolated: string,
  options: { navigationBridge: string; tailwindHead: string },
): string {
  return [
    "<!doctype html>",
    "<html>",
    "  <head>",
    '    <meta charset="utf-8">',
    '    <meta name="viewport" content="width=device-width, initial-scale=1">',
    `    ${constants.sandbox_compat_script}`,
    `    ${options.tailwindHead}`,
    `    ${tailwindV3GradientCompatHead(interpolated)}`,
    "  </head>",
    "  <body>",
    `    ${interpolated}`,
    `    ${options.navigationBridge}`,
    `    ${constants.follow_bridge_script}`,
    `    ${constants.background_bridge_script}`,
    "  </body>",
    "</html>",
    "",
  ].join("\n");
}

export type UserPageWrapperOptions = {
  slug: string;
  pageTitle: string | null;
  documentTitle: string;
  metaHead: string;
  themeBackgroundCss: string;
  storeHostnames: readonly string[];
  validRequestHosts: readonly string[];
  sellerExternalId: string;
  nonce: string;
  csrfToken: string;
  liveReload: boolean;
};

// UserPagesController#page_custom_html_wrapper_document
export function userPageWrapperDocument(options: UserPageWrapperOptions): string {
  const { slug, nonce } = options;
  // String#indent(16).strip
  const allowlist = customHtmlNavigationAllowlistJs(options.validRequestHosts)
    .split("\n")
    .map((line) => (line === "" ? line : `${" ".repeat(ALLOWLIST_INDENT)}${line}`))
    .join("\n")
    .trim();
  const liveReload = options.liveReload ? customHtmlLiveReloadScript(`/${slug}/landing/version`, nonce) : "";
  return [
    "<!doctype html>",
    '<html lang="en">',
    "  <head>",
    '    <meta charset="utf-8">',
    '    <meta name="viewport" content="width=device-width, initial-scale=1">',
    `    <title>${escapeHtml(options.documentTitle)}</title>`,
    `    ${options.metaHead}`,
    `    <meta name="csrf-token" content="${options.csrfToken}">`,
    `    <style>html,body{margin:0;padding:0;height:100%;overflow:hidden}iframe{display:block;width:100%;height:100%;border:0}${options.themeBackgroundCss}</style>`,
    "  </head>",
    "  <body>",
    "    <iframe",
    '      id="gumroad-landing-frame"',
    `      src="${escapeHtml(`/${slug}/landing/embed`)}"`,
    `      title="${escapeHtml(options.pageTitle ?? "")}"`,
    `      sandbox="${SANDBOX}"`,
    "    ></iframe>",
    `    <script nonce="${escapeHtml(nonce)}" data-cfasync="false">`,
    "      (function () {",
    '        var frame = document.getElementById("gumroad-landing-frame");',
    `        var STORE_HOSTNAMES = ${jsonEscape(JSON.stringify(options.storeHostnames))};`,
    `        ${allowlist}`,
    '        window.addEventListener("message", function (e) {',
    "          if (!frame || e.source !== frame.contentWindow) return;",
    "          var d = e.data;",
    '          if (!d || d.type !== "gumroad:navigate" || typeof d.url !== "string") return;',
    "          var url;",
    "          try { url = new URL(d.url); } catch (_err) { return; }",
    '          if (url.protocol !== "https:" && url.protocol !== "http:") return;',
    "          var destination = gumroadNavigationTarget(url, STORE_HOSTNAMES);",
    "          if (destination === null) return;",
    "          window.location.href = destination;",
    "        });",
    "      })();",
    "    </script>",
    `    ${customHtmlFollowWrapperScript(options.sellerExternalId, nonce)}`,
    `    ${customHtmlBackgroundWrapperScript(nonce)}`,
    `    ${liveReload}`,
    "  </body>",
    "</html>",
    "",
  ].join("\n");
}
