// HealthcheckController#sidekiq
import { healthcheckRoute } from "@/server/controllers/healthcheck";

export const { GET, HEAD } = healthcheckRoute("sidekiq");
