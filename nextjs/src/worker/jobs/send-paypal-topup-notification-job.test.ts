// Replays send-paypal-topup-notification-job.golden.json (scripts/golden/send-paypal-topup-notification-job.rb): the job run by the real
// app as a Sidekiq job in each Rails environment. Node finishes outside production without touching the database or Redis, and hands
// production back before the PayPal balance check.
import { afterAll, beforeAll, describe } from "vitest";

import { loadGolden, replayJobGolden, type JobCase } from "./__fixtures__/replay-job-golden.ts";
import { sendPaypalTopupNotificationJobWith } from "./send-paypal-topup-notification-job.ts";

const golden = loadGolden(new URL("./__fixtures__/send-paypal-topup-notification-job.golden.json", import.meta.url));
const envOf = (c: JobCase) => (c as JobCase & { rails_env: string }).rails_env;

for (const env of [...new Set(golden.cases.map(envOf))]) {
  describe(`in ${env}`, () => {
    let original: string | undefined;
    beforeAll(() => {
      original = process.env.RAILS_ENV;
      process.env.RAILS_ENV = env;
    });
    afterAll(() => {
      if (original === undefined) delete process.env.RAILS_ENV;
      else process.env.RAILS_ENV = original;
    });
    replayJobGolden(
      "SendPaypalTopupNotificationJob",
      { now: golden.now, cases: golden.cases.filter((c) => envOf(c) === env) },
      sendPaypalTopupNotificationJobWith(),
      (c) => c.hands_back === true,
    );
  });
}
