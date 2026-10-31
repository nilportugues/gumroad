import type { ErrorEvent, NodeOptions } from "@sentry/node";
import { afterEach, describe, expect, it } from "vitest";

import { sentryOptions } from "./error-reporting";

type TransactionEvent = Parameters<NonNullable<NodeOptions["beforeSendTransaction"]>>[0];

describe("Sentry options match config/initializers/sentry.rb", () => {
  const savedEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it("reports only from production and staging", () => {
    process.env.RAILS_ENV = "development";
    expect(sentryOptions().enabled).toBe(false);
    process.env.RAILS_ENV = "staging";
    expect(sentryOptions().enabled).toBe(true);
    expect(sentryOptions()).toMatchObject({ sendDefaultPii: true, tracesSampleRate: 0.001, environment: "staging" });
  });

  it("drops events and transactions for the retired gumhead routes", () => {
    const { beforeSend, beforeSendTransaction } = sentryOptions();
    const request = { url: "https://api.gumroad.com/v2/gumhead/prompt" };
    expect(beforeSend?.({ type: undefined, request } as ErrorEvent, {})).toBeNull();
    expect(beforeSendTransaction?.({ type: "transaction", request } as TransactionEvent, {})).toBeNull();
  });

  it("keeps only sizes of a support contact job's message and attachments", () => {
    const event = {
      type: undefined,
      tags: { job_id: "abc" },
      extra: {
        arguments: [
          "SupportContactMailer",
          "deliver_now",
          { args: [{ message: "héllo", attachments: ["a", "b"], email: "buyer@example.com" }] },
        ],
      },
    } as unknown as ErrorEvent;
    const result = sentryOptions().beforeSend?.(event, {}) as ErrorEvent;
    expect(result.extra?.arguments).toEqual([
      "SupportContactMailer",
      "deliver_now",
      { args: [{ message: 5, attachments: 2, email: "buyer@example.com" }] },
    ]);
  });
});
