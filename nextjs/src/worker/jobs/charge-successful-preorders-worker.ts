// Port of app/sidekiq/charge_successful_preorders_worker.rb: every authorized preorder of a preorder link is queued for its charge,
// and the seller's summary follows 20 minutes later when there was any. The summary job gets the argument as it was given, so a
// digit string stays a string. A link that does not exist fails with Ruby's NoMethodError, and an id Rails casts (a Float, a word)
// is handed back before any statement.
// Golden: __fixtures__/charge-successful-preorders-worker.golden.json (scripts/golden/charge-successful-preorders-worker.rb).
import { Prisma, type Preorder } from "@prisma/client";

import { enqueueWith } from "../../server/jobs/enqueue.ts";
import { beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { findOneBy, recordIdFrom } from "../../server/models/row-reads.ts";
import { castRow, column, selectRows, table } from "../../server/models/sql.ts";

import { RubyNoMethodError } from "./calculate-sale-numbers-worker.ts";
import { modelJob } from "./support/job-deps.ts";

const SUMMARY_DELAY_SECONDS = 20 * 60;
const AUTHORIZATION_SUCCESSFUL = "authorization_successful";

export const chargeSuccessfulPreordersWorkerWith = modelJob(
  { min: 1 },
  async ([preorderLinkId], _deps, { runtime }) => {
    // `find_by(id: nil)` still asks the database.
    const id = await beforeSideEffects(() =>
      preorderLinkId === null ? null : recordIdFrom(preorderLinkId, "PreorderLink.find_by"),
    );
    const preorderLink = await findOneBy("PreorderLink", "id", id, true);
    if (preorderLink === null) throw new RubyNoMethodError("undefined method 'preorders' for nil");

    const rows = await selectRows(
      Prisma.sql`SELECT ${Prisma.raw("`preorders`.*")} FROM ${table("preorders")} WHERE ${column("preorders", "preorder_link_id")} = ${id} AND ${column("preorders", "state")} = ${AUTHORIZATION_SUCCESSFUL}`,
    );
    for (const row of rows) {
      await enqueueWith(runtime, "ChargePreorderWorker", [Number(castRow<Preorder>("Preorder", row).id)]);
    }
    if (rows.length > 0) {
      await enqueueWith(runtime, "SendPreorderSellerSummaryWorker", [preorderLinkId!], {
        delaySeconds: SUMMARY_DELAY_SECONDS,
      });
    }
  },
);

export const chargeSuccessfulPreordersWorker = chargeSuccessfulPreordersWorkerWith();
