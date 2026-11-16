// Ports of the jobs whose perform opens with `return unless Rails.env.production?` and does nothing else outside it
// (SendStripeBalanceCheckNotificationJob, VerifyFinanceReportsDeliveryJob). Outside production they return, so Node runs them whole.
// In production they read Flipper, Stripe and the finance report completions, which are not ported: the run is handed back before
// anything is read or written. Their unique-jobs lock (RecurringLockTtl) is the Sidekiq bridge's, not the handler's.
// Golden: __fixtures__/production-only-jobs.golden.json (scripts/golden/production-only-jobs.rb).
import { railsEnv } from "../../server/infra/rails-env.ts";
import { HandBackToRuby } from "../../server/jobs/hand-back.ts";

import { checkArity } from "./arity.ts";
import type { JobHandler } from "./types.ts";

const productionOnlyJob =
  (reason: string): JobHandler =>
  (args) => {
    // A wrong argument count is an ArgumentError in Rails too; handing back in production lets Rails raise it.
    if (railsEnv() === "production") throw new HandBackToRuby(reason);
    checkArity(args, 0);
    return Promise.resolve();
  };

export const sendStripeBalanceCheckNotificationJob = productionOnlyJob(
  "the Stripe balance check and its notification run in production",
);
export const verifyFinanceReportsDeliveryJob = productionOnlyJob(
  "the finance report delivery backstop runs in production",
);
