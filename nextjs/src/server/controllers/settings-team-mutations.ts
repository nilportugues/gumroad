// Settings::DismissAiProductGenerationPromosController#create and Settings::Team::MembersController#index, #update, #destroy and
// #restore (app/controllers/settings/). All are Sellers::BaseController JSON actions, so a request that does not ask for JSON goes to Rails.
//
// A membership change that fails validation raises RecordInvalid, which processAction answers with Rails' 422 page.
//
// Handed to Rails before the first write: a missing `team_membership` hash and the removal of a member of the Gumroad account who is
// flagged `is_team_member`, whose user update writes the flag through the whole User save. A member who is not flagged makes that
// update a no-op, so the removal runs here.
import type { TeamMembership } from "@prisma/client";

import { decrypt } from "../../lib/obfuscate-ids.ts";
import type { ModelRecord } from "../models/runtime/record.ts";
import { sellerMembershipById, TeamMembershipDeletable, TeamMemberships } from "../models/team-membership.ts";
import { findUser, findUserBang, isFlagSet, setFlag, Users } from "../models/user.ts";
import { eligibleForAiProductGeneration } from "../page-props/seller-products/new-page.ts";
import { notAllowedMessage } from "../page-props/settings/guard.ts";
import { teamMemberInfos } from "../page-props/settings/presenter.ts";
import { NotAuthorizedError, type SellerContext } from "../policies/seller-context.ts";
import { settingsTeamMembershipPolicy } from "../policies/settings/team-membership.ts";
import { settingsTeamUserPolicy } from "../policies/settings/team-user.ts";
import { userPolicy } from "../policies/user.ts";

import { HandBackToRails, type ActionResult } from "./application-controller.ts";
import { jsonResponse, sellerJsonAction } from "./json-seller.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";

const NOT_FOUND = 404;
const UNAUTHORIZED = 401;
// ApplicationMailer::ADMIN_EMAIL is `hi@<DEFAULT_EMAIL_DOMAIN>`, and the domain is not configured in Node: any `hi@` account is
// treated as the Gumroad account.
const GUMROAD_ACCOUNT_EMAIL_PREFIX = "hi@";
// The constraint Rails' default `:id` segment gives an external id, and the `.json` the team routes require (`format: :json`).
const MEMBER = "/settings/team/members/:id([A-Za-z0-9_=-]+).json";

const isHash = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

// `authorize current_seller, :generate_product_details_with_ai?`. The email gate and the 401 are the Sellers::BaseController's.
function dismissAiPromo(input: MutationInput): Promise<ActionResult> {
  return sellerJsonAction(
    input,
    () => true,
    async (sellerContext) => {
      const seller = input.context.currentSeller!;
      if (!userPolicy.generateProductDetailsWithAi(sellerContext, await eligibleForAiProductGeneration(seller))) {
        return {
          ...jsonResponse({ success: false, error: notAllowedMessage(sellerContext) }, UNAUTHORIZED),
          rescued: true,
        };
      }
      const record = await findUserBang(seller.id);
      setFlag(record, "dismissed_create_products_with_ai_promo_alert", true);
      await Users.saveBang(record);
      // `head :ok` answers the request format's bare content type.
      return { status: 200, body: "", contentType: "application/json", paramsRead: true };
    },
  );
}

type Membership = ModelRecord<TeamMembership>;

// `set_team_membership` (`current_seller.seller_memberships.find_by_external_id(params[:id]) || e404_json`), then the action's `authorize`.
function memberAction(
  input: MutationInput,
  query: (context: SellerContext, membership: TeamMembership) => boolean,
  run: (membership: Membership) => Promise<ActionResult>,
): Promise<ActionResult> {
  return sellerJsonAction(
    input,
    () => true,
    async (sellerContext) => {
      const id = decrypt(input.routeParams.id!);
      const membership = id === null ? null : await sellerMembershipById(input.context.currentSeller!.id, id);
      // set_team_membership has read params by now.
      if (membership === null)
        return { ...jsonResponse({ success: false, error: "Not found" }, NOT_FOUND, true), rescued: true };
      try {
        if (!query(sellerContext, membership.attributes)) throw new NotAuthorizedError();
      } catch (error) {
        if (!(error instanceof NotAuthorizedError)) throw error;
        return {
          ...jsonResponse({ success: false, error: notAllowedMessage(sellerContext) }, UNAUTHORIZED, true),
          rescued: true,
        };
      }
      return run(membership);
    },
  );
}

// `params.require(:team_membership).permit(:role)`
export function permittedRole(params: Record<string, unknown>): { role?: string } {
  const value = params.team_membership;
  if (!isHash(value) || Object.keys(value).length === 0)
    throw new HandBackToRails("a request without a team_membership hash");
  if (!("role" in value)) return {};
  // `permit` drops an array or hash under a scalar key, so `update!({})` changes nothing.
  if (Array.isArray(value.role) || isHash(value.role)) return {};
  // A number or boolean casts to a string outside ROLES and nil stays nil: the inclusion validation fails either way.
  if (value.role === null || typeof value.role === "string") return { role: value.role! };
  return { role: String(value.role) };
}

const success = () => jsonResponse({ success: true }, 200, true);

// `authorize [:settings, :team, current_seller], :show?`, then `Settings::TeamPresenter#member_infos`.
const indexMembers = (input: MutationInput) =>
  sellerJsonAction(input, settingsTeamUserPolicy.show, async (sellerContext) =>
    jsonResponse({ success: true, member_infos: await teamMemberInfos(sellerContext) }),
  );

const updateMember = (input: MutationInput) =>
  memberAction(input, settingsTeamMembershipPolicy.update, async (membership) => {
    await TeamMemberships.updateBang(membership, permittedRole(input.params));
    return success();
  });

const destroyMember = (input: MutationInput) =>
  memberAction(input, settingsTeamMembershipPolicy.destroy, async (membership) => {
    // `@team_membership.user.update!(is_team_member: false) if @team_membership.seller.gumroad_account?`
    if (String(input.context.currentSeller!.email ?? "").startsWith(GUMROAD_ACCOUNT_EMAIL_PREFIX)) {
      const member = await findUser(membership.get("user_id"));
      if (member === null || isFlagSet(member, "is_team_member"))
        throw new HandBackToRails("removing a team member of the Gumroad account, which clears the member's flag");
    }
    await TeamMembershipDeletable.markDeletedBang(membership);
    return success();
  });

const restoreMember = (input: MutationInput) =>
  memberAction(input, settingsTeamMembershipPolicy.restore, async (membership) => {
    await TeamMembershipDeletable.markUndeletedBang(membership);
    return success();
  });

// `skipForgeryProtection`: Rails does not verify a GET's token.
registerMutations(
  { method: "GET", pattern: "/settings/team/members.json", skipForgeryProtection: true, run: indexMembers },
  { method: "POST", pattern: "/settings/dismiss_ai_product_generation_promo", formats: ["json"], run: dismissAiPromo },
  { method: "PUT", pattern: MEMBER, formats: ["json"], run: updateMember },
  { method: "PATCH", pattern: MEMBER, formats: ["json"], run: updateMember },
  { method: "DELETE", pattern: MEMBER, formats: ["json"], run: destroyMember },
  { method: "PUT", pattern: "/settings/team/members/:id/restore.json", formats: ["json"], run: restoreMember },
);
