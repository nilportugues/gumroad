// DashboardController#monthly_recurring_revenue
import { dashboardCounterResponse } from "@/server/controllers/dashboard-json";

export const GET = dashboardCounterResponse("monthlyRecurringRevenue");
export const HEAD = GET;
