// HealthcheckController#purchases
import { healthcheckRoute } from "@/server/controllers/healthcheck";

export const { GET, HEAD } = healthcheckRoute("purchases");
