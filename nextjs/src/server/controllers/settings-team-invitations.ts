// Settings::Team::InvitationsController (app/controllers/settings/team/invitations_controller.rb): #update, #destroy and #restore, the
// refusals that come before a send in #create and #resend_invitation, and #accept up to the point where it joins the team.
//
// Handed to Rails before the first write: the join of #accept for the Gumroad account (it flags the member), and an invitation email that passes EMAIL_REGEX but is not a bare dot-atom mailbox, which
// Mail::AddressList has to parse.
import { Prisma, type TeamInvitation, type TeamMembership, type User } from "@prisma/client";

import * as Routes from "@/lib/navigation/routes";

import { decrypt } from "../../lib/obfuscate-ids.ts";
import { railsLoggedInUser } from "../auth/resolve.ts";
import { afterCommitEverywhere } from "../models/concerns/job-runtime.ts";
import type { ModelRecord } from "../models/runtime/record.ts";
import { transaction } from "../models/runtime/transaction.ts";
import { castRow, column, selectRows, table } from "../models/sql.ts";
import {
  checkSendThrottle,
  deliverInvitationAccepted,
  deliverInvite,
  invitationExpiry,
  invitationLimitMessage,
  reportInvitationBurst,
  UNREVIEWED_TOTAL_LIMIT,
  unreviewedLimitReached,
} from "../models/team-invitation-throttle.ts";
import {
  invitationById,
  isAccepted,
  isDeleted,
  isExpired,
  matchesOwnerEmail,
  sellerInvitationById,
  singleMailboxEmail,
  TeamInvitationDeletable,
  TeamInvitations,
} from "../models/team-invitation.ts";
import { TeamMemberships } from "../models/team-membership.ts";
import { findUser, isAccountActive, isConfirmed, Users, type UserRecord } from "../models/user.ts";
import { notAllowedMessage } from "../page-props/settings/guard.ts";
import { NotAuthorizedError, loadSellerContext, type SellerContext } from "../policies/seller-context.ts";
import { settingsTeamInvitationPolicy } from "../policies/settings/team-invitation.ts";

import { HandBackToRails, ParameterMissing, RoutingError, type ActionResult } from "./application-controller.ts";
import { jsonResponse, sellerJsonAction } from "./json-seller.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";
import { toSentence } from "./settings-mutations.ts";
import { switchSellerAccount } from "./switch-seller-account.ts";

const NOT_FOUND = 404;
const FORBIDDEN = 403;
const UNAUTHORIZED = 401;
const UNPROCESSABLE = 422;
const TOO_MANY_REQUESTS = 429;
const FOUND = 302;
const INACTIVE_SENDER_MESSAGE = "Your account can't send team invitations right now.";
const UNREVIEWED_LIMIT_MESSAGE = `New accounts can have up to ${UNREVIEWED_TOTAL_LIMIT} team invitations while the account is being reviewed. Please contact support if you need more.`;
const GUMROAD_ACCOUNT_EMAIL_PREFIX = "hi@";
const INVALID_LINK_MESSAGE = "Invitation link is invalid. Please contact the account owner.";
// The constraint Rails' default `:id` segment gives an external id, and the `.json` the team routes require (`format: :json`).
const INVITATION = "/settings/team/invitations/:id([A-Za-z0-9_=-]+).json";

type Invitation = ModelRecord<TeamInvitation>;

const isHash = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isBlank = (value: string | null | undefined) => value == null || value.trim() === "";

// `params.require(:team_invitation).permit(...)`. A value that is not text is handed back rather than cast.
function permittedInvitation(
  params: Record<string, unknown>,
  keys: ("email" | "role")[],
): { email?: string | null; role?: string | null } {
  const value = params.team_invitation;
  // `require` on an absent key raises ParameterMissing, a 400.
  if (!("team_invitation" in params)) throw new ParameterMissing();
  if (!isHash(value) || Object.keys(value).length === 0)
    throw new HandBackToRails("a request without a team_invitation hash");
  const permitted: { email?: string | null; role?: string | null } = {};
  for (const key of keys) {
    if (!(key in value)) continue;
    const field = value[key];
    if (field === null || typeof field === "string") permitted[key] = field;
    else if (key === "role" && (typeof field === "number" || typeof field === "boolean"))
      permitted.role = String(field);
    // `permit` drops an array or hash under a scalar key.
    else if (Array.isArray(field) || isHash(field)) continue;
    else throw new HandBackToRails("a non-string team invitation attribute");
  }
  return permitted;
}

