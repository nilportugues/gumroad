// Port of app/sidekiq/recalculate_recent_wishlist_follower_count_job.rb.
import type { Wishlist } from "@prisma/client";

import { ago } from "../../server/models/concerns/ruby-time.ts";
import { castRow, findInBatches, selectRows } from "../../server/models/sql.ts";
import { recentFollowerCountsSql, WISHLISTS, Wishlists } from "../../server/models/wishlist.ts";
import { modelJob } from "./support/job-deps.ts";

const RECENT = { days: 30 };

export const recalculateRecentWishlistFollowerCountJobWith = modelJob({ min: 0 }, async (_args, deps) => {
  await findInBatches(WISHLISTS, null, 1_000, async (rows) => {
    const batch = rows.map((row) => Wishlists.load(castRow<Wishlist>("Wishlist", row)));
    const counts = new Map<string, number>();
    const countRows = await selectRows<{ count_all: unknown; wishlist_followers_wishlist_id: unknown }>(
      recentFollowerCountsSql(
        batch.map((w) => w.get("id")),
        ago(RECENT, deps.now()),
      ),
    );
    for (const row of countRows) counts.set(String(row.wishlist_followers_wishlist_id), Number(row.count_all));

    for (const wishlist of batch) {
      await Wishlists.updateBang(wishlist, { recent_follower_count: counts.get(String(wishlist.get("id"))) ?? 0 }, { now: deps.now });
    }
  });
});

export const recalculateRecentWishlistFollowerCountJob = recalculateRecentWishlistFollowerCountJobWith();
