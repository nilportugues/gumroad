// DashboardController#customers_count
import { dashboardCounterResponse } from "@/server/controllers/dashboard-json";

export const GET = dashboardCounterResponse("customersCount");
export const HEAD = GET;
