// Mirrors spec/policies/{purchase,wishlist,product_review}_policy_spec.rb: the account owner only.
import type { TeamMembership, User } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { productReviewPolicy, purchasePolicy, wishlistPolicy } from "./buyer.ts";
import { NotAuthorizedError, type SellerContext } from "./seller-context.ts";

const seller = { id: 1n } as User;
const member = { id: 2n } as User;
const membership = (role: string) => ({ id: 1n, user_id: member.id, seller_id: seller.id, role, deleted_at: null }) as TeamMembership;

const owner: SellerContext = { user: seller, seller, memberships: [] };
const teamMember = (role: string): SellerContext => ({ user: member, seller, memberships: [membership(role)] });

describe("PurchasePolicy, WishlistPolicy and ProductReviewPolicy", () => {
  it("index? grants the owner and no team member", () => {
    for (const query of [purchasePolicy.index, purchasePolicy.archive, purchasePolicy.unarchive, purchasePolicy.delete, wishlistPolicy.index, wishlistPolicy.create, productReviewPolicy.index]) {
      expect(query(owner)).toBe(true);
      for (const role of ["accountant", "admin", "marketing", "support"]) expect(query(teamMember(role))).toBe(false);
    }
  });

  it("update? and destroy? of a wishlist also need it to be the owner's own", () => {
    expect(wishlistPolicy.update(owner, { user_id: seller.id })).toBe(true);
    expect(wishlistPolicy.update(owner, { user_id: member.id })).toBe(false);
    expect(wishlistPolicy.destroy(owner, { user_id: seller.id })).toBe(true);
    expect(wishlistPolicy.destroy(teamMember("admin"), { user_id: seller.id })).toBe(false);
  });

  it("raises for guests", () => {
    expect(() => purchasePolicy.index({ user: null, seller: null, memberships: [] })).toThrow(NotAuthorizedError);
  });
});
