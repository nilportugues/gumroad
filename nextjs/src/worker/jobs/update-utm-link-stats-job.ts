// Port of app/sidekiq/update_utm_link_stats_job.rb. Golden: __fixtures__/update-utm-link-stats-job.golden.json
// (scripts/golden/update-utm-link-stats-job.rb).
import { Prisma, type UtmLink } from "@prisma/client";

import { beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { findByIdBang, recordIdFrom } from "../../server/models/row-reads.ts";
import { column, selectRows, table } from "../../server/models/sql.ts";
import { UtmLinks } from "../../server/models/utm-link.ts";

import { modelJob } from "./support/job-deps.ts";

const UTM_LINK_VISITS = "utm_link_visits";

// The result column is named after the SQL, so read the row's only value.
async function count(aggregate: Prisma.Sql, utmLinkId: bigint): Promise<number> {
  const [row] = await selectRows<Record<string, unknown>>(
    Prisma.sql`SELECT ${aggregate} FROM ${table(UTM_LINK_VISITS)} WHERE ${column(UTM_LINK_VISITS, "utm_link_id")} = ${utmLinkId}`,
  );
  return Number(Object.values(row!)[0]);
}

export const updateUtmLinkStatsJobWith = modelJob({ min: 1 }, async ([utmLinkId], deps) => {
  const id = await beforeSideEffects(() => recordIdFrom(utmLinkId, "UtmLink.find"));
  const link = UtmLinks.load(await findByIdBang<UtmLink>("UtmLink", id));

  // Both counts are read before update! opens its transaction, in this order.
  const total_clicks = await count(Prisma.sql`COUNT(*)`, id);
  const unique_clicks = await count(Prisma.sql`COUNT(DISTINCT ${column(UTM_LINK_VISITS, "browser_guid")})`, id);
  link.assign({ total_clicks, unique_clicks });
  // Rails materializes these two right after the assigned counters; PaperTrail's `object` lists attributes in that order.
  link.touch("target_resource_type");
  link.touch("id");
  await UtmLinks.saveBang(link, { now: deps.now });
});

export const updateUtmLinkStatsJob = updateUtmLinkStatsJobWith();
