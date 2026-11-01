// Role matrix of the settings policies in app/policies/settings (spec/policies/settings/*).
import type { TeamMembership, User } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { type SellerContext } from "./seller-context.ts";
import { settingsAdvancedUserPolicy } from "./settings/advanced-user.ts";
import { settingsAuthorizedApplicationsOauthApplicationPolicy } from "./settings/authorized-applications-oauth-application.ts";
import { settingsBillingPolicy } from "./settings/billing.ts";
import { settingsMainUserPolicy } from "./settings/main-user.ts";
import { settingsPaymentsUserPolicy } from "./settings/payments-user.ts";
import { settingsProfilePolicy } from "./settings/profile.ts";
import { settingsSocialConnectionsPolicy } from "./settings/social-connections.ts";
import { settingsTeamUserPolicy } from "./settings/team-user.ts";
import { settingsThirdPartyAnalyticsUserPolicy } from "./settings/third-party-analytics-user.ts";
import { userPolicy } from "./user.ts";

let nextId = 1n;
const now = new Date();
const makeUser = (overrides: Partial<User> = {}) => ({ id: nextId++, user_risk_state: "compliant", deleted_at: null, ...overrides }) as User;
const seller = makeUser();
const ROLES = ["accountant", "admin", "marketing", "support"] as const;
type Role = "owner" | (typeof ROLES)[number];
const members = Object.fromEntries(ROLES.map((role) => [role, makeUser()])) as Record<(typeof ROLES)[number], User>;
const memberships = Object.fromEntries(
  ROLES.map((role) => [role, { id: nextId++, user_id: members[role].id, seller_id: seller.id, role, deleted_at: null, last_accessed_at: null, created_at: now, updated_at: now } as TeamMembership]),
) as Record<(typeof ROLES)[number], TeamMembership>;

function contextFor(role: Role): SellerContext {
  if (role === "owner") return { user: seller, seller, memberships: [] };
  return { user: members[role], seller, memberships: [memberships[role]] };
}

function expectMatrix(query: (context: SellerContext) => boolean, allowed: Role[]) {
  for (const role of ["owner", ...ROLES] as Role[]) {
    expect([role, query(contextFor(role))]).toEqual([role, allowed.includes(role)]);
  }
}

describe("settings policies", () => {
  it("main: admins read, only the owner updates", () => {
    expectMatrix(settingsMainUserPolicy.show, ["owner", "admin"]);
    for (const query of [settingsMainUserPolicy.update, settingsMainUserPolicy.invalidateActiveSessions, settingsMainUserPolicy.updateUsername]) expectMatrix(query, ["owner"]);
  });

  it("payments: admins read, admins update their own seller only", () => {
    expectMatrix((context) => settingsPaymentsUserPolicy.show(context, seller), ["owner", "admin"]);
    expectMatrix((context) => settingsPaymentsUserPolicy.update(context, seller), ["owner", "admin"]);
    expect(settingsPaymentsUserPolicy.update(contextFor("admin"), makeUser())).toBe(false);
    expectMatrix((context) => settingsPaymentsUserPolicy.verifyDocument(context, seller), ["owner"]);
  });

  it("billing, social connections: owner only", () => {
    expectMatrix(settingsBillingPolicy.show, ["owner"]);
    expectMatrix(settingsSocialConnectionsPolicy.show, ["owner"]);
  });

  it("third party analytics, advanced, authorized applications: owner and admin", () => {
    expectMatrix(settingsThirdPartyAnalyticsUserPolicy.show, ["owner", "admin"]);
    expectMatrix(settingsAdvancedUserPolicy.show, ["owner", "admin"]);
    expectMatrix(settingsAuthorizedApplicationsOauthApplicationPolicy.index, ["owner", "admin"]);
  });

  it("team and profile: every role reads, profile updates for admin and marketing", () => {
    expectMatrix(settingsTeamUserPolicy.show, ["owner", ...ROLES]);
    expectMatrix(settingsProfilePolicy.show, ["owner", ...ROLES]);
    expectMatrix(settingsProfilePolicy.update, ["owner", "admin", "marketing"]);
    expectMatrix(settingsProfilePolicy.manageSocialConnections, ["owner"]);
  });

  it("deactivate: owner only", () => {
    expectMatrix(userPolicy.deactivate, ["owner"]);
  });
});
