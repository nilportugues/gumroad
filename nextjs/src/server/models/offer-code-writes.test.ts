import type { OfferCode } from "@prisma/client";
import { beforeEach, describe, expect, it } from "vitest";

import { EXPIRING_CONTEXT, loadOfferCode, OfferCodes } from "./offer-code-writes.ts";
import { fakeDatabase } from "./runtime/testing.ts";

const PRICE_MESSAGE = "Please enter a positive discount amount.";

// A code with a negative discount fails the price check before it reads any product, so no query is needed to see it fire.
const row = (): OfferCode =>
  ({
    id: 7,
    code: "TENOFF",
    user_id: 1,
    universal: false,
    amount_percentage: -5,
    amount_cents: null,
    currency_type: null,
    deleted_at: null,
    flags: 0n,
    auto_apply: false,
    created_at: new Date("2026-01-01T00:00:00Z"),
    updated_at: new Date("2026-01-01T00:00:00Z"),
  }) as unknown as OfferCode;

beforeEach(() => {
  fakeDatabase().nextQueryResult([{ one: 1 }]);
});

describe("OfferCodes validation context", () => {
  it("runs the price validation in the default context", async () => {
    const record = loadOfferCode(row());

    expect(await OfferCodes.valid(record)).toBe(false);
    expect(record.errors.fullMessages()).toContain(PRICE_MESSAGE);
  });

  it("skips the price validation in the expiring context, so a code the prices already fail can be ended", async () => {
    const record = loadOfferCode(row());
    await OfferCodes.valid(record, EXPIRING_CONTEXT);

    expect(record.errors.fullMessages()).not.toContain(PRICE_MESSAGE);
    expect(record.validationContext).toBeNull();
  });

  it("still runs the other validations in the expiring context", async () => {
    const record = loadOfferCode({
      ...row(),
      amount_percentage: 10,
      valid_at: new Date("2026-02-02T00:00:00Z"),
      expires_at: new Date("2026-02-01T00:00:00Z"),
    });

    expect(await OfferCodes.valid(record, EXPIRING_CONTEXT)).toBe(false);
    expect(record.errors.fullMessages()).toContain("The discount code's start date must be earlier than its end date.");
  });
});
