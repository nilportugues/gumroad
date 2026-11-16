// HealthcheckController#apple_pay_domain
import { healthcheckRoute } from "@/server/controllers/healthcheck";

export const { GET, HEAD } = healthcheckRoute("apple_pay_domain");
