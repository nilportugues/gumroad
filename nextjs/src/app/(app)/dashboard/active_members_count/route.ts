// DashboardController#active_members_count
import { dashboardCounterResponse } from "@/server/controllers/dashboard-json";

export const GET = dashboardCounterResponse("activeMembersCount");
export const HEAD = GET;
