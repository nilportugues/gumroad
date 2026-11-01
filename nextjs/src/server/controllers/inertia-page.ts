// An X-Inertia request for a page Next.js serves: the JSON `render inertia:` sends instead of HTML,
// and the 409 InertiaRails::Middleware answers when the client's asset version is stale. The proxy
// rewrites such requests to /gr-inertia and names the original URL in x-gr-page-url.
import { matchPagePath, PAGES } from "../page-props/pages.ts";
import { railsJson } from "../page-props/inertia-json.ts";
import { PAGE_URL_HEADER } from "../page-props/render-state.ts";
import { renderPage } from "../page-props/render-page.ts";
import { type ActionResult, processAction, RoutingError } from "./application-controller.ts";
import { fullpath } from "./rails-request.ts";

export const INERTIA_PAGE_PATH = "/gr-inertia";

export async function inertiaPageResponse(incoming: Request): Promise<Response> {
  const target = incoming.headers.get(PAGE_URL_HEADER);
  if (target === null) return new Response(null, { status: 404 });
  const host = incoming.headers.get("x-forwarded-host") ?? incoming.headers.get("host") ?? "localhost";
  const protocol = incoming.headers.get("x-forwarded-proto") ?? "http";
  const request = new Request(new URL(target, `${protocol}://${host}`), { method: incoming.method, headers: incoming.headers });

  return processAction(request, {}, async ({ request: railsRequest, takeRenderState }): Promise<ActionResult> => {
    const match = matchPagePath(railsRequest.path);
    if (!match) throw new RoutingError("Not Found");
    const spec = PAGES[match.pattern]!;

    // No asset version is configured, so any version the client sends is stale. Rails runs the
    // controller first, then replaces its response; the flash is kept.
    const stale = railsRequest.method === "GET" && incoming.headers.has("x-inertia-version");
    const redirect = spec.redirect?.(match.params);
    if (stale) return { forceRefresh: `${railsRequest.protocol}${railsRequest.hostWithPort}${fullpath(railsRequest)}`, rescued: !!redirect };
    if (redirect) return redirect;

    const { href: _href, ...page } = await renderPage(match.pattern, match.params, { renderState: takeRenderState() });
    return { status: 200, contentType: "application/json; charset=utf-8", body: railsJson(page), inertia: true, headers: { "x-inertia": "true" } };
  });
}
