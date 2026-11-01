// config/routes.rb: `get "/purchases/:purchase_id/generate_invoice", to: redirect { ... }`, a route-level
// redirect, so no controller filter runs: no session, guid or CSRF cookie, only the Rack middleware's headers.
import { railsRequest } from "@/server/controllers/rails-request";

const REDIRECT_HEADERS = {
  "cache-control": "no-cache",
  "content-type": "text/html; charset=utf-8",
  vary: "Origin",
  "x-content-type-options": "nosniff",
  "x-download-options": "noopen",
  "x-permitted-cross-domain-policies": "none",
  "x-xss-protection": "1; mode=block",
};

export async function GET(request: Request, { params }: { params: Promise<{ purchase_id: string }> }) {
  const { purchase_id } = await params;
  const rails = railsRequest(request);
  const query = rails.queryString;
  // The router's path params are percent-decoded, and the redirect writes them back as given.
  const location = `${rails.protocol}${rails.hostWithPort}/purchases/${purchase_id}/invoice/new${query ? `?${query}` : ""}`;
  return new Response(null, { status: 301, headers: { ...REDIRECT_HEADERS, location } });
}

export const HEAD = GET;
