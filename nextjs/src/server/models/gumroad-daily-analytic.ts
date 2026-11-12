// Port of app/models/gumroad_daily_analytic.rb: the validations. `import` is in worker/jobs/compile-gumroad-daily-analytics-job.ts.
import type { GumroadDailyAnalytic } from "@prisma/client";

import { defineModel } from "./runtime/define-model.ts";
import { validatesPresenceOf } from "./runtime/validators.ts";

export const GUMROAD_DAILY_ANALYTICS = "gumroad_daily_analytics";

export const GumroadDailyAnalytics = defineModel<GumroadDailyAnalytic>({
  rubyClass: "GumroadDailyAnalytic",
  prismaModel: "GumroadDailyAnalytic",
  delegate: (tx) => tx.gumroadDailyAnalytic as never,
  validations: [
    validatesPresenceOf<GumroadDailyAnalytic>([
      "period_ended_at",
      "gumroad_price_cents",
      "gumroad_fee_cents",
      "creators_with_sales",
      "gumroad_discover_price_cents",
    ]),
  ],
});
