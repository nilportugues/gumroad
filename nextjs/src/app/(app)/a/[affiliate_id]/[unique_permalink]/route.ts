// AffiliateRedirectController#set_cookie_and_redirect, for one product of the affiliate
import { affiliateRedirectResponse } from "@/server/controllers/affiliate-redirect";

export async function GET(request: Request, { params }: { params: Promise<{ affiliate_id: string; unique_permalink: string }> }) {
  return affiliateRedirectResponse(request, await params);
}

export const HEAD = GET;
