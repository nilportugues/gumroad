// Port of app/sidekiq/stripe_payouts_paused_email_job.rb: the debounced "payouts paused" email for a Stripe-initiated pause. Under the
// seller's lock the account is reloaded and the claim token compared; a pause that resolved (or an under-review pause over an account
// with nothing at stake) releases the claim, and an email still owed is queued once the lock is released.
// Golden: __fixtures__/stripe-payouts-paused-email-job.golden.json (scripts/golden/stripe-payouts-paused-email-job.rb).
import { Prisma, type MerchantAccount } from "@prisma/client";

import { beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { deliverLater } from "../../server/mail/active-job.ts";
import { mailRoute } from "../../server/mail/delivery.ts";
import { jsonDataForAttr, setJsonDataForAttr } from "../../server/models/concerns/json-data.ts";
import { MerchantAccounts } from "../../server/models/merchant-account.ts";
import { findByIdBang, recordIdFrom } from "../../server/models/row-reads.ts";
import { column, columnIn, selectRows, table } from "../../server/models/sql.ts";
import {
  findUserBang,
  isAccountActive,
  isFlagSet,
  payoutsPausedBy,
  Users,
  type UserRecord,
} from "../../server/models/user.ts";

import { modelJob } from "./support/job-deps.ts";

const MAILER = "MerchantRegistrationMailer";
// Purchase::ALL_SUCCESS_STATES
const ALL_SUCCESS_STATES = [
  "preorder_authorization_successful",
  "successful",
  "not_charged",
  "gift_receiver_purchase_successful",
];
const PAUSE_SOURCES_FROM_FLAG = ["stripe", "system"];

// User#payouts_paused_by_source
function payoutsPausedBySource(user: UserRecord): string | null {
  if (isFlagSet(user, "payouts_paused_internally")) {
    const by = payoutsPausedBy(user);
    return typeof by === "string" && PAUSE_SOURCES_FROM_FLAG.includes(by) ? by : "admin";
  }
  return isFlagSet(user, "payouts_paused_by_user") ? "user" : null;
}

// `user.unpaid_balance_cents.zero? && !user.sales.all_success_states.exists?`
async function nothingAtStake(user: UserRecord): Promise<boolean> {
  const [balance] = await selectRows<Record<string, unknown>>(
    Prisma.sql`SELECT SUM(${column("balances", "amount_cents")}) FROM ${table("balances")} WHERE ${column("balances", "user_id")} = ${user.get("id")} AND ${column("balances", "state")} = 'unpaid'`,
  );
  const unpaid = Object.values(balance ?? {})[0];
  if (unpaid != null && BigInt(String(unpaid)) !== 0n) return false;
  const sales = await selectRows(
    Prisma.sql`SELECT 1 AS one FROM ${table("purchases")} WHERE ${column("purchases", "seller_id")} = ${user.get("id")} AND ${columnIn("purchases", "purchase_state", ALL_SUCCESS_STATES)} LIMIT 1`,
  );
  return sales.length === 0;
}

export const stripePayoutsPausedEmailJobWith = modelJob(
  { min: 4, max: 4 },
  async ([userId, merchantAccountId, emailType, claimToken], deps, { runtime }) => {
    const userKey = await beforeSideEffects(() => recordIdFrom(userId, "User.find"));
    const user = await findUserBang(userKey);
    const accountKey = await beforeSideEffects(() => recordIdFrom(merchantAccountId, "MerchantAccount.find"));
    const merchantAccount = MerchantAccounts.load(await findByIdBang<MerchantAccount>("MerchantAccount", accountKey));
    const options = { now: deps.now };

    let emailToSend: unknown = null;
    // The same per-user lock the webhook handler takes, so a concurrent pause or resume cannot race the decision.
    await Users.withLock(user, async () => {
      await MerchantAccounts.reload(merchantAccount);
      // A newer claim token means the pause was lifted and raised again after this job was scheduled.
      if (jsonDataForAttr(merchantAccount, "stripe_payouts_pause_email_claim_token") !== claimToken) return;

      const release = async () => {
        setJsonDataForAttr(merchantAccount, "stripe_payouts_pause_email_sent", null);
        setJsonDataForAttr(merchantAccount, "stripe_payouts_pause_email_claim_token", null);
        await MerchantAccounts.saveBang(merchantAccount, options);
      };
      if (
        isFlagSet(user, "payouts_paused_internally") &&
        payoutsPausedBySource(user) === "stripe" &&
        isAccountActive(user)
      ) {
        if (emailType === "under_review" && (await nothingAtStake(user))) await release();
        else emailToSend = emailType;
      } else {
        await release();
      }
    });

    const method =
      emailToSend === "action_required"
        ? "stripe_payouts_disabled"
        : emailToSend === "under_review"
          ? "stripe_payouts_under_review"
          : null;
    if (method === null) return;
    await deliverLater(runtime, { mailer: MAILER, method, args: [Number(user.get("id"))] }, mailRoute(MAILER, method));
  },
);

export const stripePayoutsPausedEmailJob = stripePayoutsPausedEmailJobWith();
