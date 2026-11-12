// EmbeddedJavascriptsController#overlay and #embed: the loader scripts of /js/gumroad, /js/gumroad-overlay, /js/gumroad-multioverlay and
// /js/gumroad-embed. The script is app/views/embedded_javascripts/index.js.erb, read from the file; the table is the Ruby in it.
// #analytics is a different template and stays in public-handlers.ts.
import { SafeString } from "../erb/html.ts";
import { type ErbTable, renderErb } from "../erb/template.ts";
import { domainConfig } from "../page-props/domain.ts";
import { assetHost } from "../page-props/domain.ts";
import { viteAssetPath, viteEntrypointStylesheets } from "../infra/vite.ts";
import { HandBackToRails, type Rendered } from "./application-controller.ts";
import { assertFlatQuery } from "./rails-params.ts";
import type { RailsRequest } from "./rails-request.ts";

const OVERLAY_SCRIPT_PATH = "/js/gumroad-bundle.js";
const EMBED_SCRIPT_PATH = "/js/gumroad-embed-bundle.js";
const OVERLAY_STYLESHEET = "overlay";
const JAVASCRIPT = "text/javascript; charset=utf-8";

export type EmbeddedJavascript = "overlay" | "embed";

// The first stylesheet of the `design` entrypoint, else its `.scss` asset.
function globalStylesheetPath(): string {
  return viteEntrypointStylesheets("design")[0] ?? viteAssetPath("entrypoints/design.scss");
}

export function embeddedJavascript(request: RailsRequest, kind: EmbeddedJavascript): Rendered {
  assertFlatQuery(request.queryString);
  // Only the template's own format renders: for an HTML request Rails raises MissingTemplate.
  const accept = request.headers.get("accept") ?? "";
  if (accept.trim() !== "*/*" && !/javascript/u.test(accept))
    throw new HandBackToRails("a loader script requested as something other than a script");

  const config = domainConfig(process.env);
  // ActionView's asset_url: the asset host, else the request's own origin.
  const origin = assetHost(config) ?? `${request.protocol}${request.hostWithPort}`;
  const overlay = kind === "overlay";
  const stylesheets = overlay ? viteEntrypointStylesheets(OVERLAY_STYLESHEET) : [];
  if (overlay && stylesheets.length === 0)
    throw new HandBackToRails("an overlay entrypoint without stylesheets, which Rails links as its .scss source");
  const hrefs = stylesheets.map((stylesheet) => `${assetHost(config) ?? ""}${stylesheet}`);
  const globalStylesheet = overlay ? globalStylesheetPath() : null;

  const table: ErbTable = {
    conditions: {
      "@stylesheet.present?": () => overlay,
      "@global_stylesheet_path.present?": () => globalStylesheet !== null,
    },
    values: {
      "asset_url(@script_path)": () => `${origin}${overlay ? OVERLAY_SCRIPT_PATH : EMBED_SCRIPT_PATH}`,
      // stylesheet_link_tag(*stylesheets, extname: false)
      "vite_entrypoint_stylesheet_tag(@stylesheet)": () =>
        new SafeString(hrefs.map((href) => `<link rel="stylesheet" href="${href}" />`).join("\n")),
      "asset_url(@global_stylesheet_path)": () => `${origin}${globalStylesheet ?? ""}`,
    },
  };
  return {
    status: 200,
    body: renderErb("embedded_javascripts/index.js.erb", table),
    contentType: JAVASCRIPT,
    // stylesheet_link_tag preloads each stylesheet.
    ...(hrefs.length > 0 ? { headers: { link: hrefs.map((href) => `<${href}>; rel=preload; as=style; nopush`).join(",") } } : {}),
    paramsRead: false,
  };
}
