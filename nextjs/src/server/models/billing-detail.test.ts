import type { BillingDetail } from "@prisma/client";
import { beforeEach, describe, expect, it } from "vitest";

import { setAssociation } from "./concerns/rails-validations.ts";
import { BillingDetails } from "./billing-detail.ts";
import type { ModelRecord } from "./runtime/record.ts";
import { fakeDatabase } from "./runtime/testing.ts";

const PURCHASER_ID = 7n;

let db: ReturnType<typeof fakeDatabase>;

// The purchaser is cached as loaded, so the belongs_to check runs without a query of its own.
function detailWith(attributes: Partial<BillingDetail>): ModelRecord<BillingDetail> {
  const record = BillingDetails.build({
    purchaser_id: PURCHASER_ID,
    full_name: "Alice GmbH",
    street_address: "1 Unter den Linden",
    city: "Berlin",
    zip_code: "10115",
    country_code: "DE",
    ...attributes,
  });
  setAssociation(record, "purchaser", PURCHASER_ID, { id: PURCHASER_ID });
  return record;
}

beforeEach(() => {
  db = fakeDatabase();
});

describe("BillingDetail validations", () => {
  it("is valid with the required fields for a non-US address", async () => {
    expect(await BillingDetails.valid(detailWith({}))).toBe(true);
  });

  it("requires a state for a US address", async () => {
    const record = detailWith({ country_code: "US", state: null });

    expect(await BillingDetails.valid(record)).toBe(false);
    expect(record.errors.on("state")).toEqual(["can't be blank"]);
  });

  it("does not require a state outside the US", async () => {
    expect(await BillingDetails.valid(detailWith({ country_code: "DE", state: null }))).toBe(true);
  });

  it("reports blank required fields in declaration order", async () => {
    const record = detailWith({ full_name: "", city: "" });

    expect(await BillingDetails.valid(record)).toBe(false);
    expect(record.errors.details.map((error) => error.attribute)).toEqual(["full_name", "city"]);
    expect(record.errors.on("full_name")).toEqual(["can't be blank"]);
  });

  it("requires a two-character country code", async () => {
    const record = detailWith({ country_code: "DEU" });

    expect(await BillingDetails.valid(record)).toBe(false);
    expect(record.errors.on("country_code")).toEqual(["is the wrong length (should be 2 characters)"]);
  });

  it("rejects a second billing detail for the same purchaser", async () => {
    db.nextQueryResult([{ id: 1 }]);
    const record = detailWith({});

    expect(await BillingDetails.valid(record)).toBe(false);
    expect(record.errors.on("purchaser_id")).toEqual(["has already been taken"]);
  });
});

describe("BillingDetail saves", () => {
  it("inserts a new row with timestamps and writes nothing else", async () => {
    const now = new Date("2026-01-02T03:04:05.000Z");
    const record = detailWith({});

    expect(await BillingDetails.save(record, { now: () => now })).toBe(true);

    expect(db.committed).toEqual([
      expect.objectContaining({
        model: "billingDetail",
        op: "create",
        data: expect.objectContaining({ purchaser_id: PURCHASER_ID, full_name: "Alice GmbH", created_at: now, updated_at: now }),
      }),
    ]);
  });

  it("leaves the row untouched when a save changes nothing", async () => {
    const now = new Date("2026-01-02T03:04:05.000Z");
    const record = BillingDetails.load({
      id: 3n,
      purchaser_id: PURCHASER_ID,
      full_name: "Alice GmbH",
      business_name: null,
      business_id: null,
      street_address: "1 Unter den Linden",
      city: "Berlin",
      state: null,
      zip_code: "10115",
      country_code: "DE",
      additional_notes: null,
      auto_email_invoice_enabled: true,
      created_at: now,
      updated_at: now,
    } as BillingDetail);
    setAssociation(record, "purchaser", PURCHASER_ID, { id: PURCHASER_ID });

    expect(await BillingDetails.save(record, { now: () => new Date("2026-02-02T00:00:00.000Z") })).toBe(true);

    expect(db.committed.filter((write) => write.op === "update")).toEqual([]);
  });

  it("saves nothing when a validation fails", async () => {
    const record = detailWith({ full_name: "" });

    expect(await BillingDetails.save(record)).toBe(false);
    expect(db.committed).toEqual([]);
  });
});
