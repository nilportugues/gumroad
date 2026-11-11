// FollowersController#destroy (app/controllers/followers_controller.rb): a seller removing a subscriber from the subscribers page.
import { railsLoggedInUser } from "../auth/resolve.ts";
import { findByExternalId, markDeletedBang, withOptOutLockWait } from "../models/follower.ts";
import { RecordInvalid } from "../models/runtime/errors.ts";
import { isLockWaitTimeout } from "../models/sql.ts";
import { notAllowedMessage } from "../page-props/settings/guard.ts";
import { audienceFollowerPolicy } from "../policies/audience-follower.ts";
import { authorize } from "../policies/authorize.ts";
import { loadSellerContext, NotAuthorizedError } from "../policies/seller-context.ts";

import { HandBackToRails, RoutingError, type ActionResult } from "./application-controller.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";

const SEE_OTHER = 303;

// The opt-out waited too long for a follow a post handoff holds, or the follow no longer validates. Rails answers 503 with
// Retry-After or raises; neither is reproduced here, and the transaction has rolled back, so Rails takes the request whole.
function handBackFailedOptOut(error: unknown): never {
  if (isLockWaitTimeout(error)) throw new HandBackToRails("a follow held by a post handoff (LockWaitTimeout)");
  if (error instanceof RecordInvalid) throw new HandBackToRails("a follow that fails validation");
  throw error;
}

async function destroy(input: MutationInput): Promise<ActionResult> {
  const { context, routeParams } = input;
  if (railsLoggedInUser(context) === null || context.currentSeller === null)
    throw new HandBackToRails("a signed-out request");

  // fetch_follower runs before the action's `authorize`, and finds any seller's follow: the policy only asks about the role.
  const follower = await findByExternalId(routeParams.id!);
  if (follower === null) throw new RoutingError("Not Found");

  const sellerContext = await loadSellerContext(context);
  try {
    authorize(audienceFollowerPolicy.destroy, sellerContext);
  } catch (error) {
    if (!(error instanceof NotAuthorizedError)) throw error;
    // PunditAuthorization#default_user_not_authorized
    const message = notAllowedMessage(sellerContext);
    const switching = input.request.queryString.includes("account_switched");
    return { status: 302, location: "/dashboard", ...(switching ? {} : { flash: { alert: message } }), rescued: true };
  }

  try {
    await withOptOutLockWait(() => markDeletedBang(follower));
  } catch (error) {
    handBackFailedOptOut(error);
  }
  return { status: SEE_OTHER, location: "/followers", flash: { notice: "Follower removed!" } };
}

registerMutations({
  method: "DELETE",
  pattern: "/followers/:id",
  run: destroy,
});
