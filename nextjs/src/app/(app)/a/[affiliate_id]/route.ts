// AffiliateRedirectController#set_cookie_and_redirect
import { affiliateRedirectResponse } from "@/server/controllers/affiliate-redirect";

export async function GET(request: Request, { params }: { params: Promise<{ affiliate_id: string }> }) {
  return affiliateRedirectResponse(request, await params);
}

export const HEAD = GET;
