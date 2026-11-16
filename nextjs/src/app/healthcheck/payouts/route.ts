// HealthcheckController#payouts
import { healthcheckRoute } from "@/server/controllers/healthcheck";

export const { GET, HEAD } = healthcheckRoute("payouts");
