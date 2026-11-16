// Port of app/sidekiq/send_community_chat_recap_notifications_job.rb. The mails it queues are
// CommunityChatRecapMailer's, delivered by whichever side owns that mailer. A run id that is a string of
// digits is cast like `find` does; any other non-Integer id hands back.
import { Prisma } from "@prisma/client";

import { notifyError } from "../../server/infra/error-reporting.ts";
import { beforeSideEffects, HandBackToRuby } from "../../server/jobs/hand-back.ts";
import { deliverLater } from "../../server/mail/active-job.ts";
import { RecordNotFoundError } from "../../server/mail/application-mailer.ts";
import { mailRoute } from "../../server/mail/delivery.ts";
import {
  COMMUNITY_CHAT_RECAP_RUNS,
  COMMUNITY_CHAT_RECAPS,
  RECAP_STATUSES,
} from "../../server/models/community-chat-recap-run.ts";
import { accessibleCommunitiesIds, COMMUNITIES, NilResourceError } from "../../server/models/community.ts";
import { column, columnIn, selectRows, table } from "../../server/models/sql.ts";

import { checkArity } from "./arity.ts";
import type { JobHandler } from "./types.ts";

const MAILER = "CommunityChatRecapMailer";
const METHOD = "community_chat_recap_notification";
const SETTINGS = "community_notification_settings";
const USERS = "users";

type Id = number | bigint;
type Mail = { userId: Id; sellerId: Id; recapIds: Id[] };

const allColumns = (name: string) => Prisma.raw(`\`${name}\`.*`);
const key = (id: Id | null) => String(id);
const uniq = (ids: Id[]): Id[] => [...new Map(ids.map((id) => [key(id), id])).values()];

// Enumerable#group_by: keys in order of first appearance.
function groupBy<T>(items: T[], keyOf: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const group = groups.get(keyOf(item));
    if (group) group.push(item);
    else groups.set(keyOf(item), [item]);
  }
  return groups;
}

