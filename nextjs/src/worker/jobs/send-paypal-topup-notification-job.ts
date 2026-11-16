// Port of app/sidekiq/send_paypal_topup_notification_job.rb up to PaypalBalanceCheckService. `return unless Rails.env.production?`
// finishes the job outside production; production builds the PayPal balance check (PayPal API, payout reads, a Redis write and the
// internal notification), which hands back to Rails before anything is read or written.
// Golden: __fixtures__/send-paypal-topup-notification-job.golden.json (scripts/golden/send-paypal-topup-notification-job.rb).
import { railsEnv } from "../../server/infra/rails-env.ts";
import { HandBackToRuby } from "../../server/jobs/hand-back.ts";

import { modelJob } from "./support/job-deps.ts";

export const sendPaypalTopupNotificationJobWith = modelJob({ min: 0, max: 1 }, () => {
  if (railsEnv() !== "production") return Promise.resolve();

  return Promise.reject(new HandBackToRuby("the PayPal balance check and top-up notification"));
});
export const sendPaypalTopupNotificationJob = sendPaypalTopupNotificationJobWith();
