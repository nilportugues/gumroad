// WaitlistEntry (app/models/waitlist_entry.rb): one row per (follower, product), written by Follower::CreateService#record_waitlist_entry.
import { Prisma, type WaitlistEntry } from "@prisma/client";

import { belongsToRequired, validatesUniqueness, type BelongsTo } from "./concerns/rails-validations.ts";
import { defineModel } from "./runtime/define-model.ts";
import type { ModelRecord } from "./runtime/record.ts";
import { castRow, column, selectRows, table } from "./sql.ts";

export type WaitlistEntryRecord = ModelRecord<WaitlistEntry>;

const WAITLIST_ENTRIES = "waitlist_entries";
const PRODUCT: BelongsTo = { name: "product", foreignKey: "product_id", targetTable: "links", targetModel: "Link" };
const FOLLOWER: BelongsTo = {
  name: "follower",
  foreignKey: "follower_id",
  targetTable: "followers",
  targetModel: "Follower",
};

export const WaitlistEntries = defineModel<WaitlistEntry>({
  rubyClass: "WaitlistEntry",
  prismaModel: "WaitlistEntry",
  delegate: (tx) => tx.waitlistEntry as never,
  validations: [
    belongsToRequired<WaitlistEntry>(PRODUCT),
    belongsToRequired<WaitlistEntry>(FOLLOWER),
    validatesUniqueness<WaitlistEntry>("WaitlistEntry", WAITLIST_ENTRIES, "product_id", { scope: ["follower_id"] }),
  ],
});

export async function findWaitlistEntry(followerId: number, productId: number): Promise<WaitlistEntryRecord | null> {
  const [row] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`waitlist_entries`.*")} FROM ${table(WAITLIST_ENTRIES)} WHERE ${column(WAITLIST_ENTRIES, "follower_id")} = ${followerId} AND ${column(WAITLIST_ENTRIES, "product_id")} = ${productId} LIMIT 1`,
  );
  return row ? WaitlistEntries.load(castRow("WaitlistEntry", row)) : null;
}
