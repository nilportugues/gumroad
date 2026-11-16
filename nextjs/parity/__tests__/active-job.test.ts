import { describe, expect, it } from "vitest";

import { JOB_WRAPPER, unwrapActiveJob } from "../src/active-job";

describe("unwrapActiveJob", () => {
  it("reports a wrapped mail as the mailer job with its arguments and queue", () => {
    const arguments_ = [
      "AffiliateMailer",
      "direct_affiliate_removal",
      "deliver_now",
      { args: [7], _aj_ruby2_keywords: ["args"] },
    ];
    const wrapped = {
      class: JOB_WRAPPER,
      args: [{ job_class: "MailDeliveryJob", queue_name: "default", arguments: arguments_ }],
      queue: "default",
    };
    expect(unwrapActiveJob(wrapped)).toEqual({
      class: "MailDeliveryJob",
      args: arguments_,
      queue: "default",
      activeJob: true,
    });
  });

  it("leaves a plain Sidekiq job alone", () => {
    const job = { class: "RefreshAudienceMemberJob", args: ["a@example.com", 1], queue: "low" };
    expect(unwrapActiveJob(job)).toBe(job);
  });
});
