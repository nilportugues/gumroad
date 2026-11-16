// Ruby: spec/models/affiliate_credit_spec.rb "purchase search index updates" (d51e63b75): a second save in the transaction
// clears previous_changes, and the commit callback still sees what the first save changed.
import { describe, expect, it } from "vitest";

import type { ModelRecord } from "../runtime/record.ts";

import { attributesCommitted, transactionalAttributeChangeTracker } from "./transactional-attribute-change-tracker.ts";

const tracker = transactionalAttributeChangeTracker<never>();
const run = (callbacks: { run: (record: never, ctx: never) => unknown }[], record: unknown) =>
  callbacks.forEach((callback) => callback.run(record as never, undefined as never));
const recordSaved = (savedChanges: Record<string, unknown>, record = { ivars: {} as Record<string, unknown> }) => {
  Object.assign(record, { savedChanges });
  run(tracker.afterSave, record);
  return record;
};

describe("TransactionalAttributeChangeTracker", () => {
  it("reports nothing before the transaction commits", () => {
    const record = recordSaved({ amount_cents: [null, 5] });
    expect(attributesCommitted(record as unknown as ModelRecord<never>)).toEqual([]);
  });

  it("keeps the attributes of an earlier save when a later save in the transaction changes nothing", () => {
    const record = recordSaved({ id: [null, 1], amount_cents: [null, 5] });
    recordSaved({}, record);
    run(tracker.beforeCommit, record);
    expect(attributesCommitted(record as unknown as ModelRecord<never>)).toEqual(["id", "amount_cents"]);
  });

  it("starts the next transaction empty", () => {
    const record = recordSaved({ amount_cents: [null, 5] });
    run(tracker.beforeCommit, record);
    recordSaved({}, record);
    run(tracker.beforeCommit, record);
    expect(attributesCommitted(record as unknown as ModelRecord<never>)).toEqual([]);
  });
});
