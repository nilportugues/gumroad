// Port of app/sidekiq/backfill_orphaned_shown_products_in_profile_sections_job.rb and
// Onetime::BackfillOrphanedShownProductsInProfileSections.process with its defaults: every products section is checked for shown
// product ids that are soft-deleted, and rewritten under the seller's profile lock. A section that cannot be saved is skipped, as
// Rails rescues it. A shown_products entry that is not a plain integer hands the job back (Rails casts the ids it queries with, and
// compares the rest as Ruby values); it is idempotent, so Rails re-running it after sections were rewritten is safe.
// Golden: __fixtures__/backfill-orphaned-shown-products-in-profile-sections-job.golden.json
// (scripts/golden/backfill-orphaned-shown-products-in-profile-sections-job.rb).
import { Prisma, type SellerProfileSection } from "@prisma/client";

import { HandBackToRuby } from "../../server/jobs/hand-back.ts";
import { findOneBy } from "../../server/models/row-reads.ts";
import type { Row } from "../../server/models/runtime/record.ts";
import {
  hashOf,
  ProductsSections,
  reloadProductsSection,
  withProfileSectionsLock,
} from "../../server/models/seller-profile-products-sections.ts";
import { castRow, column, columnIn, findInBatches, selectRows, table } from "../../server/models/sql.ts";

import { modelJob } from "./support/job-deps.ts";

const SECTIONS = "seller_profile_sections";
const LINKS = "links";
const PRODUCTS_SECTION = "SellerProfileProductsSection";
const BATCH_SIZE = 500;
// A float or exponent in the stored json_data: Ruby would read it as a Float, which never equals a link id.
const NON_INTEGER_NUMBER = /\d\.\d|\d[eE][+-]?\d/u;

// `json_data` is nullable and legacy rows can hold other shapes, so read it defensively.
function shownProductIds(jsonData: unknown): number[] {
  if (typeof jsonData === "string" && NON_INTEGER_NUMBER.test(jsonData)) {
    throw new HandBackToRuby("a products section whose json_data holds a non-integer number");
  }
  const shown = hashOf(jsonData).shown_products;
  if (!Array.isArray(shown)) return [];
  if (!shown.every((id) => Number.isSafeInteger(id))) {
    throw new HandBackToRuby("a shown_products entry that is not an Integer");
  }
  return shown as number[];
}

async function aliveIdsAmong(productIds: number[]): Promise<Set<number>> {
  const rows = await selectRows<{ id: bigint | number }>(
    Prisma.sql`SELECT ${column(LINKS, "id")} FROM ${table(LINKS)} WHERE ${columnIn(LINKS, "id", productIds)} AND ${column(LINKS, "deleted_at")} IS NULL`,
  );
  return new Set(rows.map((row) => Number(row.id)));
}

export const backfillOrphanedShownProductsInProfileSectionsJobWith = modelJob({ min: 0 }, async (_args, deps) => {
  const clean = async (row: Row) => {
    const shown = shownProductIds(row.json_data);
    if (shown.length === 0) return;

    // Cheap pre-check outside the lock: skip sections that have no dead ids.
    const alive = await aliveIdsAmong(shown);
    if (shown.every((id) => alive.has(id))) return;

    // A section whose seller was hard-deleted has nothing to lock against.
    if ((await findOneBy("User", "id", row.seller_id as bigint, true)) === null) return;

    // Re-read and rewrite under the lock, so a concurrent profile edit is not overwritten.
    await withProfileSectionsLock(row.seller_id, async () => {
      const fresh = await reloadProductsSection(row);
      const current = shownProductIds(fresh.json_data);
      if (current.length === 0) return;

      const currentAlive = await aliveIdsAmong(current);
      const cleaned = current.filter((id) => currentAlive.has(id));
      if (cleaned.length === current.length) return;

      const section = ProductsSections.load(castRow<SellerProfileSection>("SellerProfileSection", fresh));
      section.set("json_data", { ...hashOf(section.get("json_data")), shown_products: cleaned });
      await ProductsSections.saveBang(section, { now: deps.now });
    });
  };

  await findInBatches<Row>(
    SECTIONS,
    Prisma.sql`${column(SECTIONS, "type")} = ${PRODUCTS_SECTION}`,
    BATCH_SIZE,
    async (sections) => {
      for (const row of sections) {
        try {
          await clean(row);
        } catch (error) {
          // One bad row (corrupt json_data, a section that no longer validates) must not stall the cleanup.
          if (error instanceof HandBackToRuby) throw error;
          console.warn(
            `[BackfillOrphanedShownProductsInProfileSections] skipped section ${String(row.id)}: ${(error as Error).message}`,
          );
        }
      }
    },
  );
});

export const backfillOrphanedShownProductsInProfileSectionsJob =
  backfillOrphanedShownProductsInProfileSectionsJobWith();
