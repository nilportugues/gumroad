// Port of app/models/platform_block.rb, complete. Radar::ValueListSyncService.syncs? is the one
// line of that service the model needs; the sync itself stays in the Radar jobs.
import { Prisma, type PlatformBlock } from "@prisma/client";

import { afterCommitEverywhere, performAsync } from "./concerns/job-runtime.ts";
import { advance, type Duration } from "./concerns/ruby-time.ts";
import { isBlank, validatesInclusionOf } from "./runtime/validators.ts";
import { defineModel } from "./runtime/define-model.ts";
import type { ModelRecord } from "./runtime/record.ts";
import { transaction } from "./runtime/transaction.ts";
import { castRow, column, isRecordNotUnique, selectRows, table } from "./sql.ts";

export const PLATFORM_BLOCK_TYPES = {
  ip_address: "ip_address",
  browser_guid: "browser_guid",
  email: "email",
  email_domain: "email_domain",
  charge_processor_fingerprint: "charge_processor_fingerprint",
  product: "product",
  product_ip_address: "product_ip_address",
} as const;

export const IP_ADDRESS_BLOCKING_DURATION_IN_MONTHS = 6;

const TABLE = "platform_blocks";

// Radar::ValueListSyncService::LIST_FOR_TYPE's keys: the types Radar, not this row, enforces.
const RADAR_SYNCED_TYPES: readonly string[] = [PLATFORM_BLOCK_TYPES.email, PLATFORM_BLOCK_TYPES.charge_processor_fingerprint];

export const radarSyncs = (objectType: unknown) => RADAR_SYNCED_TYPES.includes(String(objectType));

export const PlatformBlocks = defineModel<PlatformBlock>({
  rubyClass: "PlatformBlock",
  prismaModel: "PlatformBlock",
  delegate: (tx) => tx.platformBlock as never,
  validations: [validatesInclusionOf<PlatformBlock>(["object_type"], { in: Object.values(PLATFORM_BLOCK_TYPES) })],
  afterCommit: [
    {
      // After commit because callers hold open transactions and the job reloads the row first.
      name: "enqueue_radar_add",
      on: ["create", "update"],
      if: (record) => record.savedChangeTo("blocked_at") && record.get("blocked_at") != null,
      run: async (record) => {
        if (radarSyncs(record.get("object_type"))) await performAsync("Radar::AddValueListItemJob", [record.get("id")]);
      },
    },
  ],
});

// `scope <type>` for each TYPES value, and `active`.
export const typeScope = (objectType: string) => Prisma.sql`${column(TABLE, "object_type")} = ${objectType}`;
export const activeScope = (now: Date) =>
  Prisma.sql`${column(TABLE, "blocked_at")} IS NOT NULL AND (expires_at IS NULL OR expires_at > ${now})`;

async function findBy(objectType: string, objectValue: string): Promise<ModelRecord<PlatformBlock> | null> {
  const rows = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`platform_blocks`.*")} FROM ${table(TABLE)} WHERE ${column(TABLE, "object_type")} = ${objectType} AND ${column(TABLE, "object_value")} = ${objectValue} LIMIT 1`,
  );
  return rows[0] ? PlatformBlocks.load(castRow<PlatformBlock>("PlatformBlock", rows[0])) : null;
}

export class RecordNotFound extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecordNotFound";
  }
}

// `create_or_find_by!`: insert in its own transaction; on a unique-key collision, roll back and
// `find_by!` the row that won.
async function createOrFindByBang(objectType: string | null, objectValue: string, now: () => Date): Promise<ModelRecord<PlatformBlock>> {
  try {
    return await transaction(() => PlatformBlocks.createBang({ object_type: objectType as string, object_value: objectValue }, { now }));
  } catch (error) {
    if (!isRecordNotUnique(error)) throw error;
    const found = await findBy(objectType as string, objectValue);
    if (!found) throw new RecordNotFound("Couldn't find PlatformBlock");
    return found;
  }
}

// `PlatformBlock.add!`. `objectType` is nil when a caller passed an unknown type key.
export async function addPlatformBlock(
  {
    objectType,
    objectValue,
    by = null,
    expiresInSeconds = null,
    expiresIn = null,
  }: { objectType: string | null; objectValue: string; by?: unknown; expiresInSeconds?: number | null; expiresIn?: Duration | null },
  now: () => Date = () => new Date(),
): Promise<ModelRecord<PlatformBlock>> {
  if (String(objectType ?? "") === PLATFORM_BLOCK_TYPES.ip_address && isBlank(expiresInSeconds) && !expiresIn) {
    throw new ArgumentError("expires_in is required when blocking an ip_address");
  }
  const at = now();
  const record = await createOrFindByBang(objectType, objectValue, now);
  await PlatformBlocks.updateBang(
    record,
    {
      blocked_at: at,
      blocked_by: by == null ? null : BigInt(by as number),
      // A calendar Duration (`6.months`) advances the date; a bare number of seconds adds them.
      expires_at: expiresIn ? advance(at, expiresIn) : isBlank(expiresInSeconds) ? null : new Date(at.getTime() + Number(expiresInSeconds) * 1000),
    },
    { now },
  );
  return record;
}

// `#unblock!`. The Radar removal is enqueued even when the row was already unblocked: re-running
// it is the only repair for an item stranded in Radar.
export async function unblockPlatformBlock(record: ModelRecord<PlatformBlock>, now: () => Date = () => new Date()): Promise<void> {
  await PlatformBlocks.updateBang(record, { blocked_at: null, expires_at: null }, { now });
  if (!radarSyncs(record.get("object_type"))) return;
  await afterCommitEverywhere(() => performAsync("Radar::RemoveValueListItemJob", [record.get("id")]));
}

export class ArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArgumentError";
  }
}
