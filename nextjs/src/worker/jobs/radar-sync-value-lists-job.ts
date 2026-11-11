// Port of app/sidekiq/radar/sync_value_lists_job.rb with Radar::ValueListSyncService#sync_blocked_emails and #sync_blocked_cards: the daily
// reconciliation of platform blocks changed in the last 25 hours (added, unblocked or expired) into the Stripe Radar value lists.
// Golden: __fixtures__/radar-sync-value-lists-job.golden.json (scripts/golden/radar-sync-value-lists-job.rb), Stripe answered by a
// capture server.
import { Prisma, type PlatformBlock } from "@prisma/client";

import { PLATFORM_BLOCK_TYPES, activeScope, typeScope } from "../../server/models/platform-block.ts";
import { findById } from "../../server/models/row-reads.ts";
import { uncached } from "../../server/models/runtime/query-cache.ts";
import { column, selectRows, table } from "../../server/models/sql.ts";

import {
  LIST_FOR_TYPE,
  PLATFORM_BLOCKS,
  addItemToList,
  findOrCreateList,
  removeItemFromList,
  syncEnabled,
} from "./radar-value-list-jobs.ts";
import { modelJob } from "./support/job-deps.ts";

// `STRIPE_FINGERPRINT_PATTERN.source`.
const STRIPE_FINGERPRINT_PATTERN_SOURCE = String.raw`\A[A-Za-z0-9]+\z`;
const SYNC_WINDOW_MS = 25 * 60 * 60 * 1000;

const rows = (conditions: Prisma.Sql[]) =>
  selectRows<PlatformBlock>(
    Prisma.sql`SELECT ${Prisma.raw("`platform_blocks`.*")} FROM ${table(PLATFORM_BLOCKS)} WHERE ${Prisma.join(conditions, " AND ")}`,
  );

// `unblocked_since_select?`: a row cleared or deleted after the SELECT is not re-added.
async function unblockedSinceSelect(block: PlatformBlock): Promise<boolean> {
  const reloaded = await uncached(() => findById<PlatformBlock>("PlatformBlock", block.id));
  return reloaded === null || reloaded.blocked_at === null;
}

async function syncType(objectType: string, now: Date): Promise<void> {
  const valueList = await findOrCreateList(LIST_FOR_TYPE[objectType]!);
  const windowStart = new Date(now.getTime() - SYNC_WINDOW_MS);
  // Only the fingerprint sync filters on the value; an email is any string.
  const onlyFingerprints =
    objectType === PLATFORM_BLOCK_TYPES.charge_processor_fingerprint
      ? [Prisma.sql`(object_value REGEXP ${STRIPE_FINGERPRINT_PATTERN_SOURCE})`]
      : [];

  const added = await rows([
    typeScope(objectType),
    activeScope(now),
    Prisma.sql`(blocked_at >= ${windowStart})`,
    ...onlyFingerprints,
  ]);
  for (const block of added) {
    if (await unblockedSinceSelect(block)) continue;
    await addItemToList(valueList.id, block.object_value);
  }

  const unblocked = await rows([
    typeScope(objectType),
    Prisma.sql`${column(PLATFORM_BLOCKS, "blocked_at")} IS NULL`,
    Prisma.sql`(updated_at >= ${windowStart})`,
    ...onlyFingerprints,
  ]);
  for (const block of unblocked) await removeItemFromList(valueList.id, block.object_value);

  const expired = await rows([
    typeScope(objectType),
    Prisma.sql`${column(PLATFORM_BLOCKS, "blocked_at")} IS NOT NULL`,
    Prisma.sql`${column(PLATFORM_BLOCKS, "expires_at")} BETWEEN ${windowStart} AND ${now}`,
    ...onlyFingerprints,
  ]);
  for (const block of expired) await removeItemFromList(valueList.id, block.object_value);
}

export const radarSyncValueListsJobWith = modelJob({ min: 0 }, async (_args, deps) => {
  if (!syncEnabled()) return;
  await syncType(PLATFORM_BLOCK_TYPES.email, deps.now());
  await syncType(PLATFORM_BLOCK_TYPES.charge_processor_fingerprint, deps.now());
});

export const radarSyncValueListsJob = radarSyncValueListsJobWith();
