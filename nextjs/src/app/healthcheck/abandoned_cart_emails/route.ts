// HealthcheckController#abandoned_cart_emails
import { healthcheckRoute } from "@/server/controllers/healthcheck";

export const { GET, HEAD } = healthcheckRoute("abandoned_cart_emails");
