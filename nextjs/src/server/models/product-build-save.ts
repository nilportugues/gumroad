// Port of app/models/product_build_save.rb: a buyer's saved progress in a web build, one string map per purchase, changed in batches
// under a row lock.
import { Prisma, type ProductBuildSave } from "@prisma/client";

import { validatesAssociationPresence, type BelongsTo } from "./concerns/rails-validations.ts";
import { defineModel } from "./runtime/define-model.ts";
import { castRow, column, isRecordNotUnique, selectRows, table } from "./sql.ts";

const TABLE = "product_build_saves";
const PURCHASE: BelongsTo = {
  name: "purchase",
  foreignKey: "purchase_id",
  targetTable: "purchases",
  targetModel: "Purchase",
};

export const MAX_KEY_BYTES = 1024;
export const MAX_KEYS = 1_000;
export const MAX_BYTE_SIZE = 5 * 1024 * 1024;
const MAX_WRITER_ID_LENGTH = 32;
const MAX_SEQUENCE = Number.MAX_SAFE_INTEGER;
const MAX_TRACKED_CLEARS = 20;
const WRITER_ID_FORMAT = new RegExp(`^[A-Za-z0-9]{1,${MAX_WRITER_ID_LENGTH}}$`, "u");

export class LimitError extends Error {}

export const ProductBuildSaves = defineModel<ProductBuildSave>({
  rubyClass: "ProductBuildSave",
  prismaModel: "ProductBuildSave",
  delegate: (tx) => tx.productBuildSave as never,
  validations: [validatesAssociationPresence<ProductBuildSave>(PURCHASE)],
});

type Versions = { keys: Map<string, [string, number]>; clears: [string, number][] };
export type Batch = { set: unknown; remove: unknown; clear: unknown; writer: unknown; sequence: unknown };

const parsed = (value: unknown) => (typeof value === "string" ? (JSON.parse(value) as unknown) : value);

function validateChanges(set: unknown, remove: unknown, clear: unknown): [Map<string, string>, string[]] {
  const isHash = typeof set === "object" && set !== null && !Array.isArray(set);
  if (!isHash || !Array.isArray(remove) || typeof clear !== "boolean")
    throw new LimitError("A batch needs `set` as an object, `remove` as a list, and `clear` as true or false.");
  const entries = Object.entries(set as Record<string, unknown>);
  const keys = [...entries.map(([key]) => key), ...(remove as unknown[])];
  if (!keys.every((key) => typeof key === "string") || !entries.every(([, value]) => typeof value === "string"))
    throw new LimitError("Keys and values must be strings.");
  // MySQL rejects a JSON document that is not valid UTF-8, which a lone surrogate from JavaScript becomes.
  if (
    ![...(keys as string[]), ...entries.map(([, value]) => value as string)].every(
      (text) => !/\p{Surrogate}/u.test(text),
    )
  )
    throw new LimitError("Keys and values must be valid UTF-8.");
  if ((keys as string[]).some((key) => Buffer.byteLength(key) > MAX_KEY_BYTES))
    throw new LimitError(`A key can be at most ${MAX_KEY_BYTES} bytes.`);
  return [new Map(entries as [string, string][]), remove as string[]];
}

function validateWriter(writer: unknown, sequence: unknown): void {
  if (writer == null && sequence == null) return;
  if (
    typeof writer === "string" &&
    WRITER_ID_FORMAT.test(writer) &&
    typeof sequence === "number" &&
    Number.isInteger(sequence) &&
    sequence >= 1 &&
    sequence <= MAX_SEQUENCE
  )
    return;
  throw new LimitError(
    `A batch needs \`writer\` as up to ${MAX_WRITER_ID_LENGTH} letters and digits, and \`sequence\` as a positive whole number.`,
  );
}

// Hash#== ignores order; MySQL hands JSON keys back in its own order.
function sameJson(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => sameJson(item, b[index]))
    );
  if (typeof a === "object" && a !== null && typeof b === "object" && b !== null) {
    const left = Object.entries(a);
    const right = new Map(Object.entries(b));
    return (
      left.length === right.size && left.every(([key, value]) => right.has(key) && sameJson(value, right.get(key)))
    );
  }
  return a === b;
}

