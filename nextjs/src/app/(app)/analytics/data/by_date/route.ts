// AnalyticsController#data_by_date
import { analyticsDataResponse } from "@/server/controllers/analytics-data";

export const GET = analyticsDataResponse("date");
export const HEAD = GET;
