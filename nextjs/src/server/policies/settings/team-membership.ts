// app/policies/settings/team/team_membership_policy.rb: a record-aware policy.
import type { TeamMembership } from "@prisma/client";

import { requireUser, roleAdminFor, type SellerContext } from "../seller-context.ts";

function update(context: SellerContext, _membership?: TeamMembership): boolean {
  return roleAdminFor(requireUser(context));
}

// Members may always leave a team; Ruby's `||` runs update? first, so its errors surface first too.
function destroy(context: SellerContext, membership: TeamMembership): boolean {
  return update(context, membership) || membership.user_id === requireUser(context).user.id;
}

export const settingsTeamMembershipPolicy = { update, destroy, restore: destroy };
