// Users::FeatureAnnouncementsController: #confirm_unsubscribe, the GET of the unsubscribe link in feature announcement emails (it only
// shows a confirmation), and #unsubscribe, the POST of its button. The POST runs here only as the Inertia visit the page makes; the
// RFC 8058 one-click POST of a mailbox provider has no X-Inertia header and renders the HTML page, so the proxy leaves it with Rails.
import { Prisma } from "@prisma/client";

import { decryptSecureExternalPayload } from "../models/secure-external-id.ts";
import { execute, isLockWaitTimeout, selectRows, table } from "../models/sql.ts";
import { transaction } from "../models/runtime/transaction.ts";
import { findUser } from "../models/user.ts";

import { type ActionOptions, type Chain, type FilterOutcome, HandBackToRails } from "./application-controller.ts";
import { railsSegment } from "./mutation.ts";

const TOKEN_SCOPE = "feature_announcements_unsubscribe";
const NOT_FOUND = 404;
const SUBSCRIPTIONS = "feature_announcement_subscriptions";
const UNSUBSCRIBE_SOURCE = "unsubscribe_link";
// FeatureAnnouncementSubscription::LOCK_WAIT_SECONDS
const LOCK_WAIT_SECONDS = 10;

// FeatureAnnouncementSubscription.unsubscribe!: one statement, so an absent row still ends up as a tombstone. The lock wait is a session
// setting, so it is set and restored on the connection of a transaction. A timeout wrote nothing, which is why Rails can take the request.
async function unsubscribe(userId: number, now: Date): Promise<void> {
  try {
    await transaction(async () => {
      const [setting] = await selectRows<Record<string, unknown>>(Prisma.sql`SELECT @@SESSION.innodb_lock_wait_timeout`);
      const previous = setting ? Object.values(setting)[0] : null;
      await execute(Prisma.raw(`SET SESSION innodb_lock_wait_timeout = ${LOCK_WAIT_SECONDS}`));
      try {
        await execute(
          Prisma.sql`INSERT INTO ${table(SUBSCRIPTIONS)} (user_id, subscribed, version, source, created_at, updated_at) VALUES (${userId}, FALSE, 1, ${UNSUBSCRIBE_SOURCE}, ${now}, ${now}) ON DUPLICATE KEY UPDATE version = IF(subscribed, version + 1, version), source = IF(subscribed, ${UNSUBSCRIBE_SOURCE}, source), updated_at = IF(subscribed, ${now}, updated_at), subscribed = FALSE`,
        );
      } finally {
        if (previous != null && String(previous) !== "") await execute(Prisma.raw(`SET SESSION innodb_lock_wait_timeout = ${Math.trunc(Number(previous))}`));
      }
    });
  } catch (error) {
    if (isLockWaitTimeout(error)) throw new HandBackToRails("a lock wait timeout on the subscription row");
    throw error;
  }
}

// FeatureAnnouncementSubscription.decode_unsubscribe_token: [user_id, address_digest], or nil.
function decodeUnsubscribeToken(token: string, now: Date): number | null {
  const payload = decryptSecureExternalPayload("User", token, TOKEN_SCOPE, now);
  if (!Array.isArray(payload) || payload.length !== 2) return null;
  const [userId, digest] = payload as unknown[];
  return Number.isSafeInteger(userId) && typeof digest === "string" ? (userId as number) : null;
}

export const FEATURE_ANNOUNCEMENT_OPTIONS: ActionOptions = {
  filters: async (chain: Chain): Promise<FilterOutcome> => {
    // The link is a bearer capability: set_private_link_headers runs before the lookup, so the 404 carries them too.
    chain.headers.set("referrer-policy", "no-referrer");
    chain.headers.set("cache-control", "no-store");
    chain.headers.set("x-robots-tag", "noindex");
    const token = decodeURIComponent(chain.request.path.split("/").at(-1) ?? "");
    const userId = decodeUnsubscribeToken(token, chain.now);
    const user = userId === null ? null : await findUser(userId);
    if (user === null) return { halt: { status: NOT_FOUND, body: "", contentType: "text/html", rescued: true } };
    if (chain.request.method !== "POST") return { state: {} };
    if (chain.request.headers.get("x-inertia") === null) throw new HandBackToRails("a POST that renders the HTML page");
    await unsubscribe(userId!, chain.now);
    return { state: { unsubscribed: true } };
  },
};

export const unsubscribeProps = (token: string, state: Record<string, unknown>) =>
  state.unsubscribed === true
    ? { unsubscribe_url: null, unsubscribed: true }
    : { unsubscribe_url: `/users/unsubscribe_feature_announcements/${railsSegment(token)}`, unsubscribed: false };
