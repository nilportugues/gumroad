// Ai::StoreAgentScopes: which OAuth scopes the agent's short-lived token may carry for the acting
// user. The v2 API gates endpoints by scope only and never looks at the team role, so a token
// minted with the full set would let a marketing member reach payouts, tax data or refunds.
// Role predicates are injected so the mapping stays a pure function of the role checks.

// Required on every token (the v2 base controller appends :account to each endpoint's check).
export const BASELINE_SCOPES = ["view_public", "account"] as const;

// Granted to admin or marketing.
export const CONTENT_SCOPES = ["edit_products", "view_sales", "edit_emails", "view_profile", "edit_profile"] as const;

// Granted to admin only. Marketing is denied these in the dashboard, so the agent denies them too.
export const FINANCIAL_SCOPES = [
  "view_payouts",
  "view_tax_data",
  "edit_sales",
  "refund_sales",
  "mark_sales_as_shipped",
] as const;

export const ALL_SCOPES: readonly string[] = [...BASELINE_SCOPES, ...CONTENT_SCOPES, ...FINANCIAL_SCOPES];

export type StoreAgentRoleChecks = {
  isAdmin: boolean;
  isMarketing: boolean;
};

// Fails closed: a missing acting user or seller gets no scopes at all.
export function permittedStoreAgentScopes(
  context: { hasUser: boolean; hasSeller: boolean; roles: StoreAgentRoleChecks } | null,
): string[] {
  if (context === null || !context.hasUser || !context.hasSeller) return [];

  const scopes: string[] = [...BASELINE_SCOPES];
  if (context.roles.isAdmin || context.roles.isMarketing) scopes.push(...CONTENT_SCOPES);
  if (context.roles.isAdmin) scopes.push(...FINANCIAL_SCOPES);
  return [...new Set(scopes)];
}

// The space-delimited superset the agent OAuth app is registered with.
export const allStoreAgentScopesString = (): string => ALL_SCOPES.join(" ");
