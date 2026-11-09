// Users::ReviewRemindersController: the subscribe and unsubscribe links of review reminder emails. They change the opt-out flag in
// the controller and then render a page with (almost) no props, so the writes run as the page's filters (ActionOptions.filters).
import { railsLoggedInUser } from "../auth/resolve.ts";
import { decryptSecureExternalId } from "../models/secure-external-id.ts";
import { RecordInvalid } from "../models/runtime/errors.ts";
import { findUser, setFlag, Users, type UserRecord } from "../models/user.ts";
import { type ActionOptions, type Chain, type FilterOutcome, HandBackToRails } from "./application-controller.ts";
import { railsSegment } from "./mutation.ts";

const TOKEN_SCOPE = "unsubscribe_review_reminders";
const OPT_OUT_FLAG = "opted_out_of_review_reminders";

// Users::ReviewRemindersController#set_review_reminder_opt_out: the opt-out is honoured even for an account that fails validation.
async function setOptOut(chain: Chain, user: UserRecord, optedOut: boolean): Promise<void> {
  setFlag(user, OPT_OUT_FLAG, optedOut);
  try {
    await Users.saveBang(user, { now: () => chain.now });
  } catch (error) {
    if (!(error instanceof RecordInvalid)) throw error;
    await Users.save(user, { validate: false, now: () => chain.now });
  }
}

function filters(optedOut: boolean, byToken: boolean): (chain: Chain) => Promise<FilterOutcome> {
  return async (chain) => {
    if (!byToken) {
      const visitor = railsLoggedInUser(chain.auth.context);
      if (visitor === null) throw new HandBackToRails("a signed-out visitor on a signed-in endpoint");
      const user = await findUser(visitor.id);
      if (user === null) throw new HandBackToRails("a user that vanished");
      // `update!` raises for an account that fails validation: that is Rails' error page.
      setFlag(user, OPT_OUT_FLAG, optedOut);
      try {
        await Users.saveBang(user, { now: () => chain.now });
      } catch (error) {
        if (error instanceof RecordInvalid) throw new HandBackToRails("an account that fails validation");
        throw error;
      }
      return { state: {} };
    }

    const id = decodeURIComponent(chain.request.path.split("/").at(-1) ?? "");
    const userId = decryptSecureExternalId("User", id, TOKEN_SCOPE, chain.now);
    const user = userId === null ? null : await findUser(userId);
    // before_action :set_user_from_token
    if (user === null) return { halt: { status: 302, location: "/", rescued: true } };
    await setOptOut(chain, user, optedOut);
    return { state: optedOut ? { subscribe_url: `/users/subscribe_review_reminders/${railsSegment(id)}` } : {} };
  };
}

export const REVIEW_REMINDER_OPTIONS = {
  subscribe: { filters: filters(false, false) } satisfies ActionOptions,
  unsubscribe: { filters: filters(true, false) } satisfies ActionOptions,
  subscribeByToken: { filters: filters(false, true) } satisfies ActionOptions,
  unsubscribeByToken: { filters: filters(true, true) } satisfies ActionOptions,
};

export const reviewReminderProps = (state: Record<string, unknown>) => (typeof state.subscribe_url === "string" ? { subscribe_url: state.subscribe_url } : {});
