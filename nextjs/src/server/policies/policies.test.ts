// Mirrors spec/policies/{balance,installment,settings/password/user,settings/team/team_membership}_policy_spec.rb
// and the dashboard policy's role matrix.
import type { TeamMembership, User } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { authorize } from "./authorize.ts";
import { balancePolicy } from "./balance.ts";
import { dashboardPolicy } from "./dashboard.ts";
import { installmentPolicy } from "./installment.ts";
import { pagePolicy } from "./page.ts";
import { MembershipNotFoundError, NotAuthorizedError, type SellerContext } from "./seller-context.ts";
import { settingsPasswordUserPolicy } from "./settings/password-user.ts";
import { settingsTeamMembershipPolicy } from "./settings/team-membership.ts";

let nextId = 1n;
const now = new Date();
const makeUser = () => ({ id: nextId++ }) as User;
const membership = (user: User, seller: User, role: string): TeamMembership => ({
  id: nextId++,
  user_id: user.id,
  seller_id: seller.id,
  role,
  deleted_at: null,
  last_accessed_at: null,
  created_at: now,
  updated_at: now,
});

const seller = makeUser();
const ROLES = ["accountant", "admin", "marketing", "support"] as const;
type Role = "owner" | (typeof ROLES)[number];
const members = Object.fromEntries(ROLES.map((role) => [role, makeUser()])) as Record<(typeof ROLES)[number], User>;
const memberships = Object.fromEntries(ROLES.map((role) => [role, membership(members[role], seller, role)])) as Record<(typeof ROLES)[number], TeamMembership>;

function contextFor(role: Role): SellerContext {
  if (role === "owner") return { user: seller, seller, memberships: [] };
  return { user: members[role], seller, memberships: [memberships[role]] };
}

// Expected verdict per role, in the order owner, accountant, admin, marketing, support.
function expectMatrix(query: (context: SellerContext) => boolean, allowed: Role[]) {
  for (const role of ["owner", ...ROLES] as Role[]) {
    expect([role, query(contextFor(role))]).toEqual([role, allowed.includes(role)]);
  }
}

describe("BalancePolicy", () => {
  it.each([["index", balancePolicy.index], ["export", balancePolicy.export]] as const)("%s? grants owner, accountant, admin and support", (_name, query) => {
    expectMatrix(query, ["owner", "accountant", "admin", "support"]);
  });
});

describe("DashboardPolicy", () => {
  it("index? and its aliases grant every role", () => {
    for (const query of Object.values(dashboardPolicy)) expectMatrix(query, ["owner", ...ROLES]);
  });
});

describe("PagePolicy (spec/policies has none; mirrors app/policies/page_policy.rb)", () => {
  it("index?, edit?, preview? and products? grant every role", () => {
    for (const query of [pagePolicy.index, pagePolicy.edit, pagePolicy.preview, pagePolicy.products]) expectMatrix(query, ["owner", ...ROLES]);
  });

  it("new?, create?, update? and destroy? grant owner, admin and marketing", () => {
    for (const query of [pagePolicy.new, pagePolicy.create, pagePolicy.update, pagePolicy.destroy]) expectMatrix(query, ["owner", "admin", "marketing"]);
  });
});

describe("InstallmentPolicy", () => {
  it("index? and preview? grant every role", () => {
    expectMatrix(installmentPolicy.index, ["owner", ...ROLES]);
    expectMatrix(installmentPolicy.preview, ["owner", ...ROLES]);
  });

  it("writes are for owner, admin and marketing", () => {
    for (const query of [installmentPolicy.new, installmentPolicy.edit, installmentPolicy.create, installmentPolicy.update, installmentPolicy.destroy, installmentPolicy.publish, installmentPolicy.schedule, installmentPolicy.delete, installmentPolicy.redirectFromPurchaseId, installmentPolicy.updatedRecipientCount]) {
      expectMatrix(query, ["owner", "admin", "marketing"]);
    }
  });

  it("send_for_purchase? also grants support", () => {
    expectMatrix(installmentPolicy.sendForPurchase, ["owner", "admin", "marketing", "support"]);
  });
});

describe("Settings::Password::UserPolicy", () => {
  it("show? and update? are for the owner only", () => {
    expectMatrix(settingsPasswordUserPolicy.show, ["owner"]);
    expectMatrix(settingsPasswordUserPolicy.update, ["owner"]);
  });
});

describe("Settings::Team::TeamMembershipPolicy", () => {
  const other = makeUser();
  const otherMembership = membership(other, seller, "marketing");

  it("update?, destroy? and restore? grant owner and admin over another member", () => {
    for (const query of [settingsTeamMembershipPolicy.update, settingsTeamMembershipPolicy.destroy, settingsTeamMembershipPolicy.restore]) {
      expectMatrix((context) => query(context, otherMembership), ["owner", "admin"]);
    }
  });

  it("destroy? lets members leave the team themselves", () => {
    expect(settingsTeamMembershipPolicy.destroy({ user: other, seller, memberships: [otherMembership] }, otherMembership)).toBe(true);
    expect(settingsTeamMembershipPolicy.update({ user: other, seller, memberships: [otherMembership] }, otherMembership)).toBe(false);
  });
});

describe("ApplicationPolicy behaviour", () => {
  it("raises for guests, as policies without allow_anonymous_user_access! do", () => {
    expect(() => balancePolicy.index({ user: null, seller: null, memberships: [] })).toThrow(NotAuthorizedError);
  });

  it("raises RecordNotFound when the user has no membership for the seller", () => {
    expect(() => balancePolicy.index({ user: makeUser(), seller, memberships: [] })).toThrow(MembershipNotFoundError);
  });

  it("authorize raises NotAuthorizedError on a denied query and passes an allowed one", () => {
    expect(() => authorize(settingsPasswordUserPolicy.show, contextFor("admin"))).toThrow(NotAuthorizedError);
    expect(() => authorize(settingsPasswordUserPolicy.show, contextFor("owner"))).not.toThrow();
  });
});
