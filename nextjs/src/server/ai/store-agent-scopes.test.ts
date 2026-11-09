import { describe, expect, it } from "vitest";

import {
  ALL_SCOPES,
  BASELINE_SCOPES,
  CONTENT_SCOPES,
  FINANCIAL_SCOPES,
  allStoreAgentScopesString,
  permittedStoreAgentScopes,
} from "./store-agent-scopes.ts";

const acting = (roles: { isAdmin?: boolean; isMarketing?: boolean }) => ({
  hasUser: true,
  hasSeller: true,
  roles: { isAdmin: roles.isAdmin ?? false, isMarketing: roles.isMarketing ?? false },
});

describe("permittedStoreAgentScopes", () => {
  it("gives the owner and an admin the full scope set", () => {
    expect(permittedStoreAgentScopes(acting({ isAdmin: true }))).toEqual(expect.arrayContaining([...ALL_SCOPES]));
    expect(permittedStoreAgentScopes(acting({ isAdmin: true }))).toHaveLength(ALL_SCOPES.length);
  });

  it("gives a marketing member content scopes but not financial or sensitive ones", () => {
    const result = permittedStoreAgentScopes(acting({ isMarketing: true }));

    expect(result).toEqual(expect.arrayContaining([...BASELINE_SCOPES, ...CONTENT_SCOPES]));
    for (const scope of ["view_payouts", "view_tax_data", "refund_sales", "edit_sales", "mark_sales_as_shipped"]) {
      expect(result).not.toContain(scope);
    }
    expect(FINANCIAL_SCOPES).toContain("refund_sales");
  });

  it("gives a member with no admin or marketing role only the baseline scopes", () => {
    expect(permittedStoreAgentScopes(acting({}))).toEqual([...BASELINE_SCOPES]);
  });

  it("fails closed when there is no acting user or seller", () => {
    expect(permittedStoreAgentScopes(null)).toEqual([]);
    expect(
      permittedStoreAgentScopes({ hasUser: false, hasSeller: false, roles: { isAdmin: true, isMarketing: true } }),
    ).toEqual([]);
    expect(
      permittedStoreAgentScopes({ hasUser: true, hasSeller: false, roles: { isAdmin: true, isMarketing: true } }),
    ).toEqual([]);
  });
});

describe("allStoreAgentScopesString", () => {
  it("is the space-delimited superset the agent OAuth app registers with", () => {
    expect(allStoreAgentScopesString().split(" ")).toEqual(expect.arrayContaining([...ALL_SCOPES]));
    expect(allStoreAgentScopesString().split(" ")).toHaveLength(ALL_SCOPES.length);
  });
});
