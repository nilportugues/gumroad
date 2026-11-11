// Internal target of the proxy's rewrites of router-level redirects (routes.rb `redirect`). Never routed to from outside: the
// proxy sends any request for this path to Rails.
import { routerRedirect } from "@/server/controllers/application-controller";
import { REDIRECT_LOCATION_HEADER } from "@/server/controllers/inertia-page";
import { PAGE_URL_HEADER } from "@/server/page-props/render-state";

export async function GET(incoming: Request) {
  const location = incoming.headers.get(REDIRECT_LOCATION_HEADER);
  const target = incoming.headers.get(PAGE_URL_HEADER);
  if (location === null || target === null) return new Response(null, { status: 404 });
  // The request as the visitor sent it: Rack::Attack keys on its path, not on the internal one the proxy rewrote it to.
  const host = incoming.headers.get("x-forwarded-host") ?? incoming.headers.get("host") ?? "localhost";
  const protocol = incoming.headers.get("x-forwarded-proto") ?? "http";
  const request = new Request(new URL(target, `${protocol}://${host}`), {
    method: incoming.method,
    headers: incoming.headers,
  });
  return routerRedirect(request, location);
}

export const HEAD = GET;
