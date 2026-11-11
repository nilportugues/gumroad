import type { TeamMembership, User } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { NotPortedError } from "../models/user.ts";

import { commentContextPolicy, type CommentContextRecord } from "./comment-context.ts";
import type { SellerContext } from "./seller-context.ts";

const user = (id: number) => ({ id: BigInt(id) }) as User;
const membership = (sellerId: number, role: string) => ({ seller_id: BigInt(sellerId), role }) as TeamMembership;
const context = (visitor: User | null, seller: User | null, memberships: TeamMembership[] = []): SellerContext => ({
  user: visitor,
  seller,
  memberships,
});

const SELLER_ID = 7;
const record = (authorId: number | null): CommentContextRecord => ({
  comment: {
    author_id: authorId === null ? null : BigInt(authorId),
    purchase_id: null,
    commentable_seller_id: SELLER_ID,
  },
  commentable: { seller_id: SELLER_ID },
  purchase: null,
});

describe("CommentContextPolicy without a purchase", () => {
  it("lets the author update their comment and nobody else", () => {
    expect(commentContextPolicy.update(context(user(1), user(SELLER_ID)), record(1))).toBe(true);
    expect(commentContextPolicy.update(context(user(SELLER_ID), user(SELLER_ID)), record(1))).toBe(false);
    expect(commentContextPolicy.update(context(null, null), record(1))).toBe(false);
    expect(commentContextPolicy.update(context(user(1), user(SELLER_ID)), record(null))).toBe(false);
  });

  it("lets the seller, an admin and a marketing member delete any comment, and a support member only their own", () => {
    const seller = user(SELLER_ID);
    expect(commentContextPolicy.destroy(context(seller, seller), record(1))).toBe(true);
    expect(commentContextPolicy.destroy(context(user(2), seller, [membership(SELLER_ID, "admin")]), record(1))).toBe(
      true,
    );
    expect(
      commentContextPolicy.destroy(context(user(2), seller, [membership(SELLER_ID, "marketing")]), record(1)),
    ).toBe(true);
    expect(commentContextPolicy.destroy(context(user(2), seller, [membership(SELLER_ID, "support")]), record(1))).toBe(
      false,
    );
    expect(commentContextPolicy.destroy(context(user(2), seller, [membership(SELLER_ID, "support")]), record(2))).toBe(
      true,
    );
  });

  it("allows creating for the seller and refuses to judge a reader whose visibility is not ported", () => {
    const seller = user(SELLER_ID);
    expect(commentContextPolicy.create(context(seller, seller), record(null))).toBe(true);
    expect(() =>
      commentContextPolicy.create(context(user(2), seller, [membership(SELLER_ID, "support")]), record(null)),
    ).toThrow(NotPortedError);
  });
});