const failure = (record: Invitation) =>
  jsonResponse({ success: false, error_message: toSentence(record.errors.fullMessages()) }, 200, true);
const success = () => jsonResponse({ success: true }, 200, true);

function authorized(
  query: (context: SellerContext) => boolean,
  context: SellerContext,
  paramsRead: boolean,
): ActionResult | null {
  try {
    if (!query(context)) throw new NotAuthorizedError();
    return null;
  } catch (error) {
    if (!(error instanceof NotAuthorizedError)) throw error;
    return {
      ...jsonResponse({ success: false, error: notAllowedMessage(context) }, UNAUTHORIZED, paramsRead),
      rescued: true,
    };
  }
}

// `refuse_inactive_sender`: suspension does not log the seller out.
const inactiveSender = (paramsRead: boolean) =>
  jsonResponse({ success: false, error_message: INACTIVE_SENDER_MESSAGE }, FORBIDDEN, paramsRead);

function refusal(input: MutationInput, paramsRead: boolean): ActionResult | null {
  if (isAccountActive(Users.load(input.context.currentSeller!))) return null;
  return { ...inactiveSender(paramsRead), rescued: true };
}

// `set_team_invitation` (`current_seller.team_invitations.find_by_external_id(params[:id]) || e404_json`).
async function findInvitation(input: MutationInput): Promise<Invitation | null> {
  const id = decrypt(input.routeParams.id!);
  return id === null ? null : sellerInvitationById(input.context.currentSeller!.id, id);
}

const notFound = (): ActionResult => ({
  ...jsonResponse({ success: false, error: "Not found" }, NOT_FOUND, true),
  rescued: true,
});

function invitationAction(
  input: MutationInput,
  { refuseInactive = false, query }: { refuseInactive?: boolean; query: (context: SellerContext) => boolean },
  run: (invitation: Invitation) => Promise<ActionResult>,
): Promise<ActionResult> {
  return sellerJsonAction(
    input,
    () => true,
    async (sellerContext) => {
      const invitation = await findInvitation(input);
      if (invitation === null) return notFound();
      const refused = (refuseInactive ? refusal(input, true) : null) ?? authorized(query, sellerContext, true);
      return refused ?? run(invitation);
    },
  );
}

const updateInvitation = (input: MutationInput) =>
  invitationAction(input, { query: settingsTeamInvitationPolicy.update }, async (invitation) => {
    const saved = await TeamInvitations.update(
      invitation,
      permittedInvitation(input.params, ["role"]) as Partial<TeamInvitation>,
    );
    return saved ? success() : failure(invitation);
  });

const destroyInvitation = (input: MutationInput) =>
  invitationAction(input, { query: settingsTeamInvitationPolicy.destroy }, async (invitation) => {
    await TeamInvitationDeletable.markDeletedBang(invitation);
    return success();
  });

const restoreInvitation = (input: MutationInput) =>
  invitationAction(input, { query: settingsTeamInvitationPolicy.restore }, async (invitation) =>
    (await TeamInvitationDeletable.markUndeleted(invitation)) ? success() : failure(invitation),
  );

// `throttle_invitation_sends`: the 429 for a restricted seller, whose burst is reported once; null once a send is reserved.
async function throttleSends(seller: UserRecord): Promise<ActionResult | null> {
  const restriction = await checkSendThrottle(seller.get("id"));
  if (restriction === null) return null;
  const refused: ActionResult = {
    ...jsonResponse(
      {
        error: invitationLimitMessage(restriction.window, restriction.limit, restriction.retry_after),
        retry_after: restriction.retry_after,
      },
      TOO_MANY_REQUESTS,
      true,
    ),
    headers: { "Retry-After": String(restriction.retry_after) },
  };
  await reportInvitationBurst(seller, restriction);
  return refused;
}

