// Users::FeatureAnnouncementsController#confirm_unsubscribe: the GET of the unsubscribe link in feature announcement emails. It only
// shows a confirmation. #unsubscribe (the POST, which writes) is not routed to Node.
import { decryptSecureExternalPayload } from "../models/secure-external-id.ts";
import { findUser } from "../models/user.ts";

import { type ActionOptions, type Chain, type FilterOutcome } from "./application-controller.ts";
import { railsSegment } from "./mutation.ts";

const TOKEN_SCOPE = "feature_announcements_unsubscribe";
const NOT_FOUND = 404;

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
    return { state: {} };
  },
};

export const unsubscribeProps = (token: string) => ({
  unsubscribe_url: `/users/unsubscribe_feature_announcements/${railsSegment(token)}`,
  unsubscribed: false,
});
