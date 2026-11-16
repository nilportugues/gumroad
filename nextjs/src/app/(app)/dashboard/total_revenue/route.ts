// DashboardController#total_revenue
import { dashboardCounterResponse } from "@/server/controllers/dashboard-json";

export const GET = dashboardCounterResponse("totalRevenue");
export const HEAD = GET;
