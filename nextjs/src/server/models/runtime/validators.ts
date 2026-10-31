// Port of the ActiveModel/ActiveRecord validators the models use (activemodel 8.1):
// presence, absence, length, format, inclusion, exclusion, numericality, uniqueness and the
// "must exist" check of a required belongs_to.
import { Prisma } from "@prisma/client";

import type { Action, Callback, CallbackContext } from "./define-model.ts";
import type { ModelRecord, Row } from "./record.ts";

type Common<R extends Row> = {
  on?: Action | Action[];
  if?: (record: ModelRecord<R>) => boolean;
  unless?: (record: ModelRecord<R>) => boolean;
  allow_nil?: boolean;
  allow_blank?: boolean;
  message?: string;
};

// Ruby [[:space:]]: Unicode White_Space, which (unlike JS \s) has U+0085 and lacks U+FEFF.
const RUBY_BLANK = /^[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*$/u;

// Object#blank? for the values attributes hold.
export function isBlank(value: unknown): boolean {
  if (value == null || value === false) return true;
  if (typeof value === "string") return RUBY_BLANK.test(value);
  if (Array.isArray(value)) return value.length === 0;
  if (value instanceof Date || typeof value !== "object") return false;
  if (Prisma.Decimal.isDecimal(value)) return false;
  return Object.keys(value as object).length === 0;
}

// Ruby String#length counts code points, not UTF-16 units.
export function rubyLength(value: unknown): number {
  if (value == null) return 0;
  if (Array.isArray(value)) return value.length;
  return [...String(value)].length;
}

function validator<R extends Row>(
  name: string,
  attributes: (keyof R & string)[],
  opts: Common<R>,
  check: (record: ModelRecord<R>, attribute: keyof R & string, value: unknown, ctx: CallbackContext) => unknown,
): Callback<R> {
  return {
    name,
    on: opts.on,
    if: opts.if,
    unless: opts.unless,
    async run(record, ctx) {
      for (const attribute of attributes) {
        const value = record.get(attribute);
        if (opts.allow_nil && value == null) continue;
        if (opts.allow_blank && isBlank(value)) continue;
        await check(record, attribute, value, ctx);
      }
    },
  };
}

const withMessage = (opts: { message?: string }, extra: Record<string, unknown> = {}) => (opts.message ? { ...extra, message: opts.message } : extra);

export function validatesPresenceOf<R extends Row>(attributes: (keyof R & string)[], opts: Common<R> = {}): Callback<R> {
  return validator(`validates_presence_of ${attributes.join(", ")}`, attributes, opts, (record, attribute, value) => {
    if (isBlank(value)) record.errors.add(attribute, "blank", withMessage(opts));
  });
}

export function validatesAbsenceOf<R extends Row>(attributes: (keyof R & string)[], opts: Common<R> = {}): Callback<R> {
  return validator(`validates_absence_of ${attributes.join(", ")}`, attributes, opts, (record, attribute, value) => {
    if (!isBlank(value)) record.errors.add(attribute, "present", withMessage(opts));
  });
}

export function validatesLengthOf<R extends Row>(
  attributes: (keyof R & string)[],
  opts: Common<R> & { maximum?: number; minimum?: number; is?: number; too_long?: string; too_short?: string },
): Callback<R> {
  return validator(`validates_length_of ${attributes.join(", ")}`, attributes, opts, (record, attribute, value) => {
    const length = rubyLength(value);
    if (opts.is !== undefined && length !== opts.is) record.errors.add(attribute, "wrong_length", withMessage(opts, { count: opts.is }));
    if (opts.minimum !== undefined && length < opts.minimum)
      record.errors.add(attribute, "too_short", withMessage({ message: opts.too_short ?? opts.message }, { count: opts.minimum }));
    // LengthValidator skips the maximum check for nil.
    if (opts.maximum !== undefined && value != null && length > opts.maximum)
      record.errors.add(attribute, "too_long", withMessage({ message: opts.too_long ?? opts.message }, { count: opts.maximum }));
  });
}

export function validatesFormatOf<R extends Row>(attributes: (keyof R & string)[], opts: Common<R> & { with?: RegExp; without?: RegExp }): Callback<R> {
  return validator(`validates_format_of ${attributes.join(", ")}`, attributes, opts, (record, attribute, value) => {
    const text = value == null ? "" : String(value);
    if ((opts.with && !opts.with.test(text)) || (opts.without && opts.without.test(text))) record.errors.add(attribute, "invalid", withMessage(opts));
  });
}

export function validatesInclusionOf<R extends Row>(attributes: (keyof R & string)[], opts: Common<R> & { in: readonly unknown[] }): Callback<R> {
  return validator(`validates_inclusion_of ${attributes.join(", ")}`, attributes, opts, (record, attribute, value) => {
    if (!opts.in.includes(value)) record.errors.add(attribute, "inclusion", withMessage(opts, { value }));
  });
}

export function validatesExclusionOf<R extends Row>(attributes: (keyof R & string)[], opts: Common<R> & { in: readonly unknown[] }): Callback<R> {
  return validator(`validates_exclusion_of ${attributes.join(", ")}`, attributes, opts, (record, attribute, value) => {
    if (opts.in.includes(value)) record.errors.add(attribute, "exclusion", withMessage(opts, { value }));
  });
}

export function validatesNumericalityOf<R extends Row>(
  attributes: (keyof R & string)[],
  opts: Common<R> & {
    only_integer?: boolean;
    greater_than?: number;
    greater_than_or_equal_to?: number;
    less_than?: number;
    less_than_or_equal_to?: number;
    equal_to?: number;
  },
): Callback<R> {
  return validator(`validates_numericality_of ${attributes.join(", ")}`, attributes, opts, (record, attribute, value) => {
    const n = typeof value === "bigint" ? Number(value) : Prisma.Decimal.isDecimal(value) ? Number(value) : typeof value === "number" ? value : Number.NaN;
    if (value == null || Number.isNaN(n)) return record.errors.add(attribute, "not_a_number", withMessage(opts, { value }));
    if (opts.only_integer && !Number.isInteger(n)) return record.errors.add(attribute, "not_an_integer", withMessage(opts, { value }));
    const checks: [keyof typeof opts, (limit: number) => boolean, Parameters<ModelRecord<R>["errors"]["add"]>[1]][] = [
      ["greater_than", (l) => n > l, "greater_than"],
      ["greater_than_or_equal_to", (l) => n >= l, "greater_than_or_equal_to"],
      ["equal_to", (l) => n === l, "equal_to"],
      ["less_than", (l) => n < l, "less_than"],
      ["less_than_or_equal_to", (l) => n <= l, "less_than_or_equal_to"],
    ];
    for (const [key, ok, type] of checks) {
      const limit = opts[key] as number | undefined;
      if (limit !== undefined && !ok(limit)) record.errors.add(attribute, type, withMessage(opts, { count: limit, value }));
    }
  });
}

// UniquenessValidator. MySQL's *_ci collations make `=` case-insensitive, which is what Rails
// relies on with the default `case_sensitive: nil`.
export function validatesUniquenessOf<R extends Row>(
  table: string,
  attributes: (keyof R & string)[],
  opts: Common<R> & { scope?: (keyof R & string)[]; conditions?: string; case_sensitive?: boolean },
): Callback<R> {
  return validator(`validates_uniqueness_of ${attributes.join(", ")}`, attributes, opts, async (record, attribute, value, { tx }) => {
    const where: Prisma.Sql[] = [
      value == null ? Prisma.sql`${Prisma.raw(`\`${table}\`.\`${attribute}\``)} IS NULL` : opts.case_sensitive
        ? Prisma.sql`${Prisma.raw(`\`${table}\`.\`${attribute}\``)} = BINARY ${value}`
        : Prisma.sql`${Prisma.raw(`\`${table}\`.\`${attribute}\``)} = ${value}`,
    ];
    for (const scope of opts.scope ?? []) {
      const scoped = record.get(scope);
      where.push(scoped == null ? Prisma.sql`${Prisma.raw(`\`${table}\`.\`${scope}\``)} IS NULL` : Prisma.sql`${Prisma.raw(`\`${table}\`.\`${scope}\``)} = ${scoped}`);
    }
    if (record.persisted) where.push(Prisma.sql`${Prisma.raw(`\`${table}\`.\`id\``)} != ${record.get("id")}`);
    if (opts.conditions) where.push(Prisma.raw(opts.conditions));
    const rows = await tx.$queryRaw<unknown[]>(Prisma.sql`SELECT 1 AS one FROM ${Prisma.raw(`\`${table}\``)} WHERE ${Prisma.join(where, " AND ")} LIMIT 1`);
    if (rows.length > 0) record.errors.add(attribute, "taken", withMessage(opts, { value }));
  });
}

// belongs_to without `optional: true` (belongs_to_required_by_default). With
// belongs_to_required_validates_foreign_key = true the lookup is skipped when the key is unchanged.
export function validatesAssociatedPresence<R extends Row>(
  association: string,
  foreignKey: keyof R & string,
  exists: (id: unknown, ctx: CallbackContext) => Promise<boolean>,
): Callback<R> {
  return {
    name: `belongs_to :${association} (required)`,
    async run(record, ctx) {
      const id = record.get(foreignKey);
      if (id == null) return record.errors.add(association, "required");
      if (!record.newRecord && !record.attributeChanged(foreignKey)) return;
      if (!(await exists(id, ctx))) record.errors.add(association, "required");
    },
  };
}
