// Checks payment-intent-response.ts against the answers Rails gave in purchase-paid-order.golden.json: the same line item bodies, the
// same confirm token byte for byte (its random IV is read back from the recorded one), the same abandonment time.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  confirmOrderToken,
  failAbandonedPurchaseRunsAt,
  paymentIntentOutcome,
  processingResponse,
  requiresCardActionResponse,
} from "./payment-intent-response.ts";
import { decryptSecureExternalId } from "./secure-external-id.ts";

type GoldenCase = {
  name: string;
  responses: { line_items: Record<string, Record<string, unknown>> }[];
  statements: { job?: string; at?: number }[];
};
const here = dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(readFileSync(join(here, "__fixtures__/purchase-paid-order.golden.json"), "utf8")) as {
  now: string;
  cases: GoldenCase[];
};
const NOW = new Date(golden.now);
const named = (name: string) => golden.cases.find((candidate) => candidate.name === name)!;

const SAVED = { ...process.env };
beforeEach(() => {
  // .env.test, the keys the recording ran under
  process.env.SECURE_EXTERNAL_ID__PRIMARY_KEY_VERSION = "1";
  process.env.SECURE_EXTERNAL_ID__KEYS__1 = "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6";
});
afterEach(() => {
  process.env = { ...SAVED };
});

const recordedLine = () =>
  named("a requires_action intent").responses[0]!.line_items["uid-0"] as {
    order: { id: string; stripe_connect_account_id: string | null };
    intent_id: string;
    client_secret: string;
  };
const ivOf = (token: string) => {
  const outer = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as { d: string };
  return Buffer.from(outer.d.split("--")[1]!, "base64");
};

describe("a payment intent that is not settled", () => {
  it("builds the requires_card_action line item Rails answered, the order token included", () => {
    const recorded = recordedLine();
    const token = confirmOrderToken(1n, NOW, () => ivOf(recorded.order.id));

    expect(token).toBe(recorded.order.id);
    expect(
      requiresCardActionResponse({
        intentId: recorded.intent_id,
        clientSecret: recorded.client_secret,
        permalink: "paidone",
        orderToken: token,
        stripeConnectAccountId: null,
      }),
    ).toEqual(named("a requires_action intent").responses[0]!.line_items["uid-0"]);
    expect(decryptSecureExternalId("Order", token, "confirm", NOW)).toBe("1");
  });

  it("lets the order token expire after an hour", () => {
    const token = confirmOrderToken(1n, NOW);
    expect(decryptSecureExternalId("Order", token, "confirm", new Date(NOW.getTime() + 59 * 60 * 1000))).toBe("1");
    expect(decryptSecureExternalId("Order", token, "confirm", new Date(NOW.getTime() + 61 * 60 * 1000))).toBeNull();
  });

  it("builds the processing line item Rails answered", () => {
    expect(processingResponse("paidone")).toEqual(named("a processing intent").responses[0]!.line_items["uid-0"]);
  });

  it("schedules the abandonment check where Rails did", () => {
    const job = named("a requires_action intent").statements.find(
      (entry) => entry.job === "FailAbandonedPurchaseWorker",
    )!;
    expect(failAbandonedPurchaseRunsAt(NOW)).toBeCloseTo(job.at!, 3);
  });

  it.each([
    [{ status: "succeeded" }, "succeeded"],
    [{ status: "requires_action", next_action: { type: "use_stripe_sdk" } }, "requires_action"],
    [{ status: "requires_action", next_action: { type: "redirect_to_url" } }, "other"],
    [{ status: "requires_action", next_action: null }, "other"],
    [{ status: "processing" }, "processing"],
    [{ status: "requires_confirmation" }, "other"],
    [{ status: "requires_payment_method" }, "other"],
    [{ status: "canceled" }, "other"],
  ] as const)("classifies %j as %s", (intent, outcome) => {
    expect(paymentIntentOutcome(intent)).toBe(outcome);
  });
});
