// HealthcheckController#paypal_balance
import { healthcheckRoute } from "@/server/controllers/healthcheck";

export const { GET, HEAD } = healthcheckRoute("paypal_balance");
