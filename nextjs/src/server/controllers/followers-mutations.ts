// FollowersController#destroy, #confirm, #cancel and #new (app/controllers/followers_controller.rb): a seller removing a subscriber
// from the subscribers page, the links in the confirmation and unsubscribe emails, and the `/:username/follow` link.
//
// #cancel renders an Inertia page after its write for an HTML request, which a mutation cannot do: only the JSON answer and the 404
// are served here, and an HTML request for a follow that exists goes to Rails whole, before the write. #create and #from_embed_form
// are throttled by Rack::Attack and stay in Rails.
import { Prisma } from "@prisma/client";

import { encrypt } from "../../lib/obfuscate-ids.ts";
import { railsLoggedInUser } from "../auth/resolve.ts";
import {
  confirmBang,
  coveredByCutover,
  findByExternalId,
  hasFollowerWorkflows,
  markDeletedBang,
  withOptOutLockWait,
} from "../models/follower.ts";
import { RecordInvalid } from "../models/runtime/errors.ts";
import { castRow, column, isLockWaitTimeout, selectRows, table } from "../models/sql.ts";
import { isAccountActive, subdomainWithProtocol, Users } from "../models/user.ts";
import { notAllowedMessage } from "../page-props/settings/guard.ts";
import { audienceFollowerPolicy } from "../policies/audience-follower.ts";
import { authorize } from "../policies/authorize.ts";
import { loadSellerContext, NotAuthorizedError } from "../policies/seller-context.ts";

import { HandBackToRails, RoutingError, type ActionResult } from "./application-controller.ts";
import { json } from "./json-actions.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";
import { requestFormat } from "./rails-params.ts";
import { profileUser } from "./users-controller.ts";

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

async function confirm(input: MutationInput): Promise<ActionResult> {
  const follower = await findByExternalId(input.routeParams.id!);
  if (follower === null) throw new RoutingError("Not Found");

  const followedId = follower.get("followed_id");
  const [row] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`users`.*")} FROM ${table("users")} WHERE ${column("users", "id")} = ${followedId} LIMIT 1`,
  );
  // `@follower.user` is nil: Rails raises NoMethodError.
  if (!row) throw new HandBackToRails("a follow whose seller row is missing");
  const seller = Users.load(castRow("User", row));
  if (!isAccountActive(seller)) throw new RoutingError("Not Found");

  // newsletter_retired? and the cutover barrier of the save are not ported, nor is the workflow scheduling after it.
  if (await coveredByCutover(followedId)) throw new HandBackToRails("a seller in a newsletter cutover");
  if (follower.get("confirmed_at") === null && (await hasFollowerWorkflows(followedId)))
    throw new HandBackToRails("a seller with follower workflows to schedule");
  // `URI(nil)` raises in Rails.
  const profileUrl = subdomainWithProtocol(seller);
  if (profileUrl === null) throw new HandBackToRails("a seller without a subdomain");

  try {
    await confirmBang(follower);
  } catch (error) {
    if (error instanceof RecordInvalid) throw new HandBackToRails("a follow that fails validation");
    throw error;
  }
  return { status: 302, location: profileUrl, flash: { notice: "Thanks for the follow!" } };
}

async function cancel(input: MutationInput): Promise<ActionResult> {
  const format = requestFormat(input.request);
  if (format === "other") throw new HandBackToRails("a format whose content type is not modelled");
  const follower = await findByExternalId(input.routeParams.id!);
  if (follower === null) {
    // fetch_follower answers JSON with e404_json, which is not reproduced.
    if (format === "json") throw new HandBackToRails("an unknown follow requested as JSON");
    throw new RoutingError("Not Found");
  }
  if (format === "html") throw new HandBackToRails("the cancel page, which renders after the write");

  try {
    await withOptOutLockWait(() => markDeletedBang(follower));
  } catch (error) {
    handBackFailedOptOut(error);
  }
  return json({ success: true, follower_id: encrypt(follower.get("id")) });
}

// `redirect_to @user.profile_url`, after CustomDomainConfig#set_user.
async function newFollow(input: MutationInput): Promise<ActionResult> {
  const format = requestFormat(input.request);
  if (format === "other") throw new HandBackToRails("a format whose content type is not modelled");
  const user = await profileUser(input).catch((error: unknown) => {
    // error_if_user_not_found answers JSON with e404_json.
    if (error instanceof RoutingError && format === "json")
      throw new HandBackToRails("an unknown account requested as JSON");
    throw error;
  });
  // `URI(nil)` raises in Rails.
  const profileUrl = subdomainWithProtocol(Users.load(user));
  if (profileUrl === null) throw new HandBackToRails("a seller without a subdomain");
  return { status: 302, location: profileUrl };
}

registerMutations(
  {
    method: "GET",
    pattern: "/follow/:id/cancel",
    skipForgeryProtection: true,
    run: cancel,
  },
  {
    method: "GET",
    pattern: "/:username/follow",
    skipForgeryProtection: true,
    run: newFollow,
  },
  {
    method: "DELETE",
    pattern: "/followers/:id",
    run: destroy,
  },
  {
    method: "GET",
    pattern: "/follow/:id/confirm",
    skipForgeryProtection: true,
    run: confirm,
  },
);
