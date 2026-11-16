// Port of app/sidekiq/alert_on_zero_buyer_currency_wallet_purchases_job.rb: with both buyer-currency wallet features fully enabled
// and no Apple Pay / Google Pay purchase carrying a non-USD presentment row in the last 24 hours, one alert goes to the
// agent_reports room per throttle window. A feature whose Rails answer is a coin flip (a percentage of time strictly between 0
// and 100, which Flipper rolls per call) or that uses an expression gate is handed back; nothing has been written by then.
// Golden: __fixtures__/alert-on-zero-buyer-currency-wallet-purchases-job.golden.json
// (scripts/golden/alert-on-zero-buyer-currency-wallet-purchases-job.rb).
import { Prisma } from "@prisma/client";

import { parseGateValues, readFeatureDoc } from "../../server/infra/flipper.ts";
import { getRedis } from "../../server/infra/redis.ts";
import { HandBackToRuby } from "../../server/jobs/hand-back.ts";
import { performAsync } from "../../server/models/concerns/job-runtime.ts";
import { ago } from "../../server/models/concerns/ruby-time.ts";
import { columnIn, columnNotIn, selectRows, table } from "../../server/models/sql.ts";

import { type JobDeps, modelJob } from "./support/job-deps.ts";

const PAYMENT_ELEMENT_WALLETS_FEATURE = "payment_element_wallets";
const WALLETS_FEATURE = "buyer_currency_wallets";
const WALLET_TYPES = ["apple_pay", "google_pay"];
const USD = "usd";
const ZERO_VOLUME_WINDOW = { hours: 24 };
const ALERT_THROTTLE_SECONDS = 24 * 60 * 60;
const ALERT_ROOM = "agent_reports";
const ALERT_THROTTLE_KEY = "buyer_currency_wallet_presentment_zero:alerted_at";
const MS_PER_HOUR = 3_600_000;
const PERCENT = 100;

export type WalletAlertRedis = {
  set(key: string, value: string, expiry: "EX", seconds: number, mode: "NX"): Promise<unknown>;
  del(key: string): Promise<unknown>;
  hgetall(key: string): Promise<Record<string, string>>;
};
export type WalletAlertDeps = { redis: () => WalletAlertRedis };

const PURCHASES = "purchases";
const PRESENTMENTS = "purchase_presentments";
const WALLET_TYPE_ROWS = "purchase_wallet_types";

// Flipper.enabled?(name) with no actor, or either percentage reading 100 (Flipper caps both there, so `.to_i` cannot change the comparison).
async function featureFullyEnabled(name: string, redis: WalletAlertRedis): Promise<boolean> {
  const values = parseGateValues(await readFeatureDoc(name, redis as never));
  if (values.boolean) return true;
  if (values.expression !== undefined && values.expression !== null) {
    throw new HandBackToRuby(`${name} uses an expression gate`);
  }
  // Rails rolls `rand` for the time gate on every call, so the outcome of a partial percentage is not reproducible.
  if (values.percentageOfTime > 0 && values.percentageOfTime < PERCENT) {
    throw new HandBackToRuby(`${name} is enabled for a percentage of time`);
  }
  return values.percentageOfActors >= PERCENT || values.percentageOfTime >= PERCENT;
}

const walletPresentmentPurchases = () =>
  Prisma.sql`FROM ${table(PURCHASES)} INNER JOIN ${table(PRESENTMENTS)} ON ${Prisma.raw(`\`${PRESENTMENTS}\`.\`purchase_id\` = \`${PURCHASES}\`.\`id\``)} INNER JOIN ${table(WALLET_TYPE_ROWS)} ON ${Prisma.raw(`\`${WALLET_TYPE_ROWS}\`.\`purchase_id\` = \`${PURCHASES}\`.\`id\``)} WHERE ${Prisma.raw(`\`${PURCHASES}\`.\`purchase_state\``)} = ${"successful"} AND ${columnIn(WALLET_TYPE_ROWS, "wallet_type", WALLET_TYPES)} AND ${columnNotIn(PRESENTMENTS, "presentment_currency", [USD])}`;

function headline(lastPurchaseAt: Date | null, now: Date): string {
  if (lastPurchaseAt === null) {
    return "No buyer-currency wallet purchase with a non-USD presentment row has ever been recorded while the buyer-currency wallet lane is fully enabled.";
  }
  const hours = Math.floor((now.getTime() - lastPurchaseAt.getTime()) / MS_PER_HOUR);
  const at = `${lastPurchaseAt.toISOString().slice(0, 10)} ${lastPurchaseAt.toISOString().slice(11, 16)} UTC`;
  return `No buyer-currency wallet purchase with a non-USD presentment row has been recorded in ${hours} hours while the buyer-currency wallet lane is fully enabled. The last one was at ${at}.`;
}

const messageFor = (lastPurchaseAt: Date | null, now: Date) =>
  [
    headline(lastPurchaseAt, now),
    "",
    "Expected baseline before the Aug 16 regression was about 370–420 wallet purchases with presentment rows per day. Check antiwork/gumroad-private#2326 and the payment_element_wallets plus buyer_currency_wallets flags before closing the incident.",
  ].join("\n");

export const alertOnZeroBuyerCurrencyWalletPurchasesJobWith = (
  overrides: Partial<JobDeps> = {},
  alert: Partial<WalletAlertDeps> = {},
) =>
  modelJob({ min: 0 }, async (_args, deps) => {
    const redis = (alert.redis ?? (() => getRedis("main") as unknown as WalletAlertRedis))();
    const resetThrottle = () => redis.del(ALERT_THROTTLE_KEY);

    const fullyEnabled =
      (await featureFullyEnabled(PAYMENT_ELEMENT_WALLETS_FEATURE, redis)) &&
      (await featureFullyEnabled(WALLETS_FEATURE, redis));
    if (!fullyEnabled) {
      await resetThrottle();
      return;
    }

    const recent = await selectRows(
      Prisma.sql`SELECT 1 AS one ${walletPresentmentPurchases()} AND (purchases.created_at >= ${ago(ZERO_VOLUME_WINDOW, deps.now())}) LIMIT 1`,
    );
    if (recent.length > 0) {
      await resetThrottle();
      return;
    }

    // Claim before enqueue so overlapping hourly (or manual) runs cannot both notify.
    const now = deps.now();
    const claimed = await redis.set(ALERT_THROTTLE_KEY, String(Math.floor(now.getTime() / 1000)), "EX", ALERT_THROTTLE_SECONDS, "NX");
    if (!claimed) return;

    // Newest id rather than MAX(created_at), which has no supporting index. Read outside the rescue: only the push releases the claim.
    const [last] = await selectRows<{ created_at: Date | null }>(
      Prisma.sql`SELECT ${Prisma.raw(`\`${PURCHASES}\`.\`created_at\``)} ${walletPresentmentPurchases()} ORDER BY ${Prisma.raw(`\`${PURCHASES}\`.\`id\``)} DESC LIMIT 1`,
    );
    try {
      await performAsync("InternalNotificationWorker", [
        ALERT_ROOM,
        "Buyer-currency wallet purchases at zero",
        messageFor(last?.created_at ?? null, now),
      ]);
    } catch (error) {
      await resetThrottle();
      throw error;
    }
  })(overrides);

export const alertOnZeroBuyerCurrencyWalletPurchasesJob = alertOnZeroBuyerCurrencyWalletPurchasesJobWith();
