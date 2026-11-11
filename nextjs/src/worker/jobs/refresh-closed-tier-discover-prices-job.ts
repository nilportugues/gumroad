// Port of app/sidekiq/refresh_closed_tier_discover_prices_job.rb: Link.refresh_discover_prices_for_closed_tiers, which touches every
// tiered membership with a closed tier (updated_at and a PaperTrail version) and re-indexes its available_price_cents.
// Golden: __fixtures__/refresh-closed-tier-discover-prices-job.golden.json (scripts/golden/refresh-closed-tier-discover-prices-job.rb).
import { Prisma, type Link } from "@prisma/client";

import { BaseVariantFlags } from "../../server/models/base-variant.ts";
import { enqueueLinkIndexUpdate, LinkFlags, Links } from "../../server/models/link.ts";
import { castRow, column, findInBatches, table } from "../../server/models/sql.ts";

import { modelJob } from "./support/job-deps.ts";

const LINKS = "links";
const VARIANT_CATEGORIES = "variant_categories";
const BASE_VARIANTS = "base_variants";
const FIND_EACH_BATCH_SIZE = 1000;
const TIER_CATEGORY_TITLE = "Tier";

// `is_tiered_membership.joins(:tiers).merge(Variant.alive.closed_to_new_purchases).distinct`
const JOINS = Prisma.sql`INNER JOIN ${table(VARIANT_CATEGORIES)} ON ${column(VARIANT_CATEGORIES, "deleted_at")} IS NULL AND ${column(VARIANT_CATEGORIES, "title")} = ${TIER_CATEGORY_TITLE} AND ${column(VARIANT_CATEGORIES, "link_id")} = ${column(LINKS, "id")} INNER JOIN ${table(BASE_VARIANTS)} ON ${column(BASE_VARIANTS, "deleted_at")} IS NULL AND ${column(BASE_VARIANTS, "variant_category_id")} = ${column(VARIANT_CATEGORIES, "id")} AND ${column(BASE_VARIANTS, "type")} = 'Variant'`;
const WHERE = Prisma.sql`(${LinkFlags.condition("is_tiered_membership")}) AND ${column(BASE_VARIANTS, "type")} = 'Variant' AND ${column(BASE_VARIANTS, "deleted_at")} IS NULL AND (${BaseVariantFlags.condition("closed_to_new_purchases")})`;

export const refreshClosedTierDiscoverPricesJobWith = modelJob({ min: 0 }, async (_args, deps) => {
  await findInBatches<Record<string, unknown>>(
    LINKS,
    WHERE,
    FIND_EACH_BATCH_SIZE,
    async (rows) => {
      for (const row of rows) {
        const product = Links.load(castRow<Link>("Link", row));
        await Links.touch(product, { now: deps.now });
        await enqueueLinkIndexUpdate(product.get("id") as bigint, ["available_price_cents"], deps.now);
      }
    },
    Prisma.raw("DISTINCT `links`.*"),
    JOINS,
  );
});

export const refreshClosedTierDiscoverPricesJob = refreshClosedTierDiscoverPricesJobWith();
