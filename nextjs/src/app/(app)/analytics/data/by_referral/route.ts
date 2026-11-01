// AnalyticsController#data_by_referral
import { analyticsDataResponse } from "@/server/controllers/analytics-data";

export const GET = analyticsDataResponse("referral");
export const HEAD = GET;
