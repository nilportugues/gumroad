import type { DisputeEvidence } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { setPaperTrailEnabled } from "./concerns/paper-trail.ts";
import { DisputeEvidences } from "./dispute-evidence-writes.ts";
import { RecordInvalid } from "./runtime/errors.ts";
import { fakeDatabase } from "./runtime/testing.ts";

setPaperTrailEnabled(false);

const evidence = (overrides: Partial<DisputeEvidence> = {}) =>
  DisputeEvidences.load({
    id: 9n,
    dispute_id: 4n,
    purchased_at: null,
    customer_purchase_ip: null,
    customer_email: "customer@example.com",
    customer_name: null,
    billing_address: null,
    shipping_address: null,
    shipped_at: null,
    shipping_carrier: null,
    shipping_tracking_number: null,
    uncategorized_text: null,
    created_at: new Date("2026-01-01T00:00:00Z"),
    updated_at: new Date("2026-01-01T00:00:00Z"),
    product_description: null,
    cancellation_policy_disclosure: null,
    refund_policy_disclosure: null,
    cancellation_rebuttal: null,
    refund_refusal_explanation: null,
    seller_contacted_at: new Date("2026-01-01T00:00:00Z"),
    seller_submitted_at: null,
    resolved_at: null,
    resolution: "unknown",
    error_message: null,
    access_activity_log: null,
    reason_for_winning: null,
    ...overrides,
  });

const blob = (name: string, byteSize: number, contentType: string) => ({
  name,
  byte_size: BigInt(byteSize),
  content_type: contentType,
});

async function errorsOf(record: ReturnType<typeof evidence>): Promise<string[]> {
  try {
    await DisputeEvidences.saveBang(record);
  } catch (error) {
    if (error instanceof RecordInvalid) return error.errors.fullMessages();
    throw error;
  }
  return [];
}

describe("DisputeEvidence statement saves", () => {
  it("strips and squeezes a statement and clears a blank one", async () => {
    const db = fakeDatabase();
    const record = evidence({ cancellation_rebuttal: "Written yesterday" });
    record.assign({ reason_for_winning: "  Used   the product  ", cancellation_rebuttal: "" });
    record.set("seller_submitted_at", new Date("2026-02-01T00:00:00Z"));

    expect(await errorsOf(record)).toEqual([]);

    expect(db.committed).toEqual([
      expect.objectContaining({
        model: "disputeEvidence",
        op: "update",
        id: 9n,
        data: expect.objectContaining({ reason_for_winning: "Used the product", cancellation_rebuttal: null }),
      }),
    ]);
  });

  it("refuses a statement over 3000 characters, counting characters and not bytes", async () => {
    fakeDatabase();
    const record = evidence();
    record.assign({
      reason_for_winning: "é".repeat(3_000),
      cancellation_rebuttal: "b".repeat(3_001),
      refund_refusal_explanation: "c".repeat(3_001),
    });

    expect(await errorsOf(record)).toEqual([
      "Cancellation rebuttal is too long (maximum is 3000 characters)",
      "Refund refusal explanation is too long (maximum is 3000 characters)",
    ]);
  });

  it("adds no file query for a statement over a row without attachments", async () => {
    const db = fakeDatabase();
    const record = evidence();
    record.assign({ reason_for_winning: "Used the product" });

    await errorsOf(record);

    expect(db.queries).toHaveLength(1);
    expect(db.queries[0]!.sql).toContain("active_storage_attachments");
  });

  it("refuses an attached communication file over what the receipt leaves of the combined limit", async () => {
    const db = fakeDatabase();
    db.queueQueryResults([
      blob("receipt_image", 4_000_000, "image/png"),
      blob("customer_communication_file", 2_000_000, "application/pdf"),
    ]);
    const record = evidence();
    record.assign({ reason_for_winning: "Used the product" });

    expect(await errorsOf(record)).toEqual([
      "The file exceeds the maximum size allowed.",
      "Uploaded files exceed the maximum size allowed by Stripe.",
    ]);
  });

  it("refuses an attached communication file of a type Stripe does not take", async () => {
    const db = fakeDatabase();
    db.queueQueryResults([blob("customer_communication_file", 1_000, "text/plain")]);
    const record = evidence();
    record.assign({ reason_for_winning: "Used the product" });

    expect(await errorsOf(record)).toEqual(["Invalid file type."]);
  });

  it("counts the cancellation policy image for a subscription purchase and ignores it otherwise", async () => {
    const files = [
      blob("cancellation_policy_image", 3_000_000, "image/png"),
      blob("customer_communication_file", 2_500_000, "application/pdf"),
    ];
    const subscription = fakeDatabase();
    subscription.queueQueryResults(files, [{ charge_id: null, purchase_id: 5 }], [{ one: 1n }]);
    const first = evidence();
    first.assign({ reason_for_winning: "Used the product" });

    expect(await errorsOf(first)).toEqual([
      "The file exceeds the maximum size allowed.",
      "Uploaded files exceed the maximum size allowed by Stripe.",
    ]);

    const plain = fakeDatabase();
    plain.queueQueryResults(files, [{ charge_id: null, purchase_id: 5 }], []);
    const second = evidence();
    second.assign({ reason_for_winning: "Used the product" });

    expect(await errorsOf(second)).toEqual([]);
  });
});
