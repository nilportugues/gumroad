// Port of SellerContext, ApplicationPolicy's login check and the role predicates in
// app/models/concerns/user/team.rb, which every policy is built from.
import type { TeamMembership, User } from "@prisma/client";

import type { RequestContext } from "../auth/context.ts";
import { railsLoggedInUser } from "../auth/resolve.ts";
import { prismaAuthStore, type AuthStore } from "../auth/store.ts";

export const TEAM_ROLES = ["owner", "accountant", "admin", "marketing", "support"] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];

// `pundit_user`: Rails' logged_in_user (the impersonated user while impersonating) acting on
// current_seller. `memberships` is that user's switchable memberships, loaded once per request as
// User#user_memberships_not_deleted_and_ordered does.
export type SellerContext = {
  user: User | null;
  seller: User | null;
  memberships: TeamMembership[];
};

export async function loadSellerContext(context: RequestContext, store: Pick<AuthStore, "switchableMemberships"> = prismaAuthStore): Promise<SellerContext> {
  const user = railsLoggedInUser(context);
  return { user, seller: context.currentSeller, memberships: user ? await store.switchableMemberships(user.id) : [] };
}

// Pundit::NotAuthorizedError. Controllers turn it into the same redirect or 401 JSON Rails sends.
export class NotAuthorizedError extends Error {
  constructor(message = "not allowed") {
    super(message);
    this.name = "NotAuthorizedError";
  }
}

// ActiveRecord::RecordNotFound from find_user_membership_for_seller!. Rails lets it surface as a
// 404; verify_current_seller normally makes it unreachable.
export class MembershipNotFoundError extends Error {
  constructor() {
    super("Team membership not found");
    this.name = "MembershipNotFoundError";
  }
}

export type AuthorizedSellerContext = SellerContext & { user: User };

// ApplicationPolicy#initialize: policies without allow_anonymous_user_access! raise for guests.
export function requireUser(context: SellerContext): AuthorizedSellerContext {
  if (!context.user) throw new NotAuthorizedError("must be logged in");
  return context as AuthorizedSellerContext;
}

export function roleOwnerFor(context: AuthorizedSellerContext, seller: User | null = context.seller): boolean {
  return seller !== null && seller.id === context.user.id;
}

export function findUserMembershipForSeller(context: SellerContext, seller: User): TeamMembership {
  const membership = context.memberships.find((m) => m.seller_id === seller.id);
  if (!membership) throw new MembershipNotFoundError();
  return membership;
}

function hasRole(role: Exclude<TeamRole, "owner">) {
  return (context: AuthorizedSellerContext, seller: User | null = context.seller): boolean => {
    if (roleOwnerFor(context, seller)) return true;
    if (!seller) throw new MembershipNotFoundError();
    return findUserMembershipForSeller(context, seller).role === role;
  };
}

export const roleAccountantFor = hasRole("accountant");
export const roleAdminFor = hasRole("admin");
export const roleMarketingFor = hasRole("marketing");
export const roleSupportFor = hasRole("support");

