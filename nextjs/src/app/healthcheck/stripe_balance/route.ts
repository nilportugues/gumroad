// HealthcheckController#stripe_balance
import { healthcheckRoute } from "@/server/controllers/healthcheck";

export const { GET, HEAD } = healthcheckRoute("stripe_balance");
