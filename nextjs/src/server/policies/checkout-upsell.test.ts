// Mirrors the pause? and unpause? examples of spec/policies/checkout/upsell_policy_spec.rb.
import type { TeamMembership, User } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { checkoutUpsellPolicy } from "./checkout-upsell.ts";
import type { SellerContext } from "./seller-context.ts";

const now = new Date();
const seller = { id: 1n } as User;
const otherSeller = { id: 2n } as User;
const teamMember = { id: 3n } as User;
const membership = (role: string): TeamMembership => ({
  id: 4n,
  user_id: teamMember.id,
  seller_id: seller.id,
  role,
  deleted_at: null,
  last_accessed_at: null,
  created_at: now,
  updated_at: now,
});
const contextFor = (role: string): SellerContext =>
  role === "owner"
    ? { user: seller, seller, memberships: [] }
    : { user: teamMember, seller, memberships: [membership(role)] };

describe("Checkout::UpsellPolicy pause and unpause", () => {
  it.each([
    ["owner", true],
    ["admin", true],
    ["marketing", true],
    ["support", false],
    ["accountant", false],
  ])("answers %s: %s", (role, allowed) => {
    const record = { seller_id: seller.id };
    expect(checkoutUpsellPolicy.pause(contextFor(role), record)).toBe(allowed);
    expect(checkoutUpsellPolicy.unpause(contextFor(role), record)).toBe(allowed);
  });

  it("refuses an upsell of another seller", () => {
    expect(checkoutUpsellPolicy.pause(contextFor("owner"), { seller_id: otherSeller.id })).toBe(false);
    expect(checkoutUpsellPolicy.unpause(contextFor("owner"), { seller_id: otherSeller.id })).toBe(false);
  });
});