const resendInvitation = (input: MutationInput) =>
  invitationAction(
    input,
    { refuseInactive: true, query: settingsTeamInvitationPolicy.resendInvitation },
    async (invitation) => {
      // Throws NotPortedError for a mailbox only Mail can read, handing the request back before the throttle reserves a send.
      if (!singleMailboxEmail(invitation.get("email")))
        return jsonResponse({ success: false, error_message: "Email is invalid" }, UNPROCESSABLE, true);
      const throttled = await throttleSends(Users.load(input.context.currentSeller!));
      if (throttled) return throttled;
      if (!(await TeamInvitations.update(invitation, { expires_at: invitationExpiry() }))) return failure(invitation);
      await deliverInvite(invitation.get("id"));
      return success();
    },
  );

const createInvitation = (input: MutationInput) =>
  sellerJsonAction(
    input,
    () => true,
    async (sellerContext) => {
      const refused = refusal(input, false) ?? authorized(settingsTeamInvitationPolicy.create, sellerContext, false);
      if (refused) return refused;
      const { email, role } = permittedInvitation(input.params, ["email", "role"]);
      const invitation = TeamInvitations.build({
        seller_id: input.context.currentSeller!.id,
        email: email ?? null,
        role: role ?? null,
        expires_at: invitationExpiry(),
      } as Partial<TeamInvitation>);
      if (!(await TeamInvitations.valid(invitation))) return failure(invitation);

      // The unreviewed cap counts the seller's invitations and then inserts one, so both run under the seller's row lock.
      // Suspension is read again under it because it does not roll back a request already in flight.
      const seller = Users.load(input.context.currentSeller!);
      return Users.withLock(seller, async (): Promise<ActionResult> => {
        if (!isAccountActive(seller)) return inactiveSender(true);
        if (await unreviewedLimitReached(seller)) {
          await reportInvitationBurst(seller, { window: "account", limit: UNREVIEWED_TOTAL_LIMIT });
          // Shaped like a validation failure so the settings page shows the message instead of its generic error.
          return jsonResponse({ success: false, error_message: UNREVIEWED_LIMIT_MESSAGE }, 200, true);
        }
        const throttled = await throttleSends(seller);
        if (throttled) return throttled;
        if (!(await TeamInvitations.save(invitation))) return failure(invitation);
        // ActiveJob's Sidekiq adapter enqueues once the transaction has committed.
        await afterCommitEverywhere(() => deliverInvite(invitation.get("id")));
        return success();
      });
    },
  );

async function acceptInvitation(input: MutationInput): Promise<ActionResult> {
  const user = railsLoggedInUser(input.context);
  if (!user || !input.context.currentSeller) throw new HandBackToRails("a signed-out request to accept an invitation");
  const dashboard = Routes.dashboard_url(input.urlOptions);

  const id = decrypt(input.routeParams.id!);
  const invitation = id === null ? null : await invitationById(id);
  if (invitation === null) throw new RoutingError("Not Found");

  const sellerContext = await loadSellerContext(input.context);
  if (!settingsTeamInvitationPolicy.accept(sellerContext)) {
    // `params["account_switched"]` is truthy for any value, an empty one included.
    const flash = input.url.searchParams.has("account_switched")
      ? undefined
      : { alert: notAllowedMessage(sellerContext) };
    return { status: FOUND, location: dashboard, rescued: true, ...(flash && { flash }) };
  }

  const loggedIn = Users.load(user);
  const loggedInEmail = loggedIn.get("email")?.toLowerCase();
  const seller = await findUser(invitation.get("seller_id"));
  let message: string | null = null;
  if (isBlank(loggedInEmail)) {
    message =
      "Your Gumroad account doesn't have an email associated. Please assign and verify your email before accepting the invitation.";
  } else if (!isConfirmed(loggedIn)) {
    message = "Please confirm your email address before accepting the invitation.";
  } else if (invitation.get("email") !== loggedInEmail) {
    message = `The invite was sent to a different email address. You are logged in as ${loggedInEmail}`;
  } else if (isExpired(invitation)) {
    message = "Invitation link has expired. Please contact the account owner.";
  } else if (isAccepted(invitation)) {
    message = "Invitation has already been accepted.";
  } else if (isDeleted(invitation) || seller === null || !isAccountActive(seller)) {
    message = INVALID_LINK_MESSAGE;
  } else if (matchesOwnerEmail(invitation, seller.get("email"))) {
    // The owner changed their email to the invited one, so the membership could never be created.
    await TeamInvitationDeletable.markDeletedBang(invitation);
    message = INVALID_LINK_MESSAGE;
  }
  if (message !== null) return { status: FOUND, location: dashboard, flash: { alert: message } };

  // `from_gumroad_account?` also flags the user `is_team_member`; any `hi@` seller is left to Rails, as removing one is.
  if (String(seller!.get("email") ?? "").startsWith(GUMROAD_ACCOUNT_EMAIL_PREFIX))
    throw new HandBackToRails("joining the Gumroad account's team");
  const membership = await joinTeam(invitation, loggedIn);
  if (membership === null) return { status: FOUND, location: dashboard, flash: { alert: INVALID_LINK_MESSAGE } };
  const now = new Date();
  const cookie = await switchSellerAccount(input.request.host, membership, now);
  return {
    status: FOUND,
    location: dashboard,
    flash: { notice: `Welcome to the team at ${seller!.get("username")}!` },
    cookies: [cookie],
  };
}

