// EventsController#create (POST /events/track_user_action): the page-view style events the storefront posts.
import { railsLoggedInUser } from "../auth/resolve.ts";
import { createUserEvent } from "../page-props/audience/events.ts";
import { NotPortedError } from "../page-props/not-ported.ts";
import { jsonResponse } from "./json-seller.ts";
import { registerMutations } from "./mutation.ts";

// Event::PERMITTED_NAMES: other names are only kept for a signed-in user.
const PERMITTED_NAMES = new Set([
  "add_product_mobile_app",
  "audience_callout_dismissal",
  "chargeback",
  "delete_product_mobile_app",
  "edit_product_mobile_app",
  "first_purchase_on_profile_visit",
  "post_view",
  "product_purchase_recovery_click",
  "product_refund_policy_fine_print_view",
  "purchase",
  "refund",
  "service_charge",
  "settlement_declined",
  "social_connect_attempted",
  "social_connect_connected",
  "social_connect_failed",
  "social_connect_hold_released",
  "social_connect_offered",
  "social_connect_reviewed",
]);
// create_event builds a SignupEvent for this name.
const SIGNUP_EVENT = "signup";

registerMutations({
  method: "POST",
  pattern: "/events/track_user_action",
  formats: ["any"],
  run: async ({ request, context, url, params, peekState }) => {
    const name = params.event_name;
    // `create_user_event` returns before create_event when the name is nil.
    if (name !== undefined && name !== null) {
      if (typeof name !== "string") throw new NotPortedError("a non-string event_name");
      if (name === SIGNUP_EVENT) throw new NotPortedError("a signup event");
      // create_event drops an unlisted name when there is no user.
      if (PERMITTED_NAMES.has(name) || railsLoggedInUser(context) !== null) await createUserEvent(name, { context, headers: request.headers, url, state: peekState(), params });
    }
    return jsonResponse({ success: true });
  },
});
