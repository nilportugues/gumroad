// Settings::Team::InvitationsController (app/controllers/settings/team/invitations_controller.rb): #update, #destroy and #restore, the
// refusals that come before a send in #create and #resend_invitation, and #accept up to the point where it joins the team.
//
// Handed to Rails before the first write: everything that would send an invitation (the seller's row lock, the unreviewed cap, the
// Redis send throttle and its burst report, the save and TeamMailer.invite), the join of #accept (switch_seller_account, the
// membership and TeamMailer.invitation_accepted), and an invitation email that passes EMAIL_REGEX but is not a bare dot-atom
// mailbox, which Mail::AddressList has to parse.
import type { TeamInvitation } from "@prisma/client";

import * as Routes from "@/lib/navigation/routes";

import { decrypt } from "../../lib/obfuscate-ids.ts";
import { railsLoggedInUser } from "../auth/resolve.ts";
import type { ModelRecord } from "../models/runtime/record.ts";
import {
  invitationById,
  isAccepted,
  isDeleted,
  isExpired,
  matchesOwnerEmail,
  sellerInvitationById,
  TeamInvitationDeletable,
  TeamInvitations,
} from "../models/team-invitation.ts";
import { findUser, isAccountActive, isConfirmed, isValidEmailFormat, Users } from "../models/user.ts";
import { notAllowedMessage } from "../page-props/settings/guard.ts";
import { NotAuthorizedError, loadSellerContext, type SellerContext } from "../policies/seller-context.ts";
import { settingsTeamInvitationPolicy } from "../policies/settings/team-invitation.ts";

import { HandBackToRails, RoutingError, type ActionResult } from "./application-controller.ts";
import { jsonResponse, sellerJsonAction } from "./json-seller.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";
import { toSentence } from "./settings-mutations.ts";

const NOT_FOUND = 404;
const FORBIDDEN = 403;
const UNAUTHORIZED = 401;
const UNPROCESSABLE = 422;
const FOUND = 302;
const INACTIVE_SENDER_MESSAGE = "Your account can't send team invitations right now.";
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
function refusal(input: MutationInput, paramsRead: boolean): ActionResult | null {
  if (isAccountActive(Users.load(input.context.currentSeller!))) return null;
  return {
    ...jsonResponse({ success: false, error_message: INACTIVE_SENDER_MESSAGE }, FORBIDDEN, paramsRead),
    rescued: true,
  };
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

// An invalid email is the one refusal of #resend_invitation that precedes the throttle; a valid one sends.
const resendInvitation = (input: MutationInput) =>
  invitationAction(
    input,
    { refuseInactive: true, query: settingsTeamInvitationPolicy.resendInvitation },
    (invitation) => {
      if (!isValidEmailFormat(invitation.get("email")))
        return Promise.resolve(
          jsonResponse({ success: false, error_message: "Email is invalid" }, UNPROCESSABLE, true),
        );
      throw new HandBackToRails("resending a team invitation, which sends mail");
    },
  );

// Whatever #create does after `team_invitation.valid?` takes the seller's lock and sends, so only the validation failure is answered.
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
      } as Partial<TeamInvitation>);
      if (await TeamInvitations.valid(invitation)) throw new HandBackToRails("sending a team invitation");
      return failure(invitation);
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
  if (message === null) throw new HandBackToRails("joining the team, which sends mail");
  return { status: FOUND, location: dashboard, flash: { alert: message } };
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
