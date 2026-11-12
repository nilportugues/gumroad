// Port of the save/destroy lifecycle of ActiveRecord::Base (activerecord 8.1): Validations,
// Callbacks, Timestamp, Dirty and Transactions, composed in the order Rails runs them.
//
// create:  before_validation → validate → after_validation → before_save → timestamps →
//          before_create → INSERT → changes_applied → after_create → after_save → COMMIT → after_commit
// update:  same with before_update/after_update; updated_at is only touched when something changed
// destroy: before_destroy → DELETE → after_destroy → COMMIT → after_commit
//
// after_commit callbacks run in reverse definition order because config/application.rb sets
// run_after_transaction_callbacks_in_order_defined = false.
import { Prisma } from "@prisma/client";

import { castRow, column, quoteName, selectRows, table, tableName } from "../sql.ts";

import { AbortChain, RecordInvalid, RecordNotDestroyed, RecordNotFound, RecordNotSaved } from "./errors.ts";
import { clearQueryCache } from "./query-cache.ts";
import { ASSOCIATION_CACHE, ModelRecord, type Row } from "./record.ts";
import { participate, transaction, type Action, type Tx } from "./transaction.ts";

export type { Action };
// `now` is the clock of the save that runs the callback, for the records it saves in turn.
export type CallbackContext = { tx: Tx; now?: () => Date };

export type Callback<R extends Row> = {
  // The Ruby method name, kept so ordering can be checked against the Ruby source.
  name: string;
  on?: Action | Action[];
  if?: (record: ModelRecord<R>) => boolean;
  unless?: (record: ModelRecord<R>) => boolean;
  run: (record: ModelRecord<R>, ctx: CallbackContext) => unknown;
};

export type Delegate<R extends Row> = {
  create(args: { data: Partial<R> }): Promise<R>;
  update(args: { where: { id: unknown }; data: Partial<R> }): Promise<R>;
  delete(args: { where: { id: unknown } }): Promise<R>;
};

export type ModelDefinition<R extends Row> = {
  rubyClass: string;
  prismaModel: Prisma.ModelName;
  delegate: (tx: Tx) => Delegate<R>;
  recordTimestamps?: boolean;
  beforeValidation?: Callback<R>[];
  // Validators and `validate :method` callbacks, in declaration order.
  validations?: Callback<R>[];
  afterValidation?: Callback<R>[];
  beforeSave?: Callback<R>[];
  beforeCreate?: Callback<R>[];
  beforeUpdate?: Callback<R>[];
  afterCreate?: Callback<R>[];
  afterUpdate?: Callback<R>[];
  afterSave?: Callback<R>[];
  afterTouch?: Callback<R>[];
  beforeDestroy?: Callback<R>[];
  afterDestroy?: Callback<R>[];
  // before_commit
  beforeCommit?: Callback<R>[];
  // after_commit, after_create_commit (on: "create"), after_save_commit (on: ["create","update"]) ...
  afterCommit?: Callback<R>[];
  afterRollback?: Callback<R>[];
};

type ScalarField = { name: string; default: unknown; datetimePrecision: number | null; json: boolean };

const TIMESTAMP_COLUMNS = ["created_at", "created_on", "updated_at", "updated_on"];
const UPDATE_TIMESTAMP_COLUMNS = ["updated_at", "updated_on"];

function scalarFields(model: Prisma.ModelName): ScalarField[] {
  const dmmf = Prisma.dmmf.datamodel.models.find((m) => m.name === model);
  if (!dmmf) throw new Error(`Unknown Prisma model ${model}`);
  return (
    dmmf.fields
      .filter((f) => f.kind === "scalar" || f.kind === "enum")
      // Generated columns are owned by MySQL and must never be written.
      .filter((f) => !f.documentation?.startsWith("GENERATED"))
      .map((f) => {
        const literal = f.hasDefaultValue && (typeof f.default !== "object" || f.default === null) ? f.default : null;
        let value: unknown = literal;
        if (literal !== null && f.type === "BigInt") value = BigInt(literal as number);
        if (literal !== null && f.type === "Decimal") value = new Prisma.Decimal(literal as string);
        const native = f.nativeType as [string, string[]] | null | undefined;
        const precision = f.type === "DateTime" && native?.[0] === "DateTime" ? Number(native[1][0] ?? 6) : null;
        return { name: f.name, default: value, datetimePrecision: precision, json: f.type === "Json" };
      })
  );
}

