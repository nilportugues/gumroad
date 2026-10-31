// Port of app/modules/deletable.rb: soft deletion through deleted_at.
import { Prisma } from "@prisma/client";

import type { ModelService, SaveOptions } from "../runtime/define-model";
import type { ModelRecord, Row } from "../runtime/record";

type DeletableRow = Row & { deleted_at: Date | null };

// `alive` and `deleted` scopes, as Prisma where clauses.
export const alive = { deleted_at: null } as const;
export const deleted = { deleted_at: { not: null } } as const;

// Assigning Time.current casts it to the column precision by truncation; MySQL would round a
// millisecond value sent as-is, so a datetime(0) column could land a second late.
function deletedAtPrecision(model: Prisma.ModelName): number {
  const field = Prisma.dmmf.datamodel.models.find((m) => m.name === model)?.fields.find((f) => f.name === "deleted_at");
  const native = field?.nativeType as [string, string[]] | null | undefined;
  return native?.[0] === "DateTime" ? Number(native[1][0] ?? 6) : 6;
}

export function deletable<R extends DeletableRow>(service: ModelService<R>) {
  let precision: number | null = null;
  const current = (options: SaveOptions) => {
    const now = (options.now ?? (() => new Date()))();
    precision ??= deletedAtPrecision(service.definition.prismaModel);
    if (precision >= 3) return now;
    const unit = 10 ** (3 - precision);
    return new Date(Math.floor(now.getTime() / unit) * unit);
  };
  const mark = (record: ModelRecord<R>, value: Date | null) => record.set("deleted_at", value as R["deleted_at"]);
  return {
    // `validate: false` lets account closure delete a row that no longer validates while still
    // running callbacks and writing PaperTrail versions, which an update_all would skip.
    markDeletedBang(record: ModelRecord<R>, options: SaveOptions = {}) {
      mark(record, current(options));
      return service.saveBang(record, options);
    },
    markDeleted(record: ModelRecord<R>, options: SaveOptions = {}) {
      mark(record, current(options));
      return service.save(record, options);
    },
    markUndeletedBang(record: ModelRecord<R>) {
      mark(record, null);
      return service.saveBang(record);
    },
    markUndeleted(record: ModelRecord<R>) {
      mark(record, null);
      return service.save(record);
    },
    isAlive: (record: ModelRecord<R>) => record.get("deleted_at") == null,
    isDeleted: (record: ModelRecord<R>) => record.get("deleted_at") != null,
    beingMarkedAsDeleted: (record: ModelRecord<R>) => record.attributeChanged("deleted_at", { from: null }),
  };
}
