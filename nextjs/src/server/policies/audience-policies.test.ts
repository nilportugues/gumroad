// Mirrors spec/policies/{workflow,utm_link}_policy_spec.rb and spec/policies/audience/follower_policy_spec.rb.
import type { TeamMembership, User } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { audienceFollowerPolicy } from "./audience-follower.ts";
import { analyticsPolicy, audiencePolicy, audiencePurchasePolicy, churnPolicy } from "./seller-analytics.ts";
import type { SellerContext } from "./seller-context.ts";
import { utmLinkPolicy } from "./utm-link.ts";
import { workflowPolicy } from "./workflow.ts";

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

function expectMatrix(query: (context: SellerContext) => boolean, allowed: Role[]) {
  for (const role of ["owner", ...ROLES] as Role[]) {
    expect([role, query(contextFor(role))]).toEqual([role, allowed.includes(role)]);
  }
}

describe("WorkflowPolicy", () => {
  it("index? grants every role", () => {
    expectMatrix(workflowPolicy.index, ["owner", ...ROLES]);
  });

  it("everything else is for owner, admin and marketing", () => {
    const { index: _index, ...writes } = workflowPolicy;
    for (const query of Object.values(writes)) expectMatrix(query, ["owner", "admin", "marketing"]);
  });
});

describe("UtmLinkPolicy", () => {
  it("index? grants every role", () => {
    expectMatrix(utmLinkPolicy.index, ["owner", ...ROLES]);
  });

  it("writes are for owner, admin and marketing", () => {
    const { index: _index, ...writes } = utmLinkPolicy;
    for (const query of Object.values(writes)) expectMatrix(query, ["owner", "admin", "marketing"]);
  });
});

describe("Audience::FollowerPolicy", () => {
  it("index? grants every role", () => {
    expectMatrix(audienceFollowerPolicy.index, ["owner", ...ROLES]);
  });

  it("update? and destroy? are for owner, admin and support", () => {
    expectMatrix(audienceFollowerPolicy.update, ["owner", "admin", "support"]);
    expectMatrix(audienceFollowerPolicy.destroy, ["owner", "admin", "support"]);
  });
});

describe("AnalyticsPolicy, AudiencePolicy, ChurnPolicy and Audience::PurchasePolicy", () => {
  it("grant every role", () => {
    for (const query of [analyticsPolicy.index, audiencePolicy.index, audiencePolicy.export, churnPolicy.show, audiencePurchasePolicy.index]) {
      expectMatrix(query, ["owner", ...ROLES]);
    }
  });
});
