import type { TeamMembership, User } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { MembershipNotFoundError, type SellerContext } from "../../policies/seller-context.ts";

vi.mock("./reads.ts", () => ({
  hasAccessibleCommunities: vi.fn(async () => false),
  hasCompletedPayment: vi.fn(async () => false),
  hasConnectOrPaypalMerchantAccount: vi.fn(async () => false),
}));

const { policiesProps } = await import("./policy-props.ts");
const reads = await import("./reads.ts");

const now = new Date();
const user = (id: bigint, attributes: Partial<User> = {}) => ({ id, user_risk_state: null, confirmed_at: now, ...attributes }) as User;
const membership = (member: User, seller: User, role: string) =>
  ({ id: member.id * 100n, user_id: member.id, seller_id: seller.id, role, deleted_at: null, last_accessed_at: null, created_at: now, updated_at: now }) as TeamMembership;

const seller = user(1n);
const member = user(2n);
const contextFor = (role: string): SellerContext => ({ user: member, seller, memberships: [membership(member, seller, role)] });
const owner: SellerContext = { user: seller, seller, memberships: [] };

describe("policiesProps", () => {
  it("grants an owner everything the role checks decide", async () => {
    const props = await policiesProps(owner, false);
    expect(Object.keys(props)).toHaveLength(20);
    for (const [group, verdicts] of Object.entries(props)) {
      for (const [query, verdict] of Object.entries(verdicts)) {
        // Communities need chat-enabled products, and the store agent needs completed payouts.
        const expected = !(group === "community" || (group === "user" && query === "use_store_agent"));
        expect([group, query, verdict]).toEqual([group, query, expected]);
      }
    }
  });

  it("limits a support member to what support can do", async () => {
    const props = await policiesProps(contextFor("support"), false);
    expect(props.product).toEqual({ create: false });
    expect(props.balance).toEqual({ index: true, export: true });
    expect(props.product_review_response).toEqual({ update: true });
    expect(props.utm_link).toEqual({ index: true });
    expect(props.settings_payments_user).toEqual({ show: false });
    expect(props.settings_main_user).toEqual({ update_username: false });
    expect(props.collaborator).toEqual({ create: false, update: false });
    expect(props.user).toEqual({ view_store_agent: false, use_store_agent: false });
  });

  it("lets marketing manage promotions but not payments", async () => {
    const props = await policiesProps(contextFor("marketing"), false);
    expect(props.direct_affiliate).toEqual({ create: true, update: true });
    expect(props.workflow).toEqual({ create: true });
    expect(props.balance).toEqual({ index: false, export: false });
    expect(props.user).toEqual({ view_store_agent: true, use_store_agent: false });
  });

  it("raises for a seller the user has no membership on, as ActiveRecord does", async () => {
    await expect(policiesProps({ user: member, seller, memberships: [] }, false)).rejects.toBeInstanceOf(MembershipNotFoundError);
  });

  it("reads the store agent's eligibility only for a confirmed, unsuspended seller with payouts", async () => {
    expect((await policiesProps(owner, true)).user).toEqual({ view_store_agent: true, use_store_agent: true });
    expect((await policiesProps({ ...owner, user: user(1n, { confirmed_at: null }), seller: user(1n, { confirmed_at: null }) }, false)).user?.use_store_agent).toBe(false);
    vi.mocked(reads.hasCompletedPayment).mockResolvedValueOnce(true);
    await expect(policiesProps(owner, false)).rejects.toThrow(/not ported/);
  });
});
