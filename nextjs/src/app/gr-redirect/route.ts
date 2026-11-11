// Internal target of the proxy's rewrites of router-level redirects (routes.rb `redirect`). Never routed to from outside: the
// proxy sends any request for this path to Rails.
import { rackRedirect } from "@/server/controllers/application-controller";
import { REDIRECT_LOCATION_HEADER } from "@/server/controllers/inertia-page";

export async function GET(request: Request) {
  const location = request.headers.get(REDIRECT_LOCATION_HEADER);
  if (location === null) return new Response(null, { status: 404 });
  return rackRedirect(request, location);
}

export const HEAD = GET;
