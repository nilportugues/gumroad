import type { TeamMembership, User } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { MembershipNotFoundError, type SellerContext } from "../../policies/seller-context.ts";

vi.mock("./reads.ts", () => ({
  hasAccessibleCommunities: vi.fn(async () => false),
  hasCompletedPayment: vi.fn(async () => false),
  madeSaleWithConnectOrPaypalAccount: vi.fn(async () => false),
}));
vi.mock("../../search/purchase-sales.ts", () => ({
  MIN_SALES_CENTS_VALUE_FOR_STORE_AGENT: 10_000,
  salesCentsTotal: vi.fn(async () => 0),
}));

const { eligibleForStoreAgent, policiesProps } = await import("./policy-props.ts");
const reads = await import("./reads.ts");
const sales = await import("../../search/purchase-sales.ts");

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
    const props = await policiesProps(owner);
    expect(Object.keys(props)).toHaveLength(19);
    for (const [group, verdicts] of Object.entries(props)) {
      for (const [query, verdict] of Object.entries(verdicts)) {
        // Communities need chat-enabled products.
        const expected = group !== "community";
        expect([group, query, verdict]).toEqual([group, query, expected]);
      }
    }
  });

  it("limits a support member to what support can do", async () => {
    const props = await policiesProps(contextFor("support"));
    expect(props.product).toEqual({ create: false });
    expect(props.balance).toEqual({ index: true, export: true });
    expect(props.product_review_response).toEqual({ update: true });
    expect(props.utm_link).toEqual({ index: true });
    expect(props.settings_payments_user).toEqual({ show: false });
    expect(props.settings_main_user).toEqual({ update_username: false });
    expect(props.collaborator).toEqual({ create: false, update: false });
    expect(props).not.toHaveProperty("user");
  });

  it("lets marketing manage promotions but not payments", async () => {
    const props = await policiesProps(contextFor("marketing"));
    expect(props.direct_affiliate).toEqual({ create: true, update: true });
    expect(props.workflow).toEqual({ create: true });
    expect(props.balance).toEqual({ index: false, export: false });
  });

  it("raises for a seller the user has no membership on, as ActiveRecord does", async () => {
    await expect(policiesProps({ user: member, seller, memberships: [] })).rejects.toBeInstanceOf(MembershipNotFoundError);
  });

  it("reads the store agent's eligibility only for a confirmed, unsuspended seller with payouts and enough sales", async () => {
    expect(await eligibleForStoreAgent(seller, true)).toBe(true);
    expect(await eligibleForStoreAgent(user(1n, { confirmed_at: null }), false)).toBe(false);
    expect(await eligibleForStoreAgent(seller, false)).toBe(false);
    expect(sales.salesCentsTotal).not.toHaveBeenCalled();

    vi.mocked(reads.hasCompletedPayment).mockResolvedValue(true);
    vi.mocked(sales.salesCentsTotal).mockResolvedValueOnce(9_999);
    expect(await eligibleForStoreAgent(seller, false)).toBe(false);
    vi.mocked(sales.salesCentsTotal).mockResolvedValueOnce(10_000);
    expect(await eligibleForStoreAgent(seller, false)).toBe(true);
    vi.mocked(reads.hasCompletedPayment).mockResolvedValue(false);

    vi.mocked(reads.madeSaleWithConnectOrPaypalAccount).mockResolvedValueOnce(true);
    vi.mocked(sales.salesCentsTotal).mockResolvedValueOnce(20_000);
    expect(await eligibleForStoreAgent(seller, false)).toBe(true);
  });
});
