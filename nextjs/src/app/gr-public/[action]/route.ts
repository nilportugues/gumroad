// Internal target of the proxy's rewrites of the small public endpoints (robots.txt, the favicon, ACME challenges...). Never routed
// to from outside: the proxy sends any request for this path to Rails.
import { publicHandlerResponse } from "@/server/controllers/public-handlers";

type Context = { params: Promise<{ action: string }> };

export async function GET(request: Request, { params }: Context) {
  return publicHandlerResponse(request, (await params).action);
}

export const HEAD = GET;
