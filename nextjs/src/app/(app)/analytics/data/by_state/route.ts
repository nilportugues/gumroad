// AnalyticsController#data_by_state
import { analyticsDataResponse } from "@/server/controllers/analytics-data";

export const GET = analyticsDataResponse("state");
export const HEAD = GET;