// Everything the job does before its first mail is a read, so the mails are collected first: a case
// the port cannot run (NotPortedError, from any user's lookup) then hands the whole job to Rails
// with nothing written, and a failure part-way still queues the mails Ruby had queued by then.
async function collectMails(runId: Id | null, runIdLabel: string, mails: Mail[]): Promise<void> {
  if (runId === null) throw new RecordNotFoundError("Couldn't find CommunityChatRecapRun without an ID");
  const [run] = await selectRows<{ recap_frequency: string; finished_at: Date | null }>(
    Prisma.sql`SELECT ${allColumns(COMMUNITY_CHAT_RECAP_RUNS)} FROM ${table(COMMUNITY_CHAT_RECAP_RUNS)} WHERE ${column(COMMUNITY_CHAT_RECAP_RUNS, "id")} = ${runId} LIMIT 1`,
  );
  if (!run) throw new RecordNotFoundError(`Couldn't find CommunityChatRecapRun with 'id'=${runIdLabel}`);
  if (run.finished_at == null) return;

  const R = COMMUNITY_CHAT_RECAPS;
  const recaps = await selectRows<{ id: Id; community_id: Id | null }>(
    Prisma.sql`SELECT ${column(R, "id")}, ${column(R, "community_id")} FROM ${table(R)} WHERE ${column(R, "community_chat_recap_run_id")} = ${runId} AND ${column(R, "status")} = ${RECAP_STATUSES.finished}`,
  );
  const recapIdsByCommunity = new Map(
    [...groupBy(recaps, (recap) => key(recap.community_id))].map(([communityId, group]) => [
      communityId,
      group.map((recap) => recap.id),
    ]),
  );
  if (recapIdsByCommunity.size === 0) return;

  const settings = await selectRows<{ user_id: Id; seller_id: Id }>(
    Prisma.sql`SELECT ${allColumns(SETTINGS)} FROM ${table(SETTINGS)} WHERE ${column(SETTINGS, "recap_frequency")} = ${run.recap_frequency} ORDER BY ${column(SETTINGS, "user_id")} ASC`,
  );
  // includes(:user)
  const users = new Map<string, { id: Id; email: string | null }>();
  if (settings.length > 0) {
    const rows = await selectRows<{ id: Id; email: string | null }>(
      Prisma.sql`SELECT ${allColumns(USERS)} FROM ${table(USERS)} WHERE ${columnIn(USERS, "id", uniq(settings.map((setting) => setting.user_id)))}`,
    );
    for (const row of rows) users.set(key(row.id), row);
  }
  const settingsByUser = groupBy(settings, (setting) => key(setting.user_id));
  if (settingsByUser.size === 0) return;

  const sellerIds = uniq([...settingsByUser.values()].flat().map((setting) => setting.seller_id));
  const communities = await selectRows<{ id: Id; seller_id: Id }>(
    Prisma.sql`SELECT ${column(COMMUNITIES, "id")}, ${column(COMMUNITIES, "seller_id")} FROM ${table(COMMUNITIES)} WHERE ${column(COMMUNITIES, "deleted_at")} IS NULL AND ${columnIn(COMMUNITIES, "seller_id", sellerIds)}`,
  );
  const communityIdsBySeller = new Map(
    [...groupBy(communities, (community) => key(community.seller_id))].map(([sellerId, group]) => [
      sellerId,
      group.map((community) => community.id),
    ]),
  );
  if (communityIdsBySeller.size === 0) return;

  for (const [userId, userSettings] of settingsByUser) {
    const user = users.get(userId);
    if (!user) throw new NilResourceError("accessible_communities_ids");
    const accessible = new Set((await accessibleCommunitiesIds(user)).map(key));

    for (const setting of userSettings) {
      // Array#&: the seller's communities, in their order, that the user can open.
      const communityIds = (communityIdsBySeller.get(key(setting.seller_id)) ?? []).filter((id) =>
        accessible.has(key(id)),
      );
      if (communityIds.length === 0) continue;
      const recapIds = communityIds.flatMap((id) => recapIdsByCommunity.get(key(id)) ?? []);
      if (recapIds.length === 0) continue;
      mails.push({ userId: user.id, sellerId: setting.seller_id, recapIds });
    }
  }
}

const integer = (id: Id): number => Number(id);

export type Deps = { notify: (error: unknown) => void };

export function sendCommunityChatRecapNotificationsJobWith(overrides: Partial<Deps> = {}): JobHandler {
  const deps: Deps = { notify: (error) => notifyError(error), ...overrides };
  return async (args, { runtime }) => {
    checkArity(args, 1);
    const [runId] = args;
    // `find("42")` casts the digits; a not-found message prints the argument as it came.
    const isDigits = typeof runId === "string" && /^[0-9]{1,15}$/u.test(runId);
    if (runId !== null && typeof runId !== "number" && typeof runId !== "bigint" && !isDigits)
      throw new HandBackToRuby(`a non-Integer community_chat_recap_run_id: ${JSON.stringify(runId)}`);
    const numericRunId = typeof runId === "string" ? BigInt(runId) : runId;

    const mails: Mail[] = [];
    let failure: unknown = null;
    try {
      await beforeSideEffects(() => collectMails(numericRunId, String(runId), mails));
    } catch (error) {
      if (error instanceof HandBackToRuby) throw error;
      failure = error;
    }

    // `rescue => e` covers the pushes too: the first one that fails ends the loop.
    try {
      for (const mail of mails) {
        await deliverLater(
          runtime,
          {
            mailer: MAILER,
            method: METHOD,
            args: [integer(mail.userId), integer(mail.sellerId), mail.recapIds.map(integer)],
          },
          mailRoute(MAILER, METHOD),
        );
      }
    } catch (error) {
      failure = error;
    }
    if (failure !== null) deps.notify(failure);
  };
}

export const sendCommunityChatRecapNotificationsJob = sendCommunityChatRecapNotificationsJobWith();
