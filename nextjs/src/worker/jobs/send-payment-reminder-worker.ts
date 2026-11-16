// Port of app/sidekiq/send_payment_reminder_worker.rb: every seller in a reminder-eligible risk state who allows announcements, has no
// payment address and is owed more than $10 is queued ContactingCreatorMailer#remind when no bank account, Stripe Connect account or
// PayPal account is set up and an email address is on file (the mailer stays in Ruby, so each ActiveJob push is built as
// `deliver_later(queue: "low")` builds it).
// Golden: __fixtures__/send-payment-reminder-worker.golden.json (scripts/golden/send-payment-reminder-worker.rb).
import { Prisma, type User } from "@prisma/client";

import { deliverLater } from "../../server/mail/active-job.ts";
import { mailRoute } from "../../server/mail/delivery.ts";
import { aliveStripeAccountsOf, isStripeConnectAccount } from "../../server/models/merchant-account.ts";
import { isBlank } from "../../server/models/runtime/validators.ts";
import { column, findInBatches, selectRows, table } from "../../server/models/sql.ts";

import { modelJob } from "./support/job-deps.ts";

const FIND_EACH_BATCH_SIZE = 1_000;
const MAILER = "ContactingCreatorMailer";
const METHOD = "remind";
const USERS = "users";
const MERCHANT_ACCOUNTS = "merchant_accounts";
const PAYPAL_CHARGE_PROCESSOR_ID = "paypal";

// Rails binds the `holding_balance_more_than(1000)` threshold as a quoted string in HAVING.
const HOLDING_BALANCE_CENTS = "1000";

// User::PAYMENT_REMINDER_RISK_STATES and the `announcement_notification_enabled` flag bit.
const ELIGIBLE = Prisma.raw(
  "(user_risk_state in ('flagged_for_tos_violation', 'not_reviewed', 'compliant')) AND ((`users`.`flags` & 1 = 1)) AND `users`.`payment_address` IS NULL AND `balances`.`state` = 'unpaid'",
);
const BALANCES_JOIN = Prisma.raw("INNER JOIN `balances` ON `balances`.`user_id` = `users`.`id`");
const GROUP_BY_BALANCE = Prisma.raw(
  `GROUP BY \`balances\`.\`user_id\` HAVING (SUM(balances.amount_cents) > '${HOLDING_BALANCE_CENTS}')`,
);

// `user.active_bank_account.nil?`
async function hasActiveBankAccount(userId: unknown): Promise<boolean> {
  const rows = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`bank_accounts`.*")} FROM ${table("bank_accounts")} WHERE ${column("bank_accounts", "user_id")} = ${userId} AND ${column("bank_accounts", "deleted_at")} IS NULL ORDER BY ${column("bank_accounts", "id")} ASC LIMIT 1`,
  );
  return rows.length > 0;
}

// `user.stripe_connect_account.blank?`
async function hasStripeConnectAccount(userId: unknown): Promise<boolean> {
  return (await aliveStripeAccountsOf(userId)).some(isStripeConnectAccount);
}

// `user.has_paypal_account_connected?`: any alive PayPal merchant account can accept charges.
async function hasPaypalAccountConnected(userId: unknown): Promise<boolean> {
  const rows = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`merchant_accounts`.*")} FROM ${table(MERCHANT_ACCOUNTS)} WHERE ${column(MERCHANT_ACCOUNTS, "user_id")} = ${userId} AND ${column(MERCHANT_ACCOUNTS, "deleted_at")} IS NULL AND ${column(MERCHANT_ACCOUNTS, "charge_processor_alive_at")} IS NOT NULL AND ${column(MERCHANT_ACCOUNTS, "charge_processor_deleted_at")} IS NULL AND ${column(MERCHANT_ACCOUNTS, "charge_processor_id")} = ${PAYPAL_CHARGE_PROCESSOR_ID}`,
  );
  return rows.length > 0;
}

// `user.form_email.present?`
const hasFormEmail = (user: User) => !isBlank(isBlank(user.unconfirmed_email) ? user.email : user.unconfirmed_email);

export const sendPaymentReminderWorkerWith = modelJob({ min: 0 }, async (_args, _deps, { runtime }) => {
  await findInBatches<User>(
    USERS,
    ELIGIBLE,
    FIND_EACH_BATCH_SIZE,
    async (users) => {
      for (const user of users) {
        if (await hasActiveBankAccount(user.id)) continue;
        if (await hasStripeConnectAccount(user.id)) continue;
        if (await hasPaypalAccountConnected(user.id)) continue;
        if (!hasFormEmail(user)) continue;
        await deliverLater(
          runtime,
          { mailer: MAILER, method: METHOD, args: [Number(user.id)], queue: "low" },
          mailRoute(MAILER, METHOD),
        );
      }
    },
    null,
    BALANCES_JOIN,
    GROUP_BY_BALANCE,
  );
});

export const sendPaymentReminderWorker = sendPaymentReminderWorkerWith();
