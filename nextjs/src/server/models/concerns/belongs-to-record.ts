// `record.association` for a belongs_to whose target is itself a record (so it has associations of
// its own, as `credit.user` or `balance_transaction.merchant_account` do). The association cache of
// rails-validations.ts holds the row; this keeps one record per cached row, so a second reader gets
// the same object and what that object loaded in turn, as Rails' association target does.
import type { ModelService } from "../runtime/define-model.ts";
import type { ModelRecord, Row } from "../runtime/record.ts";
import { connection } from "../sql.ts";
import { loadBelongsTo, setAssociation, type BelongsTo } from "./rails-validations.ts";

const records = new WeakMap<object, ModelRecord>();

// `owner.name = target` (and `Model.new(name: target)`): the foreign key follows the target.
export function assignBelongsTo<R extends Row, T extends Row>(owner: ModelRecord<R>, association: BelongsTo, target: ModelRecord<T> | null): void {
  const primaryKey = association.primaryKey ?? "id";
  const foreignKey = target === null ? null : coerce(target.get(primaryKey), owner.get(association.foreignKey as keyof R & string));
  owner.set(association.foreignKey as keyof R & string, foreignKey as R[keyof R & string]);
  if (target === null) {
    setAssociation(owner, association.name, null, null);
    return;
  }
  const row = { ...target.attributes } as Row;
  records.set(row, target);
  setAssociation(owner, association.name, foreignKey, row);
}

// A BigInt primary key into an Int foreign key column (and back) keeps the column's own type.
function coerce(value: unknown, current: unknown): unknown {
  if (typeof current === "number" && typeof value === "bigint") return Number(value);
  if (typeof current === "bigint" && typeof value === "number") return BigInt(value);
  return value;
}

export async function readBelongsTo<R extends Row, T extends Row>(owner: ModelRecord<R>, association: BelongsTo, service: Pick<ModelService<T>, "load">): Promise<ModelRecord<T> | null> {
  const row = await loadBelongsTo(owner, association, { tx: (await connection()) as never });
  if (!row) return null;
  let record = records.get(row) as ModelRecord<T> | undefined;
  if (!record) {
    record = service.load(row as T);
    records.set(row, record);
  }
  return record;
}