// The `User.transaction` block of #accept. Null when the seller was suspended before the locks were taken.
async function joinTeam(invitation: Invitation, loggedIn: UserRecord): Promise<ModelRecord<TeamMembership> | null> {
  return transaction(async () => {
    // Reciprocal invitations must acquire both user locks in the same order.
    const rows = await selectRows(
      Prisma.sql`SELECT ${Prisma.raw("`users`.*")} FROM ${table("users")} WHERE ${column("users", "id")} IN (${Prisma.join([loggedIn.get("id"), invitation.get("seller_id")])}) ORDER BY ${column("users", "id")} ASC FOR UPDATE`,
    );
    await Users.lockBang(loggedIn);
    const sellerRow = rows.find((row) => BigInt(row.id as bigint | number) === BigInt(invitation.get("seller_id")));
    const seller = sellerRow ? Users.load(castRow<User>("User", sellerRow)) : null;
    if (seller === null || !isAccountActive(seller)) return null;

    const now = new Date();
    await TeamInvitations.updateBang(invitation, { accepted_at: now, deleted_at: now }, { now: () => now });
    await createOwnerMembershipIfNeeded(loggedIn, now);
    const membership = await TeamMemberships.createBang(
      {
        seller_id: seller.get("id"),
        user_id: loggedIn.get("id"),
        role: invitation.get("role"),
      } as Partial<TeamMembership>,
      { now: () => now },
    );
    // ActiveJob's Sidekiq adapter enqueues once the transaction has committed.
    await afterCommitEverywhere(() => deliverInvitationAccepted(membership.get("id")));
    return membership;
  });
}

// `user_memberships.create!(seller: self, role: owner) unless user_memberships.one?(&:role_owner?)`
export async function createOwnerMembershipIfNeeded(user: UserRecord, now: Date): Promise<void> {
  const memberships = await selectRows<TeamMembership>(
    Prisma.sql`SELECT ${Prisma.raw("`team_memberships`.*")} FROM ${table("team_memberships")} WHERE ${column("team_memberships", "user_id")} = ${user.get("id")}`,
  );
  if (memberships.filter((row) => row.role === "owner").length === 1) return;
  await TeamMemberships.createBang(
    { seller_id: user.get("id"), user_id: user.get("id"), role: "owner" } as Partial<TeamMembership>,
    { now: () => now },
  );
}

registerMutations(
  { method: "PUT", pattern: INVITATION, formats: ["json"], run: updateInvitation },
  { method: "PATCH", pattern: INVITATION, formats: ["json"], run: updateInvitation },
  { method: "DELETE", pattern: INVITATION, formats: ["json"], run: destroyInvitation },
  { method: "PUT", pattern: "/settings/team/invitations/:id/restore.json", formats: ["json"], run: restoreInvitation },
  {
    method: "PUT",
    pattern: "/settings/team/invitations/:id/resend_invitation.json",
    formats: ["json"],
    run: resendInvitation,
  },
  { method: "POST", pattern: "/settings/team/invitations.json", formats: ["json"], run: createInvitation },
  {
    method: "GET",
    pattern: "/settings/team/invitations/:id/accept",
    skipForgeryProtection: true,
    run: acceptInvitation,
  },
);
