// Port of app/sidekiq/send_preorder_seller_summary_worker.rb: once every authorized preorder of a link holds more than its
// authorization purchase, the seller's summary is queued with ContactingCreatorMailer (which stays in Ruby, so the ActiveJob push is
// built exactly as `deliver_later(queue: "critical")` builds it); until then the job reschedules itself every 20 minutes and gives up
// after 72 attempts. A link id Rails would cast (a float, a word) or an attempts count that is not an Integer is handed back before
// any statement.
// Golden: __fixtures__/send-preorder-seller-summary-worker.golden.json (scripts/golden/send-preorder-seller-summary-worker.rb).
import { Prisma } from "@prisma/client";

import { notifyError } from "../../server/infra/error-reporting.ts";
import { HandBackToRuby } from "../../server/jobs/hand-back.ts";
import { deliverLater } from "../../server/mail/active-job.ts";
import { mailRoute } from "../../server/mail/delivery.ts";
import { performAsync } from "../../server/models/concerns/job-runtime.ts";
import { findByIdBang, recordIdFrom } from "../../server/models/row-reads.ts";
import { selectRows } from "../../server/models/sql.ts";

import { modelJob } from "./support/job-deps.ts";

const MAX_ATTEMPTS_TO_WAIT_FOR_ALL_CHARGED = 72;
const WAIT_PERIOD_SECONDS = 20 * 60;
const MAILER = "ContactingCreatorMailer";
const METHOD = "preorder_summary";

export type Deps = { notify: (message: string) => void };

export function sendPreorderSellerSummaryWorkerWith(overrides: Partial<Deps> = {}) {
  const deps: Deps = { notify: (message) => notifyError(message), ...overrides };
  return modelJob({ min: 1, max: 2 }, async (args, _deps, { runtime }) => {
    const [linkId, rawAttempts] = args;
    const attempts = rawAttempts ?? 0;
    if (typeof attempts !== "number" || !Number.isSafeInteger(attempts))
      throw new HandBackToRuby("attempts is not an Integer");
    // The message prints the argument as it came, so a digit string is cast for the lookup only.
    const castable =
      (typeof linkId === "number" && Number.isSafeInteger(linkId)) ||
      (typeof linkId === "string" && /^[0-9]{1,15}$/u.test(linkId));
    if (!castable) throw new HandBackToRuby("the preorder link id is not an Integer");
    const id = linkId;

    if (attempts >= MAX_ATTEMPTS_TO_WAIT_FOR_ALL_CHARGED) {
      const message = `Timed out waiting for all preorders to be charged. PreorderLink: ${String(id)}.`;
      deps.notify(message);
      throw new Error(message);
    }

    const preorderLinkId = recordIdFrom(id, "PreorderLink.find");
    await findByIdBang("PreorderLink", preorderLinkId);
    // preorders.authorization_successful.joins(:purchases).merge(Purchase.not_in_progress).group("preorders.id").having("count(*) = 1").count("preorders.id")
    const waiting = await selectRows(
      Prisma.sql`SELECT COUNT(\`preorders\`.\`id\`) AS \`count_preorders_id\`, \`preorders\`.\`id\` AS \`preorders_id\` FROM \`preorders\` INNER JOIN \`purchases\` ON \`purchases\`.\`preorder_id\` = \`preorders\`.\`id\` WHERE \`preorders\`.\`preorder_link_id\` = ${preorderLinkId} AND \`preorders\`.\`state\` = 'authorization_successful' AND \`purchases\`.\`purchase_state\` != 'in_progress' GROUP BY \`preorders\`.\`id\` HAVING (count(*) = 1)`,
    );

    if (waiting.length === 0) {
      await deliverLater(
        runtime,
        { mailer: MAILER, method: METHOD, args: [id], queue: "critical" },
        mailRoute(MAILER, METHOD),
      );
    } else {
      await performAsync("SendPreorderSellerSummaryWorker", [id, attempts + 1], { delaySeconds: WAIT_PERIOD_SECONDS });
    }
  })();
}

export const sendPreorderSellerSummaryWorker = sendPreorderSellerSummaryWorkerWith();