// Rails truncates (never rounds) to the column precision; MySQL would round. JS dates only
// carry milliseconds, so precision >= 3 keeps them as-is.
function timestampFor(now: Date, precision: number | null): Date {
  if (precision === null || precision >= 3) return new Date(now.getTime());
  const unit = 10 ** (3 - precision);
  return new Date(Math.floor(now.getTime() / unit) * unit);
}

function applies<R extends Row>(cb: Callback<R>, record: ModelRecord<R>, action: Action): boolean {
  if (cb.on) {
    const on = Array.isArray(cb.on) ? cb.on : [cb.on];
    if (!on.includes(action)) return false;
  }
  if (cb.if && !cb.if(record)) return false;
  if (cb.unless && cb.unless(record)) return false;
  return true;
}

async function runChain<R extends Row>(
  chain: Callback<R>[] | undefined,
  record: ModelRecord<R>,
  action: Action,
  ctx: CallbackContext,
) {
  for (const cb of chain ?? []) {
    if (applies(cb, record, action)) await cb.run(record, ctx);
  }
}

const runningCommits = new WeakMap<object, { action: Action | null }>();

// `context` is `save(context: :name)`: validations declared `on: :create`/`:update` do not run under it, and `if:`/`unless:` read it from
// `record.validationContext` (OfferCode's price check skips `:expiring`).
export type SaveOptions = { validate?: boolean; now?: () => Date; context?: string };

