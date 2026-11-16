// AffiliatesController#statistics
import { affiliateStatisticsResponse } from "@/server/controllers/affiliate-statistics";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return affiliateStatisticsResponse(request, params);
}

export const HEAD = GET;
