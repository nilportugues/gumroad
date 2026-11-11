// Ports of app/sidekiq/radar/add_value_list_item_job.rb and remove_value_list_item_job.rb with the two Radar::ValueListSyncService methods
// they call (add_block and remove_block): a platform block of an email or a card fingerprint is mirrored into the Stripe Radar value list
// that enforces it, and whichever of an add and a removal ran last re-asserts the other's outcome when the row changed while the Stripe
// call was in flight. A block id Rails would cast from anything but an Integer or its digits is handed back before any statement.
// Golden: __fixtures__/radar-value-list-jobs.golden.json (scripts/golden/radar-value-list-jobs.rb), Stripe answered by a capture server.
import { Prisma, type PlatformBlock } from "@prisma/client";

import { getConfig } from "../../server/infra/config.ts";
import { railsEnv } from "../../server/infra/rails-env.ts";
import { HandBackToRuby } from "../../server/jobs/hand-back.ts";
import { PLATFORM_BLOCK_TYPES } from "../../server/models/platform-block.ts";
import { findByIdBang, findById, recordIdFrom } from "../../server/models/row-reads.ts";
import { uncached } from "../../server/models/runtime/query-cache.ts";
import { column, selectRows, table } from "../../server/models/sql.ts";
import { InvalidRequestError } from "../../server/stripe/errors.ts";
import { RadarValueList, RadarValueListItem } from "../../server/stripe/resources.ts";

import { modelJob } from "./support/job-deps.ts";

const BLOCKED_EMAILS_LIST = "gumroad_blocked_emails";
const BLOCKED_CARDS_LIST = "gumroad_blocked_cards";
export const STRIPE_FINGERPRINT_PATTERN = /^[A-Za-z0-9]+$/u;
export const PLATFORM_BLOCKS = "platform_blocks";

export type ListConfig = { listAlias: string; name: string; itemType: string };
export const LIST_FOR_TYPE: Record<string, ListConfig> = {
  [PLATFORM_BLOCK_TYPES.email]: { listAlias: BLOCKED_EMAILS_LIST, name: "Gumroad Blocked Emails", itemType: "email" },
  [PLATFORM_BLOCK_TYPES.charge_processor_fingerprint]: {
    listAlias: BLOCKED_CARDS_LIST,
    name: "Gumroad Blocked Cards",
    itemType: "card_fingerprint",
  },
};

// Every non-production environment shares one Stripe test account, so the sync runs there only when asked for.
export const syncEnabled = () => railsEnv() === "production" || getConfig("ENABLE_RADAR_VALUE_LIST_SYNC") !== undefined;

const includesAlreadyExists = (error: InvalidRequestError) => error.message.includes("already exists");

export async function findOrCreateList({ listAlias, name, itemType }: ListConfig): Promise<{ id: string }> {
  const [existing] = (await RadarValueList.list({ alias: listAlias, limit: 1 })).data;
  if (existing) return existing;

  try {
    return await RadarValueList.create({ alias: listAlias, name, item_type: itemType });
  } catch (error) {
    if (!(error instanceof InvalidRequestError) || !includesAlreadyExists(error)) throw error;
    const [raced] = (await RadarValueList.list({ alias: listAlias, limit: 1 })).data;
    if (!raced) throw new Error(`Radar value list '${listAlias}' could not be found after race recovery`);
    return raced;
  }
}

export async function addItemToList(valueListId: string, value: string): Promise<void> {
  try {
    await RadarValueListItem.create({ value_list: valueListId, value });
  } catch (error) {
    if (!(error instanceof InvalidRequestError)) throw error;
    if (error.code !== "value_list_item_already_exists" && !includesAlreadyExists(error)) throw error;
  }
}

export async function removeItemFromList(valueListId: string, value: string): Promise<void> {
  try {
    const items = await RadarValueListItem.list({ value_list: valueListId, value });
    for (const item of items.data) await RadarValueListItem.delete(item.id);
  } catch (error) {
    if (!(error instanceof InvalidRequestError) || error.code !== "resource_missing") throw error;
  }
}

// `PlatformBlock.active.exists?(object_type:, object_value:)`
async function isReblocked(objectType: string, objectValue: string, now: Date): Promise<boolean> {
  const rows = await selectRows(
    Prisma.sql`SELECT 1 AS one FROM ${table(PLATFORM_BLOCKS)} WHERE ${column(PLATFORM_BLOCKS, "blocked_at")} IS NOT NULL AND (expires_at IS NULL OR expires_at > ${now}) AND ${column(PLATFORM_BLOCKS, "object_type")} = ${objectType} AND ${column(PLATFORM_BLOCKS, "object_value")} = ${objectValue} LIMIT 1`,
  );
  return rows.length > 0;
}

const fingerprintRejected = (block: PlatformBlock) =>
  block.object_type === PLATFORM_BLOCK_TYPES.charge_processor_fingerprint &&
  !STRIPE_FINGERPRINT_PATTERN.test(block.object_value);

// `platform_block.reload`, which skips the query cache.
const reload = (block: PlatformBlock) => uncached(() => findByIdBang<PlatformBlock>("PlatformBlock", block.id));

async function addBlock(block: PlatformBlock, now: Date): Promise<boolean> {
  if (!syncEnabled()) return false;
  const listConfig = LIST_FOR_TYPE[block.object_type];
  if (listConfig === undefined) return false;
  if ((await reload(block)).blocked_at === null) return false;
  if (fingerprintRejected(block)) return false;

  const valueListId = (await findOrCreateList(listConfig)).id;
  await addItemToList(valueListId, block.object_value);

  // Cleared while the add was in flight: leaving the item behind keeps rejecting a buyer whose block is gone.
  if (!(await isReblocked(block.object_type, block.object_value, now))) {
    await removeItemFromList(valueListId, block.object_value);
    return false;
  }
  return true;
}

async function removeBlock(block: PlatformBlock, now: Date): Promise<boolean> {
  if (!syncEnabled()) return false;
  const listConfig = LIST_FOR_TYPE[block.object_type];
  if (listConfig === undefined) return false;
  if ((await reload(block)).blocked_at !== null) return false;
  if (fingerprintRejected(block)) return false;

  const valueListId = (await findOrCreateList(listConfig)).id;
  await removeItemFromList(valueListId, block.object_value);

  // A block re-added between the check above and the delete would otherwise lose Radar enforcement until tomorrow's sync.
  if (await isReblocked(block.object_type, block.object_value, now)) {
    await addItemToList(valueListId, block.object_value);
    return false;
  }
  return true;
}

function radarJob(sync: (block: PlatformBlock, now: Date) => Promise<boolean>) {
  return modelJob({ min: 1 }, async ([platformBlockId], deps) => {
    const castable =
      (typeof platformBlockId === "number" && Number.isSafeInteger(platformBlockId)) ||
      (typeof platformBlockId === "string" && /^[0-9]{1,15}$/u.test(platformBlockId));
    if (!castable) throw new HandBackToRuby("the platform block id is not an Integer");

    const block = await findById<PlatformBlock>(
      "PlatformBlock",
      recordIdFrom(platformBlockId, "PlatformBlock.find_by"),
    );
    if (block === null) return;
    await sync(block, deps.now());
  });
}

export const radarAddValueListItemJobWith = radarJob(addBlock);
export const radarRemoveValueListItemJobWith = radarJob(removeBlock);
export const radarAddValueListItemJob = radarAddValueListItemJobWith();
export const radarRemoveValueListItemJob = radarRemoveValueListItemJobWith();
