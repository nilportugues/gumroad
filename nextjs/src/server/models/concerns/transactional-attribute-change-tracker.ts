// app/models/concerns/transactional_attribute_change_tracker.rb: every attribute saved in the transaction, as
// `attributes_committed` once it commits (`previous_changes` only holds the last save's).
import type { Callback } from "../runtime/define-model.ts";
import type { ModelRecord, Row } from "../runtime/record.ts";

const CHANGED_IN_TRANSACTION = "attributesChangedInTransaction";
const COMMITTED = "attributesCommitted";

export function transactionalAttributeChangeTracker<R extends Row>(): {
  afterSave: Callback<R>[];
  beforeCommit: Callback<R>[];
} {
  return {
    afterSave: [
      {
        name: "TransactionalAttributeChangeTracker after_save",
        run(record) {
          record.ivars[COMMITTED] = null;
          const changed = (record.ivars[CHANGED_IN_TRANSACTION] ??= new Set<string>()) as Set<string>;
          for (const name of Object.keys(record.savedChanges)) changed.add(name);
        },
      },
    ],
    beforeCommit: [
      {
        name: "TransactionalAttributeChangeTracker before_commit",
        run(record) {
          const changed = record.ivars[CHANGED_IN_TRANSACTION] as Set<string> | undefined;
          if (changed === undefined) return;
          record.ivars[COMMITTED] = [...changed];
          changed.clear();
        },
      },
    ],
  };
}

export const attributesCommitted = <R extends Row>(record: ModelRecord<R>): string[] =>
  (record.ivars[COMMITTED] as string[] | null | undefined) ?? [];
