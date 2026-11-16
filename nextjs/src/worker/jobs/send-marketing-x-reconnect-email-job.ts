// Port of app/sidekiq/send_marketing_x_reconnect_email_job.rb. The mail goes out with
// `deliver_now` semantics through the Node port of CreatorMailer#marketing_x_reconnect.
import { Prisma } from "@prisma/client";

import { deliverLater, keywordArgs } from "../../server/mail/active-job.ts";
import { findRow } from "../../server/mail/application-mailer.ts";
import { composeNodeMail, defaultMailDeliveryDeps, isNotPorted, type MailDeliveryDeps, sendComposed } from "../../server/mail/delivery.ts";
import { awaitingReconnect } from "../../server/mail/mailers/creator-mailer.ts";
import { RubyHash, RubySymbol } from "../../server/mail/ruby-value.ts";
import { column, columnNotIn, execute, selectRows, table } from "../../server/models/sql.ts";
import { transaction } from "../../server/models/runtime/transaction.ts";
import { defaultJobDeps, type JobDeps, modelJob } from "./support/job-deps.ts";
import type { JobContext, JobHandler } from "./types.ts";

export class NewEligibleActionsError extends Error {
  constructor() {
    super("SendMarketingXReconnectEmailJob::NewEligibleActionsError");
  }
}

const ACTIONS = "marketing_actions";

// Marketing::Action.alive_for_reconnect_notice.where(user_id:)
const eligibleFor = (sellerId: unknown) =>
  Prisma.sql`${awaitingReconnect()} AND ${column(ACTIONS, "reconnect_notified_at")} IS NULL AND ${column(ACTIONS, "user_id")} = ${sellerId}`;
const byId = Prisma.sql` ORDER BY ${column(ACTIONS, "id")} ASC`;

// User#with_lock: a transaction around `lock!`, which reloads the row FOR UPDATE.
async function withSellerLock<T>(sellerId: unknown, fn: () => Promise<T>): Promise<T> {
  return transaction(async () => {
    await selectRows(Prisma.sql`SELECT \`users\`.* FROM \`users\` WHERE ${column("users", "id")} = ${sellerId} LIMIT 1 FOR UPDATE`);
    return fn();
  });
}

type Deps = JobDeps & { mail: MailDeliveryDeps };

// CreatorMailer.marketing_x_reconnect(marketing_action_id:).deliver_now.is_a?(Mail::Message). A
// message the port refuses to render is left to Rails with deliver_later and counted as sent.
async function deliver(context: JobContext, marketingActionId: number | bigint, deps: Deps): Promise<boolean> {
  const args = [new RubyHash([[new RubySymbol("marketing_action_id"), marketingActionId]])];
  let mail;
  try {
    mail = await composeNodeMail("CreatorMailer", "marketing_x_reconnect", args, deps.mail.mailer);
  } catch (error) {
    if (!isNotPorted(error)) throw error;
    deps.mail.log(`Handing CreatorMailer#marketing_x_reconnect back to Rails: ${(error as Error).message}`);
    await deliverLater(context.runtime, { mailer: "CreatorMailer", method: "marketing_x_reconnect", args: [keywordArgs({ marketing_action_id: Number(marketingActionId) })] }, "ruby");
    return true;
  }
  if (mail === undefined) return false;
  return sendComposed(mail, deps.mail);
}

export function sendMarketingXReconnectEmailJobWith(overrides: Partial<Deps> = {}): JobHandler {
  const deps: Deps = { ...defaultJobDeps, mail: defaultMailDeliveryDeps, ...overrides };
  return modelJob({ min: 1 }, async ([sellerId], _jobDeps, context) => {
    if (typeof sellerId !== "number" && typeof sellerId !== "bigint") throw new TypeError(`seller_id must be an Integer, got ${JSON.stringify(sellerId)}`);
    const seller = await findRow<{ id: number | bigint }>("users", sellerId);
    if (seller === null) return;

    const pendingIds = await withSellerLock(seller.id, async () =>
      (await selectRows<{ id: number | bigint }>(Prisma.sql`SELECT ${column(ACTIONS, "id")} FROM ${table(ACTIONS)} WHERE ${eligibleFor(seller.id)}${byId}`)).map((row) => row.id),
    );
    if (pendingIds.length === 0) return;

    let delivered = false;
    for (const id of pendingIds) {
      if (await deliver(context, id, deps)) {
        delivered = true;
        break;
      }
    }
    if (!delivered) {
      const [newer] = await selectRows(
        Prisma.sql`SELECT 1 AS one FROM ${table(ACTIONS)} WHERE ${eligibleFor(seller.id)} AND ${columnNotIn(ACTIONS, "id", pendingIds)} LIMIT 1`,
      );
      if (newer) throw new NewEligibleActionsError();
      return;
    }

    await withSellerLock(seller.id, () =>
      execute(Prisma.sql`UPDATE ${table(ACTIONS)} SET ${column(ACTIONS, "reconnect_notified_at")} = ${deps.now()} WHERE ${eligibleFor(seller.id)}${byId}`),
    );
  })();
}

export const sendMarketingXReconnectEmailJob = sendMarketingXReconnectEmailJobWith();
