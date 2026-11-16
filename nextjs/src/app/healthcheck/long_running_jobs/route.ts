// HealthcheckController#long_running_jobs
import { healthcheckRoute } from "@/server/controllers/healthcheck";

export const { GET, HEAD } = healthcheckRoute("long_running_jobs");
