// Internal target of the proxy's rewrites of the small public endpoints (robots.txt, the favicon, ACME challenges...). Never routed
// to from outside: the proxy sends any request for this path to Rails.
import "@/server/controllers/mobile-accounts";
import "@/server/controllers/mobile-agent";
import "@/server/controllers/mobile-analytics";
import "@/server/controllers/mobile-simple";
import "@/server/controllers/mobile-url-redirects";
import "@/server/controllers/mobile-purchases";
import "@/server/controllers/mobile-review-responses";
import "@/server/controllers/mobile-products";
import "@/server/controllers/mobile-subscriptions";
import "@/server/controllers/mobile-preorders";
import "@/server/controllers/mobile-installments";
import { publicHandlerResponse } from "@/server/controllers/public-handlers";

type Context = { params: Promise<{ action: string }> };

export async function GET(request: Request, { params }: Context) {
  return publicHandlerResponse(request, (await params).action);
}

// The mobile and v2 APIs (`mobile`, `api-v2`) also take writes.
export const POST = GET;
export const PUT = GET;
export const PATCH = GET;
export const DELETE = GET;
export const HEAD = GET;
