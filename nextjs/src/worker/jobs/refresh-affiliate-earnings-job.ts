// Port of app/sidekiq/refresh_affiliate_earnings_job.rb: `Affiliate.find_by(id:)` then AffiliateEarningsCache.refresh_unless_fresh!
// (server/services/affiliate-earnings-cache.ts), and the sidekiq_retries_exhausted hook that hands the computation back to requests.
// Golden: __fixtures__/refresh-affiliate-earnings-job.golden.json (scripts/golden/refresh-affiliate-earnings-job.rb).
import { Prisma } from "@prisma/client";

import { beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { recordIdFrom } from "../../server/models/row-reads.ts";
import { selectRows } from "../../server/models/sql.ts";
import {
  type AffiliateEarningsDeps,
  assertAffiliateType,
  defaultAffiliateEarningsDeps,
  refreshUnlessFresh,
  releaseComputation,
} from "../../server/services/affiliate-earnings-cache.ts";
import type { RetriesExhausted } from "../retry.ts";

import { modelJob } from "./support/job-deps.ts";

// Affiliate ignores `archived_at`, so ActiveRecord lists the columns instead of `affiliates.*`.
const AFFILIATE_COLUMNS = [
  "id",
  "seller_id",
  "affiliate_user_id",
  "affiliate_basis_points",
  "created_at",
  "updated_at",
  "deleted_at",
  "flags",
  "destination_url",
  "type",
]
  .map((name) => `\`affiliates\`.\`${name}\``)
  .join(", ");

// `Affiliate.find_by(id: id)`: nil asks for `id IS NULL`, which matches nothing.
async function findAffiliate(idArg: unknown): Promise<{ id: bigint } | null> {
  const id = idArg === null ? null : recordIdFrom(idArg, "Affiliate.find_by");
  const condition = id === null ? Prisma.raw("`affiliates`.`id` IS NULL") : Prisma.sql`\`affiliates\`.\`id\` = ${id}`;
  const [row] = await selectRows<{ type: unknown }>(
    Prisma.sql`SELECT ${Prisma.raw(AFFILIATE_COLUMNS)} FROM \`affiliates\` WHERE ${condition} LIMIT 1`,
  );
  if (!row || id === null) return null;
  assertAffiliateType(row.type);
  return { id };
}

export const refreshAffiliateEarningsJobWith = (overrides: Partial<AffiliateEarningsDeps> = {}) =>
  modelJob({ min: 1 }, async ([affiliateIdArg]) => {
    const deps = { ...defaultAffiliateEarningsDeps, ...overrides };
    const found = await beforeSideEffects(() => findAffiliate(affiliateIdArg));
    if (!found) return;
    await refreshUnlessFresh(deps, found.id);
  })();

// The claim a timed-out request handed to this job goes back once Sidekiq stops retrying: with no pending retry nobody is
// computing the sum. Hooks cannot hand a run back, so an id Ruby casts (a float, a word) fails here and is logged by the worker.
export const refreshAffiliateEarningsJobRetriesExhaustedWith =
  (overrides: Partial<AffiliateEarningsDeps> = {}): RetriesExhausted =>
  async (msg) => {
    const deps = { ...defaultAffiliateEarningsDeps, ...overrides };
    const found = await findAffiliate((msg.args as unknown[])[0] ?? null);
    if (found) await releaseComputation(deps, found.id);
  };

export const refreshAffiliateEarningsJob = refreshAffiliateEarningsJobWith();
export const refreshAffiliateEarningsJobRetriesExhausted = refreshAffiliateEarningsJobRetriesExhaustedWith();