export function defineModel<R extends Row>(def: ModelDefinition<R>) {
  let fields: ScalarField[] | null = null;
  const getFields = () => (fields ??= scalarFields(def.prismaModel));

  function build(attributes: Partial<R> = {}): ModelRecord<R> {
    const defaults = Object.fromEntries(getFields().map((f) => [f.name, f.default])) as R;
    const record = new ModelRecord<R>(defaults, { newRecord: true });
    record.assign(attributes);
    return record;
  }

  function load(row: R): ModelRecord<R> {
    return new ModelRecord<R>(row, { newRecord: false });
  }

  async function valid(record: ModelRecord<R>, ctx: CallbackContext, context?: string): Promise<boolean> {
    // Validations#valid?(context): a custom context replaces the default :create/:update one, so `on:` callbacks do not match it.
    const action = (context ?? (record.newRecord ? "create" : "update")) as Action;
    const outer = record.validationContext;
    record.validationContext = context ?? action;
    try {
      record.errors.clear();
      await runChain(def.beforeValidation, record, action, ctx);
      await runChain(def.validations, record, action, ctx);
      await runChain(def.afterValidation, record, action, ctx);
    } finally {
      record.validationContext = outer;
    }
    return record.errors.isEmpty();
  }

  function participant(record: ModelRecord<R>, action: Action) {
    const snapshot = { newRecord: record.newRecord, destroyed: record.destroyed, id: record.get("id") };
    return participate(record, action, () => ({
      identity: () => `${def.rubyClass}#${String(record.get("id"))}`,
      prepare: async (finalAction) => {
        for (const cb of def.beforeCommit ?? [])
          if (applies(cb, record, finalAction as Action)) await cb.run(record, { tx: null as unknown as Tx });
      },
      commit: async (finalAction) => {
        // committed! clears the record's trigger flags when it finishes, and `on:` is checked per
        // callback: once a callback saves the record again, the rest of the outer chain is skipped.
        const outer = runningCommits.get(record);
        const state = { action: finalAction as Action | null };
        runningCommits.set(record, state);
        try {
          // Reverse definition order (run_after_transaction_callbacks_in_order_defined = false).
          for (const cb of [...(def.afterCommit ?? [])].reverse()) {
            if (state.action && applies(cb, record, state.action)) await cb.run(record, { tx: null as unknown as Tx });
          }
        } finally {
          if (outer) outer.action = null;
          if (outer) runningCommits.set(record, outer);
          else runningCommits.delete(record);
        }
      },
      rollback: async (finalAction) => {
        for (const cb of [...(def.afterRollback ?? [])].reverse()) {
          if (applies(cb, record, finalAction)) await cb.run(record, { tx: null as unknown as Tx });
        }
      },
      // restore_transaction_record_state: a rolled-back create is a new record again.
      restore: () => {
        record.newRecord = snapshot.newRecord;
        record.destroyed = snapshot.destroyed;
        record.set("id", snapshot.id as R[keyof R & string]);
      },
    }));
  }

  function writableAttributes(record: ModelRecord<R>, names: string[]): Partial<R> {
    const out: Record<string, unknown> = {};
    const jsonColumns = new Set(
      getFields()
        .filter((f) => f.json)
        .map((f) => f.name),
    );
    for (const name of names) {
      if (name === "id" && record.get(name) == null) continue;
      const value = record.get(name);
      // ActiveRecord writes a nil JSON attribute as SQL NULL; Prisma would store the JSON literal null.
      out[name] = value === null && jsonColumns.has(name) ? Prisma.DbNull : value;
    }
    return out as Partial<R>;
  }

  // Returns false where Rails `save` returns false (invalid, or a before_* callback aborted).
  async function save(record: ModelRecord<R>, options: SaveOptions = {}): Promise<boolean> {
    if (record.destroyed) throw new Error(`Cannot save a destroyed ${def.rubyClass}`);
    const now = options.now ?? (() => new Date());
    return transaction(
      async (tx) => {
        const ctx = { tx, now };
        const action: Action = record.newRecord ? "create" : "update";
        const p = participant(record, action);
        if (options.validate !== false && !(await valid(record, ctx, options.context))) return false;
        try {
          await runChain(def.beforeSave, record, action, ctx);
          if (record.newRecord) {
            if (def.recordTimestamps !== false) {
              const current = now();
              for (const f of getFields()) {
                if (TIMESTAMP_COLUMNS.includes(f.name) && record.get(f.name) == null)
                  record.set(f.name, timestampFor(current, f.datetimePrecision) as R[keyof R & string]);
              }
            }
            await runChain(def.beforeCreate, record, action, ctx);
            // partial_inserts is off by default: Rails inserts every column.
            const inserted = await def.delegate(tx).create({
              data: writableAttributes(
                record,
                getFields().map((f) => f.name),
              ),
            });
            record.syncFromDatabase({ id: inserted.id } as unknown as Partial<R>);
            record.newRecord = false;
            record.changesApplied();
            p.triggered = true;
            await runChain(def.afterCreate, record, action, ctx);
          } else {
            // Timestamp#_update_record stamps before the update callbacks and Callbacks#_update_record
            // again inside them, so a change made only by a before_update is stamped too.
            const recordUpdateTimestamps = () => {
              if (def.recordTimestamps === false || !record.hasChangesToSave()) return;
              const current = now();
              for (const f of getFields()) {
                if (UPDATE_TIMESTAMP_COLUMNS.includes(f.name) && !record.attributeChanged(f.name))
                  record.set(f.name, timestampFor(current, f.datetimePrecision) as R[keyof R & string]);
              }
            };
            recordUpdateTimestamps();
            await runChain(def.beforeUpdate, record, action, ctx);
            recordUpdateTimestamps();
            const changed = record.changedAttributeNames();
            if (changed.length > 0)
              await def
                .delegate(tx)
                .update({ where: { id: record.get("id") }, data: writableAttributes(record, changed) });
            record.changesApplied();
            // _update_record sets @_trigger_update_callback even when nothing changed.
            p.triggered = true;
            await runChain(def.afterUpdate, record, action, ctx);
          }
          await runChain(def.afterSave, record, action, ctx);
          return true;
        } catch (error) {
          if (error instanceof AbortChain) return false;
          throw error;
        }
      },
      { returningStatus: true },
    );
  }

  // Persistence#touch with no names: updated_at alone is written, the change is applied at once (Dirty#_touch_row) and
  // after_touch runs inside the transaction. A touch that would set other pending changes aside is not ported.
  // `deferred` is `touch_later`, which a `belongs_to touch: true` parent gets: recorded in golden to leave the attributes in column order,
  // where a direct touch lists updated_at first.
  async function touch(
    record: ModelRecord<R>,
    options: { now?: () => Date; deferred?: boolean } = {},
  ): Promise<boolean> {
    if (!record.persisted) throw new Error(`cannot touch on a new or destroyed record object`);
    const now = options.now ?? (() => new Date());
    const columns = getFields().filter((f) => UPDATE_TIMESTAMP_COLUMNS.includes(f.name));
    if (columns.length === 0) return true;
    return transaction(
      async (tx) => {
        const p = participant(record, "update");
        const current = now();
        if (options.deferred) record.materializeAll();
        for (const f of columns) record.set(f.name, timestampFor(current, f.datetimePrecision) as R[keyof R & string]);
        const touched = columns.map((f) => f.name);
        if (record.changedAttributeNames().some((name) => !touched.includes(name))) {
          throw new Error(`touch with pending changes to ${def.rubyClass} is not ported`);
        }
        await def.delegate(tx).update({ where: { id: record.get("id") }, data: writableAttributes(record, touched) });
        record.changesApplied();
        p.triggered = true;
        await runChain(def.afterTouch, record, "update", { tx, now });
        return true;
      },
      { returningStatus: true },
    );
  }

  async function saveBang(record: ModelRecord<R>, options: SaveOptions = {}): Promise<ModelRecord<R>> {
    if (await save(record, options)) return record;
    if (!record.errors.isEmpty()) throw new RecordInvalid(record.errors);
    throw new RecordNotSaved();
  }

  async function destroy(record: ModelRecord<R>): Promise<boolean> {
    return transaction(
      async (tx) => {
        const ctx = { tx };
        const p = participant(record, "destroy");
        try {
          await runChain(def.beforeDestroy, record, "destroy", ctx);
        } catch (error) {
          if (error instanceof AbortChain) return false;
          throw error;
        }
        if (record.persisted) await def.delegate(tx).delete({ where: { id: record.get("id") } });
        record.destroyed = true;
        p.destroyed = true;
        p.triggered = true;
        await runChain(def.afterDestroy, record, "destroy", ctx);
        return true;
      },
      { returningStatus: true },
    );
  }

  // Persistence#reload (`lock: true` for lock!): a fresh row, with the association cache and the
  // attribute set replaced as `find` builds them.
  async function reload(record: ModelRecord<R>, options: { lock?: boolean } = {}): Promise<ModelRecord<R>> {
    clearQueryCache();
    const name = tableName(def.prismaModel);
    const [row] = await selectRows(
      Prisma.sql`SELECT ${Prisma.raw(`${quoteName(name)}.*`)} FROM ${table(name)} WHERE ${column(name, "id")} = ${record.get("id")} LIMIT 1${options.lock ? Prisma.raw(" FOR UPDATE") : Prisma.empty}`,
    );
    if (!row) throw new RecordNotFound(`Couldn't find ${def.rubyClass}`);
    record.replaceFromDatabase(castRow<R>(def.prismaModel, row));
    delete record.ivars[ASSOCIATION_CACHE];
    record.ivars.previously_new_record = false;
    return record;
  }

  // Locking::Pessimistic#lock!
  async function lockBang(record: ModelRecord<R>): Promise<ModelRecord<R>> {
    if (!record.persisted) return record;
    if (record.hasChangesToSave()) {
      throw new Error(
        `Locking a record with unpersisted changes is not supported. Use \`save\` to persist the changes, or \`reload\` to discard them explicitly. Changed attributes: ${record
          .changedAttributeNames()
          .map((n) => JSON.stringify(n))
          .join(", ")}.`,
      );
    }
    return reload(record, { lock: true });
  }

  return {
    definition: def,
    build,
    load,
    reload,
    lockBang,
    // Locking::Pessimistic#with_lock: lock! inside a (joined) transaction.
    withLock<T>(record: ModelRecord<R>, fn: () => Promise<T>): Promise<T> {
      return transaction(async () => {
        await lockBang(record);
        return fn();
      });
    },
    // `valid?` outside a save still runs inside a transaction so uniqueness checks see a client.
    valid: (record: ModelRecord<R>, context?: string) => transaction((tx) => valid(record, { tx }, context)),
    save,
    touch,
    saveBang,
    async create(attributes: Partial<R>, options?: SaveOptions) {
      const record = build(attributes);
      await save(record, options);
      return record;
    },
    async createBang(attributes: Partial<R>, options?: SaveOptions) {
      return saveBang(build(attributes), options);
    },
    async update(record: ModelRecord<R>, attributes: Partial<R>, options?: SaveOptions) {
      record.assign(attributes);
      return save(record, options);
    },
    async updateBang(record: ModelRecord<R>, attributes: Partial<R>, options?: SaveOptions) {
      record.assign(attributes);
      return saveBang(record, options);
    },
    destroy,
    async destroyBang(record: ModelRecord<R>) {
      if (!(await destroy(record))) throw new RecordNotDestroyed();
      return record;
    },
  };
}

export type ModelService<R extends Row> = ReturnType<typeof defineModel<R>>;
