// Port of app/sidekiq/expiring_credit_card_message_worker.rb: for every card that expires next month, each of its users with an email
// address is queued CustomerLowPriorityMailer#credit_card_expiring_membership for every membership still charging that card
// (the mailer stays in Ruby, so each ActiveJob push is built as `deliver_later(queue: "low")` builds it).
// Golden: __fixtures__/expiring-credit-card-message-worker.golden.json (scripts/golden/expiring-credit-card-message-worker.rb); the
// cases run on different days, so "today" is the golden's own clock.
import { Prisma, type CreditCard, type Subscription, type User } from "@prisma/client";

import { deliverLater } from "../../server/mail/active-job.ts";
import { mailRoute } from "../../server/mail/delivery.ts";
import { isBlank } from "../../server/models/runtime/validators.ts";
import { castRow, column, columnIn, findInBatches, selectRows, table } from "../../server/models/sql.ts";

import { modelJob } from "./support/job-deps.ts";

const FIND_EACH_BATCH_SIZE = 1_000;
const MAILER = "CustomerLowPriorityMailer";
const METHOD = "credit_card_expiring_membership";
const CARDS = "credit_cards";
const USERS = "users";
const SUBSCRIPTIONS = "subscriptions";
// flag_shih_tzu's bit for is_test_subscription, which the raw `active_without_pending_cancel` scope binds as a string.
const IS_TEST_SUBSCRIPTION_BIT = "1";

// `Date.today.at_beginning_of_month.next_month`, in the server's UTC day.
function cutoffMonth(now: Date): { month: number; year: number } {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { month: next.getUTCMonth() + 1, year: next.getUTCFullYear() };
}

// `user.form_email.present?`
const hasFormEmail = (user: User) => !isBlank(isBlank(user.unconfirmed_email) ? user.email : user.unconfirmed_email);

export const expiringCreditCardMessageWorkerWith = modelJob({ min: 0 }, async (_args, deps, { runtime }) => {
  const { month, year } = cutoffMonth(deps.now());
  const expiring = Prisma.sql`${column(CARDS, "expiry_month")} = ${month} AND ${column(CARDS, "expiry_year")} = ${year}`;

  await findInBatches<CreditCard>(CARDS, expiring, FIND_EACH_BATCH_SIZE, async (cards) => {
    // includes(:users): one query per batch.
    const userRows = await selectRows(
      Prisma.sql`SELECT ${Prisma.raw("`users`.*")} FROM ${table(USERS)} WHERE ${columnIn(
        USERS,
        "credit_card_id",
        cards.map((card) => card.id),
      )}`,
    );
    const users = userRows.map((row) => castRow<User>("User", row));

    for (const card of cards) {
      for (const user of users.filter((candidate) => String(candidate.credit_card_id) === String(card.id))) {
        if (!hasFormEmail(user)) continue;
        const subscriptions = await selectRows(
          Prisma.sql`SELECT ${Prisma.raw("`subscriptions`.*")} FROM ${table(SUBSCRIPTIONS)} WHERE ${column(SUBSCRIPTIONS, "user_id")} = ${user.id} AND (subscriptions.flags & ${IS_TEST_SUBSCRIPTION_BIT} = 0 and failed_at is null and ended_at is null and cancelled_at is null) AND ${column(SUBSCRIPTIONS, "credit_card_id")} = ${card.id}`,
        );
        for (const row of subscriptions) {
          const subscription = castRow<Subscription>("Subscription", row);
          await deliverLater(
            runtime,
            { mailer: MAILER, method: METHOD, args: [Number(subscription.id)], queue: "low" },
            mailRoute(MAILER, METHOD),
          );
        }
      }
    }
  });
});

export const expiringCreditCardMessageWorker = expiringCreditCardMessageWorkerWith();