// `create_or_find_by!(purchase:)`: an INSERT, and the existing row when another request won the unique index.
async function createOrFindBy(purchaseId: bigint, now: () => Date) {
  try {
    return await ProductBuildSaves.createBang(
      { purchase_id: purchaseId, data: {}, byte_size: 0, key_versions: { keys: {}, clears: [] } } as never,
      { now },
    );
  } catch (error) {
    if (!isRecordNotUnique(error)) throw error;
    const [row] = await selectRows(
      Prisma.sql`SELECT ${Prisma.raw("`product_build_saves`.*")} FROM ${table(TABLE)} WHERE ${column(TABLE, "purchase_id")} = ${purchaseId} LIMIT 1`,
    );
    return ProductBuildSaves.load(castRow<ProductBuildSave>("ProductBuildSave", row!));
  }
}

// ProductBuildSave.apply_changes!: clears first, then removes, then sets, so one batch can replace the whole save. A change is skipped
// when a later batch from the same writer already changed that key, or cleared the save.
export async function applyChanges(
  purchaseId: bigint,
  batch: Batch,
  now: () => Date = () => new Date(),
): Promise<void> {
  const [set, remove] = validateChanges(batch.set, batch.remove, batch.clear);
  const clear = batch.clear as boolean;
  validateWriter(batch.writer, batch.sequence);
  const writer = batch.writer == null ? null : (batch.writer as string);
  const sequence = batch.sequence == null ? 0 : (batch.sequence as number);

  const save = await createOrFindBy(purchaseId, now);
  await ProductBuildSaves.withLock(save, async () => {
    const before = (parsed(save.get("data")) ?? {}) as Record<string, string>;
    const beforeVersions = (parsed(save.get("key_versions")) ?? { keys: {}, clears: [] }) as {
      keys?: Record<string, [string, number]>;
      clears?: [string, number][];
    };
    const data = new Map<string, string>(Object.entries(before));
    const versions: Versions = {
      keys: new Map(Object.entries(beforeVersions.keys ?? {})),
      clears: [...(beforeVersions.clears ?? [])],
    };
    const clearedAfter = writer !== null && (versions.clears.find(([name]) => name === writer)?.[1] ?? 0) > sequence;
    const stale = (key: string) => {
      if (writer === null) return false;
      if (clearedAfter) return true;
      const last = versions.keys.get(key);
      return last !== undefined && last[0] === writer && last[1] > sequence;
    };
    const change = (key: string) => {
      if (writer !== null) versions.keys.set(key, [writer, sequence]);
    };

    if (clear && !clearedAfter) {
      for (const key of [...data.keys()]) {
        if (stale(key)) continue;
        data.delete(key);
        change(key);
      }
      if (writer !== null) {
        versions.clears = versions.clears.filter(([name]) => name !== writer);
        versions.clears.push([writer, sequence]);
        while (versions.clears.length > MAX_TRACKED_CLEARS) versions.clears.shift();
      }
    }
    for (const key of remove) {
      if (stale(key)) continue;
      data.delete(key);
      change(key);
    }
    for (const [key, value] of set) {
      if (stale(key)) continue;
      data.set(key, value);
      change(key);
    }

    let byteSize = 0;
    for (const [key, value] of data) byteSize += Buffer.byteLength(key) + Buffer.byteLength(value);
    if (data.size > MAX_KEYS) throw new LimitError(`A save can hold at most ${MAX_KEYS} keys.`);
    if (byteSize > MAX_BYTE_SIZE) throw new LimitError(`A save can hold at most ${MAX_BYTE_SIZE / (1024 * 1024)} MB.`);

    // Removed keys' entries are kept to stop a late batch bringing them back, up to a bound.
    if (versions.keys.size > MAX_KEYS * 2) {
      const removed = [...versions.keys.keys()].filter((key) => !data.has(key));
      for (const key of removed.slice(0, versions.keys.size - MAX_KEYS * 2)) versions.keys.delete(key);
    }

    // `update!` writes only the attributes that changed, and nothing at all when none did.
    const after = {
      data: Object.fromEntries(data),
      byte_size: byteSize,
      key_versions: { keys: Object.fromEntries(versions.keys), clears: versions.clears },
    };
    const changed: Record<string, unknown> = {};
    if (!sameJson(before, after.data)) changed.data = after.data;
    if (save.get("byte_size") !== byteSize) changed.byte_size = byteSize;
    if (!sameJson(beforeVersions, after.key_versions)) changed.key_versions = after.key_versions;
    await ProductBuildSaves.updateBang(save, changed as never, { now });
  });
}
