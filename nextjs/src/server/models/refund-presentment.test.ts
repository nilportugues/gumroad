// Replays refund-presentment.golden.json (scripts/golden/refund-presentment.rb): Purchase::PresentmentRefund and
// Purchase#derive_presentment_refund_from_flow_of_funds as Ruby ran them. Node must send the statements Rails sent and answer,
// add and report what Ruby did.
import { beforeAll, describe, expect, it } from "vitest";

import { sqlReplay } from "../../worker/jobs/__fixtures__/sql-replay.ts";

import { isSql, loadGolden, setupSale, type GoldenCase } from "./__fixtures__/paid-sale-golden.ts";
import {
  allocateByLargestRemainder,
  derivePresentmentRefundFromFlowOfFunds,
  fromPresentmentAmount,
  presentmentRefundResult,
  presentmentTaxOnlyResult,
} from "./refund-presentment.ts";
import { uncached, withExecutor } from "./runtime/query-cache.ts";

type PresentmentCase = GoldenCase & {
  call: "derive" | "from_presentment_amount" | "result" | "tax_only_result";
  arguments: { currency?: string; cents?: number; canonical?: number };
  answer: unknown;
  errors: string[];
  notified: { message: string; context: Record<string, unknown> }[];
};
const golden = loadGolden("refund-presentment.golden.json") as unknown as { cases: PresentmentCase[] };

describe("Purchase::PresentmentRefund", () => {
  beforeAll(() => {
    // .env.test of the recording
    process.env.OBFUSCATE_IDS_CIPHER_KEY = "test-cipher-key";
    process.env.OBFUSCATE_IDS_NUMERIC_CIPHER_KEY = "123456789";
  });

  for (const c of golden.cases) {
    it(`sends the statements and answers as Ruby does for ${c.name}`, async () => {
      const { span, purchase } = setupSale(c, "presentment");
      const sql = sqlReplay(span.filter(isSql));
      const notified: PresentmentCase["notified"] = [];
      const { currency, cents, canonical } = c.arguments;

      const call = (): Promise<unknown> => {
        switch (c.call) {
          case "derive":
            return derivePresentmentRefundFromFlowOfFunds(
              purchase,
              {
                issuedAmount: { currency: currency!, cents: -cents! },
                settledAmount: { currency: currency!, cents: -cents! },
                gumroadAmount: { currency: currency!, cents: -cents! },
                merchantAccountGrossAmount: null,
                merchantAccountNetAmount: null,
              },
              (message, context) => notified.push({ message, context }),
            );
          case "from_presentment_amount":
            return fromPresentmentAmount(purchase, cents!);
          case "result":
            return presentmentRefundResult(purchase, canonical!);
          case "tax_only_result":
            return presentmentTaxOnlyResult(purchase, canonical!);
        }
      };

      const outcome = await withExecutor(() => uncached(call)).then(
        (answer) => ({ answer }),
        (error: unknown) => ({ error }),
      );

      expect(sql.log).toEqual(span.filter(isSql).map((entry) => entry.sql));
      if (c.error) {
        expect((outcome as { error: Error }).error.message).toBe(c.error.message);
        return;
      }
      expect((outcome as { answer: unknown }).answer).toEqual(c.answer);
      expect(purchase.errors.fullMessages()).toEqual(c.errors);
      expect(JSON.parse(JSON.stringify(notified, (_, v: unknown) => (typeof v === "bigint" ? Number(v) : v)))).toEqual(
        c.notified,
      );
    });
  }
});

describe("allocateByLargestRemainder", () => {
  it("gives every cent to the largest remainders first", () => {
    expect(allocateByLargestRemainder(100, [1, 1, 1], 3)).toEqual([34, 33, 33]);
  });

  it("answers zeros for a zero total weight", () => {
    expect(allocateByLargestRemainder(100, [0, 0], 0)).toEqual([0, 0]);
  });

  it("takes surplus cents back from the smallest remainders first", () => {
    expect(allocateByLargestRemainder(1, [1, 1, 1], 2)).toEqual([1, 0, 0]);
  });
});
