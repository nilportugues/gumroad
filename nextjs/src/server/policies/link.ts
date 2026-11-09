// app/policies/link_policy.rb (the verdicts the products pages read), Products::Archived::LinkPolicy,
// ProductDuplicates::LinkPolicy, Products::AffiliatedPolicy, Products::CollabsPolicy and PiracyReportPolicy#tab?.
import { Prisma } from "@prisma/client";

import { UserFlags } from "../models/user.ts";
import { column, selectRows, table } from "../models/sql.ts";
import { requireUser, roleAccountantFor, roleAdminFor, roleMarketingFor, roleSupportFor, type SellerContext } from "./seller-context.ts";

const readOnly = (context: SellerContext) => {
  const c = requireUser(context);
  return roleAccountantFor(c) || roleAdminFor(c) || roleMarketingFor(c) || roleSupportFor(c);
};
const writer = (context: SellerContext) => {
  const c = requireUser(context);
  return roleAdminFor(c) || roleMarketingFor(c);
};

// `authorize Link, :index?`
const index = readOnly;
// `authorize Link, :new?` (create?, destroy?, show?, publish? and unpublish? are aliases)
const create = writer;

type ProductRecord = { id: bigint | number; user_id: bigint | number | null; flags: bigint | number };

// User#collaborator_for?, for the products given: those the user collaborates on through an accepted,
// alive collaboration (`accepted_alive_collaborations` -> `products`).
export async function collaboratingProductIds(context: SellerContext, productIds: readonly (bigint | number)[]): Promise<Set<bigint>> {
  const user = requireUser(context).user;
  if (productIds.length === 0) return new Set();
  const rows = await selectRows<{ link_id: bigint }>(
    Prisma.sql`SELECT DISTINCT ${column("affiliates_links", "link_id")} AS link_id FROM ${table("affiliates")}
      INNER JOIN ${table("affiliates_links")} ON ${column("affiliates_links", "affiliate_id")} = ${column("affiliates", "id")}
      WHERE ${column("affiliates", "type")} = 'Collaborator' AND ${column("affiliates", "affiliate_user_id")} = ${user.id}
      AND ${column("affiliates", "deleted_at")} IS NULL
      AND NOT EXISTS (SELECT 1 FROM ${table("collaborator_invitations")} WHERE ${column("collaborator_invitations", "collaborator_id")} = ${column("affiliates", "id")})
      AND ${column("affiliates_links", "link_id")} IN (${Prisma.join(productIds.map((id) => BigInt(id)))})`,
  );
  return new Set(rows.map((row) => BigInt(row.link_id)));
}

// `update?`: a collaborator, else the seller's own product and an admin or marketing role.
function update(context: SellerContext, product: ProductRecord, collaborating: ReadonlySet<bigint>): boolean {
  const c = requireUser(context);
  if (collaborating.has(BigInt(product.id))) return true;
  if (product.user_id === null || BigInt(product.user_id) !== c.seller?.id) return false;
  return roleAdminFor(c) || roleMarketingFor(c);
}

// `edit?`
function edit(context: SellerContext, product: ProductRecord, collaborating: ReadonlySet<bigint>): boolean {
  const c = requireUser(context);
  if (UserFlags.isSet(c.user.flags, "is_team_member")) return true;
  return update(context, product, collaborating);
}

const ARCHIVED_FLAG = 16n; // Link flag 5

export const linkPolicy = { index, new: create, create, destroy: create, edit, update };

export const productDuplicatesLinkPolicy = { create };

export const productsArchivedLinkPolicy = {
  index,
  create: (context: SellerContext, product: ProductRecord) => create(context) && (BigInt(product.flags) & ARCHIVED_FLAG) === 0n,
  destroy: (context: SellerContext, product: ProductRecord) => create(context) && (BigInt(product.flags) & ARCHIVED_FLAG) !== 0n,
};

export const productsAffiliatedPolicy = { index: readOnly };
export const productsAffiliatedDirectAffiliatePolicy = { destroy: (context: SellerContext) => roleAdminFor(requireUser(context)) };
export const productsCollabsPolicy = { index: readOnly };

// PiracyReportPolicy#new? / #create?: the :piracy_reports flag is a Flipper feature, checked by the caller.
export async function piracyReportsTabVisible(context: SellerContext): Promise<boolean> {
  const c = requireUser(context);
  if (!roleAdminFor(c)) return false;
  const rows = await selectRows(Prisma.sql`SELECT 1 FROM ${table("piracy_reports")} WHERE ${column("piracy_reports", "seller_id")} = ${c.seller!.id} LIMIT 1`);
  return rows.length > 0;
}

// `Pundit.policy!(pundit_user, PiracyReport).new?`
export async function piracyReportsNew(context: SellerContext, featureActive: boolean): Promise<boolean> {
  return featureActive && roleAdminFor(requireUser(context));
}
export const productsVariantsLinkPolicy = { index: readOnly };
