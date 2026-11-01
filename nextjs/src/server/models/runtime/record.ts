// Port of the parts of ActiveRecord::Base an instance carries between callbacks: attributes,
// ActiveModel::Dirty change tracking and the new/persisted/destroyed state (activerecord 8.1).
import { Prisma } from "@prisma/client";

import { Errors } from "./errors.ts";

export type Row = Record<string, unknown>;

// The ivar holding loaded associations (@association_cache), which reload discards.
export const ASSOCIATION_CACHE = "associations";
export type Change = [before: unknown, after: unknown];

// Rails compares type-cast values, so a Date or Decimal with the same value is not a change.
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (Prisma.Decimal.isDecimal(a) && Prisma.Decimal.isDecimal(b)) return (a as Prisma.Decimal).equals(b as Prisma.Decimal);
  if (typeof a === "bigint" || typeof b === "bigint") return BigInt(a as bigint) === BigInt(b as bigint);
  if (typeof a === "object" && typeof b === "object") return JSON.stringify(a) === JSON.stringify(b);
  return false;
}

export class ModelRecord<R extends Row = Row> {
  readonly errors = new Errors();
  newRecord: boolean;
  destroyed = false;
  // saved_changes / previous_changes after the last save.
  savedChanges: Partial<Record<keyof R & string, Change>> = {};
  // Free-form per-instance state that Ruby keeps in instance variables (attr_accessor etc.).
  readonly ivars: Record<string, unknown> = {};
  #attributes: R;
  #inDatabase: R;
  // ActiveModel::LazyAttributeSet: a loaded record materializes an attribute when it is written or
  // dirty-checked (a plain read does not), and changes_applied fixes that order for good. It is the
  // order of `attributes` after a save, so PaperTrail's `object` follows it. A new record's
  // attributes come from the column defaults, already in column order.
  #order: string[];
  #lazy: boolean;
  #untracked = 0;

  constructor(attributes: R, options: { newRecord: boolean; inDatabase?: R }) {
    this.#attributes = { ...attributes };
    this.#inDatabase = { ...(options.inDatabase ?? attributes) };
    this.newRecord = options.newRecord;
    this.#lazy = !options.newRecord;
    this.#order = this.#lazy ? [] : Object.keys(attributes);
  }

  #touch(name: string): void {
    if (this.#lazy && this.#untracked === 0 && !this.#order.includes(name)) this.#order.push(name);
  }

  // Anything that calls `attributes.keys` (has_changes_to_save?, changed, changes) touches every
  // attribute in column order.
  materializeAll(): void {
    if (!this.#lazy || this.#untracked > 0) return;
    for (const name of Object.keys(this.#attributes)) if (!this.#order.includes(name)) this.#order.push(name);
  }

  // The order `attributes` returns: a lazy set still answers in column order.
  attributeOrder(): string[] {
    return this.#lazy ? Object.keys(this.#attributes) : [...this.#order, ...Object.keys(this.#attributes).filter((k) => !this.#order.includes(k))];
  }

  // A read Ruby makes through an attribute reader that leaves the attribute materialized (a loaded association's
  // foreign key), which PaperTrail's `object` lists ahead of the ones nothing touched.
  touch(name: keyof R & string): void {
    this.#touch(name);
  }

  // Checks the port makes that Ruby does not (guards for unported work, assertions), so they must
  // not materialize anything.
  untracked<T>(fn: () => T): T {
    this.#untracked++;
    try {
      return fn();
    } finally {
      this.#untracked--;
    }
  }

  // `reload`: a fresh LazyAttributeSet from the row, as `find` returns it.
  replaceFromDatabase(row: R): void {
    this.#attributes = { ...row };
    this.#inDatabase = { ...row };
    this.newRecord = false;
    this.#lazy = true;
    this.#order = [];
  }

  // clear_attribute_changes: the current values become the database values.
  clearAttributeChanges(names: (keyof R & string)[]): void {
    for (const name of names) {
      this.#touch(name);
      this.#inDatabase[name] = this.#attributes[name];
    }
  }

  get attributes(): Readonly<R> {
    return this.#attributes;
  }

  get<K extends keyof R & string>(name: K): R[K] {
    return this.#attributes[name];
  }

  set<K extends keyof R & string>(name: K, value: R[K]): void {
    this.#touch(name);
    this.#attributes[name] = value;
  }

  assign(values: Partial<R>): void {
    for (const [k, v] of Object.entries(values)) this.set(k as keyof R & string, v as R[keyof R & string]);
  }

  get persisted(): boolean {
    return !this.newRecord && !this.destroyed;
  }

  attributeInDatabase<K extends keyof R & string>(name: K): R[K] {
    this.#touch(name);
    return this.#inDatabase[name];
  }

  // `<attr>_was`: for a new record every attribute "was" its default, as in Rails.
  attributeWas<K extends keyof R & string>(name: K): R[K] {
    this.#touch(name);
    return this.#inDatabase[name];
  }

  attributeChanged(name: keyof R & string, opts: { from?: unknown; to?: unknown } = {}): boolean {
    this.#touch(name);
    const was = this.#inDatabase[name];
    const now = this.#attributes[name];
    if (sameValue(was, now)) return false;
    if ("from" in opts && !sameValue(was, opts.from)) return false;
    if ("to" in opts && !sameValue(now, opts.to)) return false;
    return true;
  }

  // Column order, as ActiveModel::AttributeMutationTracker#changed_attribute_names returns them.
  changedAttributeNames(): (keyof R & string)[] {
    this.materializeAll();
    // After a save the set keeps the order its attributes were first written in, so a second update lists them so.
    return (this.attributeOrder() as (keyof R & string)[]).filter((k) => this.attributeChanged(k));
  }

  changes(): Partial<Record<keyof R & string, Change>> {
    return Object.fromEntries(this.changedAttributeNames().map((k) => [k, [this.#inDatabase[k], this.#attributes[k]]])) as Partial<
      Record<keyof R & string, Change>
    >;
  }

  hasChangesToSave(): boolean {
    return this.changedAttributeNames().length > 0;
  }

  savedChangeTo(name: keyof R & string, opts: { from?: unknown; to?: unknown } = {}): boolean {
    const change = this.savedChanges[name];
    if (!change) return false;
    if ("from" in opts && !sameValue(change[0], opts.from)) return false;
    if ("to" in opts && !sameValue(change[1], opts.to)) return false;
    return true;
  }

  attributeBeforeLastSave<K extends keyof R & string>(name: K): R[K] {
    const change = this.savedChanges[name];
    return (change ? change[0] : this.#attributes[name]) as R[K];
  }

  // ActiveModel::Dirty#changes_applied.
  changesApplied(): void {
    this.savedChanges = this.changes();
    this.#inDatabase = { ...this.#attributes };
    this.#order = [...this.#order, ...Object.keys(this.#attributes).filter((k) => !this.#order.includes(k))];
    this.#lazy = false;
  }

  // Replaces attributes with what the database returned (e.g. the autoincrement id).
  syncFromDatabase(row: Partial<R>): void {
    for (const [k, v] of Object.entries(row)) {
      if (k in this.#attributes) this.#attributes[k as keyof R] = v as R[keyof R];
    }
  }
}
