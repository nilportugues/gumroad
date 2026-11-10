// Settings::DismissAiProductGenerationPromosController#create and Settings::Team::MembersController#update, #destroy and #restore
// (app/controllers/settings/). All are Sellers::BaseController JSON actions, so a request that does not ask for JSON goes to Rails.
//
// Handed to Rails before the first write: a membership change that fails validation (Rails raises RecordInvalid, a 500), a missing
// `team_membership` hash or a scalar role that is not a string (an array or hash role is dropped by `permit`), and the removal of a member of the Gumroad account, whose user update
// runs the whole User save.
import { decrypt } from "../../lib/obfuscate-ids.ts";

import { RecordInvalid } from "../models/runtime/errors.ts";
import type { TeamMembership } from "@prisma/client";

import type { ModelRecord } from "../models/runtime/record.ts";
import { sellerMembershipById, TeamMembershipDeletable, TeamMemberships } from "../models/team-membership.ts";
import { findUserBang, setFlag, Users } from "../models/user.ts";
import { eligibleForAiProductGeneration } from "../page-props/seller-products/new-page.ts";
import { notAllowedMessage } from "../page-props/settings/guard.ts";
import { NotAuthorizedError, type SellerContext } from "../policies/seller-context.ts";
import { settingsTeamMembershipPolicy } from "../policies/settings/team-membership.ts";
import { userPolicy } from "../policies/user.ts";
import { HandBackToRails, type ActionResult } from "./application-controller.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";
import { jsonResponse, sellerJsonAction } from "./json-seller.ts";

const NOT_FOUND = 404;
const UNAUTHORIZED = 401;
// ApplicationMailer::ADMIN_EMAIL is `hi@<DEFAULT_EMAIL_DOMAIN>`, and the domain is not configured in Node: any `hi@` account is
// treated as the Gumroad account.
const GUMROAD_ACCOUNT_EMAIL_PREFIX = "hi@";
// The constraint Rails' default `:id` segment gives an external id, and the `.json` the team routes require (`format: :json`).
const MEMBER = "/settings/team/members/:id([A-Za-z0-9_=-]+).json";

const isHash = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

// `authorize current_seller, :generate_product_details_with_ai?`. The email gate and the 401 are the Sellers::BaseController's.
function dismissAiPromo(input: MutationInput): Promise<ActionResult> {
  return sellerJsonAction(input, () => true, async (sellerContext) => {
    const seller = input.context.currentSeller!;
    if (!userPolicy.generateProductDetailsWithAi(sellerContext, await eligibleForAiProductGeneration(seller))) {
      return { ...jsonResponse({ success: false, error: notAllowedMessage(sellerContext) }, UNAUTHORIZED), rescued: true };
    }
    const record = await findUserBang(seller.id);
    setFlag(record, "dismissed_create_products_with_ai_promo_alert", true);
    await Users.saveBang(record);
    // `head :ok` answers the request format's bare content type.
    return { status: 200, body: "", contentType: "application/json", paramsRead: true };
  });
}

type Membership = ModelRecord<TeamMembership>;

// `set_team_membership` (`current_seller.seller_memberships.find_by_external_id(params[:id]) || e404_json`), then the action's `authorize`.
function memberAction(input: MutationInput, query: (context: SellerContext, membership: TeamMembership) => boolean, run: (membership: Membership) => Promise<ActionResult>): Promise<ActionResult> {
  return sellerJsonAction(input, () => true, async (sellerContext) => {
    const id = decrypt(input.routeParams.id!);
    const membership = id === null ? null : await sellerMembershipById(input.context.currentSeller!.id, id);
    // set_team_membership has read params by now.
    if (membership === null) return { ...jsonResponse({ success: false, error: "Not found" }, NOT_FOUND, true), rescued: true };
    try {
      if (!query(sellerContext, membership.attributes)) throw new NotAuthorizedError();
    } catch (error) {
      if (!(error instanceof NotAuthorizedError)) throw error;
      return { ...jsonResponse({ success: false, error: notAllowedMessage(sellerContext) }, UNAUTHORIZED, true), rescued: true };
    }
    try {
      return await run(membership);
    } catch (error) {
      if (error instanceof RecordInvalid) throw new HandBackToRails(`an invalid team membership: ${error.message}`);
      throw error;
    }
  });
}

// `params.require(:team_membership).permit(:role)`
export function permittedRole(params: Record<string, unknown>): { role?: string } {
  const value = params.team_membership;
  if (!isHash(value) || Object.keys(value).length === 0) throw new HandBackToRails("a request without a team_membership hash");
  if (!("role" in value)) return {};
  // `permit` drops an array or hash under a scalar key, so `update!({})` changes nothing.
  if (Array.isArray(value.role) || isHash(value.role)) return {};
  // A number, boolean or nil casts to a string outside ROLES: the inclusion validation raises RecordInvalid, which hands back.
  if (typeof value.role !== "string") throw new HandBackToRails("a role that is not a string");
  return { role: value.role };
}

const success = () => jsonResponse({ success: true }, 200, true);

const updateMember = (input: MutationInput) =>
  memberAction(input, settingsTeamMembershipPolicy.update, async (membership) => {
    await TeamMemberships.updateBang(membership, permittedRole(input.params));
    return success();
  });

const destroyMember = (input: MutationInput) =>
  memberAction(input, settingsTeamMembershipPolicy.destroy, async (membership) => {
    // `@team_membership.user.update!(is_team_member: false) if @team_membership.seller.gumroad_account?`
    if (String(input.context.currentSeller!.email ?? "").startsWith(GUMROAD_ACCOUNT_EMAIL_PREFIX)) throw new HandBackToRails("removing a member of the Gumroad account");
    await TeamMembershipDeletable.markDeletedBang(membership);
    return success();
  });

const restoreMember = (input: MutationInput) =>
  memberAction(input, settingsTeamMembershipPolicy.restore, async (membership) => {
    await TeamMembershipDeletable.markUndeletedBang(membership);
    return success();
  });

registerMutations(
  { method: "POST", pattern: "/settings/dismiss_ai_product_generation_promo", formats: ["json"], run: dismissAiPromo },
  { method: "PUT", pattern: MEMBER, formats: ["json"], run: updateMember },
  { method: "PATCH", pattern: MEMBER, formats: ["json"], run: updateMember },
  { method: "DELETE", pattern: MEMBER, formats: ["json"], run: destroyMember },
  { method: "PUT", pattern: "/settings/team/members/:id/restore.json", formats: ["json"], run: restoreMember },
);
