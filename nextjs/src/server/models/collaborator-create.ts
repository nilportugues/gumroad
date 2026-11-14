// The save `Collaborator::CreateService#process` makes for a new Collaborator (app/services/collaborator/create_service.rb,
// app/models/collaborator.rb, product_affiliate.rb): the products' row locks, the collaborator, its product assignments (each marks
// its product as a collab), the invitation when the invited seller has not accepted the inviter as theirs, then the mail.
//
// Not ported, and refused before the first write by `creationBlocker`: a commission below 1% or, but for one product under an all-products
// collaboration, above 50%, a Brazilian Stripe Connect account
// on either side, a product that already has a collaborator, a direct or self-service affiliate (the callback disables or destroys
// them), a deleted product, the same product twice, and a product whose own save would fail.
import { Prisma, type Affiliate, type CollaboratorInvitation, type Link, type ProductAffiliate } from "@prisma/client";

import { decrypt } from "../../lib/obfuscate-ids.ts";
import { hasBrazilianStripeConnectAccount } from "../page-props/dashboard/payout-info.ts";

import { Collaborators, CollaboratorInvitations, COLLABORATOR } from "./collaborator-end.ts";
import { Links, LinkFlags } from "./link.ts";
import { defineModel } from "./runtime/define-model.ts";
import { transaction } from "./runtime/transaction.ts";
import { castRow, column, selectRows, table } from "./sql.ts";

// Collaborator::MIN_PERCENT_COMMISSION and MAX_PERCENT_COMMISSION
const MIN_PERCENT = 1;
const MAX_PERCENT = 50;
// has_flags 1 => :apply_to_all_products, 3 => :dont_show_as_co_creator on Affiliate; 1 => :dont_show_as_co_creator on ProductAffiliate
const APPLY_TO_ALL_PRODUCTS_FLAG = 1;
const DONT_SHOW_AS_CO_CREATOR_FLAG = 4;
const ASSIGNMENT_DONT_SHOW_FLAG = 1n;
// User: `has_flags 40 => :require_collab_request_approval`
const REQUIRE_COLLAB_REQUEST_APPROVAL_BIT = 1n << 39n;

export const NOT_AN_ACCOUNT = "The email address isn't associated with a Gumroad account.";
export const ALREADY_COLLABORATOR = "The user is already a collaborator";
export const NO_PRODUCTS = "At least one product must be selected";
export const PRODUCT_NOT_FOUND = "Product not found";
export const APPROVAL_REQUIRED = "You cannot add this user as a collaborator";

export type RequestedProduct = { externalId: string; percent: number | null; dontShow: boolean };
export type RequestedCollaboration = {
  email: string | null;
  applyToAllProducts: boolean;
  dontShow: boolean;
  // `percent_commission.presence&.to_i`
  percent: number | null;
  products: RequestedProduct[] | null;
};
type Row = Record<string, unknown>;

const ProductAffiliates = defineModel<ProductAffiliate>({
  rubyClass: "ProductAffiliate",
  prismaModel: "ProductAffiliate",
  delegate: (tx) => tx.productAffiliate as never,
});

// `errors` is the inertia error hash when the refusal carries more than the base message.
export type Refusal = { message: string; errors?: Record<string, string> } | { blocked: string };
export type Resolved = {
  sellerId: number;
  affiliateUserId: number;
  invited: boolean;
  basisPoints: number | null;
  applyToAllProducts: boolean;
  dontShow: boolean;
  products: { linkId: number; basisPoints: number; dontShow: boolean }[];
};

const one = async (query: Prisma.Sql): Promise<Row | undefined> => (await selectRows<Row>(query))[0];
const u = (name: string) => column("users", name);
const a = (name: string) => column("affiliates", name);

// The service up to the point where it saves: a message is what Rails answers with, `blocked` is why this port will not decide.
export async function resolveCreation(
  sellerId: bigint,
  requested: RequestedCollaboration,
): Promise<Refusal | Resolved> {
  const { email } = requested;
  const matches =
    email === null || email.trim() === ""
      ? []
      : await selectRows<Row>(
          Prisma.sql`SELECT ${Prisma.raw("`users`.*")} FROM ${table("users")} WHERE ${u("email")} = ${email} LIMIT 2`,
        );
  if (matches.length === 0) return { message: NOT_AN_ACCOUNT };
  if (matches.length > 1)
    return { blocked: "several accounts with this email, of which find_by takes an unspecified one" };
  const user = matches[0]!;
  const userId = Number(user.id);
  if (BigInt(userId) === sellerId) return { blocked: "a collaboration with oneself" };

  const existing = await one(
    Prisma.sql`SELECT ${a("id")} FROM ${table("affiliates")} WHERE ${a("type")} = ${COLLABORATOR} AND ${a("seller_id")} = ${sellerId} AND ${a("deleted_at")} IS NULL AND ${a("affiliate_user_id")} = ${userId} LIMIT 1`,
  );
  if (existing !== undefined) return { message: ALREADY_COLLABORATOR };

  // `require_approval?`: the invited seller has not accepted the inviter as their own collaborator.
  const accepted = await one(
    Prisma.sql`SELECT ${a("id")} FROM ${table("affiliates")} LEFT OUTER JOIN ${table("collaborator_invitations")} ON ${column("collaborator_invitations", "collaborator_id")} = ${a("id")} WHERE ${a("type")} = ${COLLABORATOR} AND ${a("seller_id")} = ${userId} AND ${a("deleted_at")} IS NULL AND ${a("affiliate_user_id")} = ${sellerId} AND ${column("collaborator_invitations", "id")} IS NULL LIMIT 1`,
  );
  const invited = accepted === undefined;

  if (requested.products === null || requested.products.length === 0) return { message: NO_PRODUCTS };
  const products: Resolved["products"] = [];
  for (const product of requested.products) {
    const id = decrypt(product.externalId) ?? Number.NaN;
    const row = Number.isInteger(id)
      ? await one(
          Prisma.sql`SELECT ${column("links", "id")} FROM ${table("links")} WHERE ${column("links", "user_id")} = ${sellerId} AND ${column("links", "id")} = ${id} LIMIT 1`,
        )
      : undefined;
    if (row === undefined) return { message: PRODUCT_NOT_FOUND };
    const percent = requested.applyToAllProducts ? requested.percent : product.percent;
    products.push({
      linkId: id,
      basisPoints: (percent ?? 0) * 100,
      dontShow: requested.applyToAllProducts ? requested.dontShow : product.dontShow,
    });
  }

  const resolved: Resolved = {
    sellerId: Number(sellerId),
    affiliateUserId: userId,
    invited,
    basisPoints: requested.percent === null ? null : requested.percent * 100,
    applyToAllProducts: requested.applyToAllProducts,
    dontShow: requested.dontShow,
    products,
  };
  const overLimit = isOverLimit(resolved);
  const blocked = await creationBlocker(resolved, user, overLimit);
  if (blocked !== null) return { blocked };
  // Everything else holds, so the one validation left is the invited seller's own setting.
  const requiresApproval = (BigInt(user.flags as bigint | number) & REQUIRE_COLLAB_REQUEST_APPROVAL_BIT) !== 0n;
  if (overLimit) {
    // A second failing validation would change which message comes first and the error hash.
    if (requiresApproval)
      return { blocked: "a commission above the maximum from a user who reviews collaboration requests" };
    return OVER_LIMIT_REFUSAL;
  }
  if (requiresApproval) return { message: APPROVAL_REQUIRED };
  return resolved;
}

// One product under an all-products collaboration, both carrying a commission above the maximum: the collaborator and its product
// assignment fail the same numericality validation, and the assignment's error comes first.
const OVER_LIMIT_MESSAGE = `must be less than or equal to ${MAX_PERCENT * 100}`;
const OVER_LIMIT_BASE = `Product affiliates affiliate basis points ${OVER_LIMIT_MESSAGE}`;
const OVER_LIMIT_REFUSAL: Refusal = {
  message: OVER_LIMIT_BASE,
  errors: {
    "collaborator.product_affiliates.affiliate_basis_points": OVER_LIMIT_MESSAGE,
    "collaborator.affiliate_basis_points": OVER_LIMIT_MESSAGE,
    "collaborator.base": OVER_LIMIT_BASE,
  },
};
const isOverLimit = (resolved: Resolved) =>
  resolved.applyToAllProducts &&
  resolved.products.length === 1 &&
  resolved.basisPoints !== null &&
  resolved.basisPoints > MAX_PERCENT * 100 &&
  resolved.products[0]!.basisPoints === resolved.basisPoints;

const inRange = (basisPoints: number) => basisPoints >= MIN_PERCENT * 100 && basisPoints <= MAX_PERCENT * 100;

// Why the creation cannot be answered here, or null. Reads only: nothing has been written.
async function creationBlocker(resolved: Resolved, user: Row, overLimit: boolean): Promise<string | null> {
  if (!overLimit) {
    if (resolved.basisPoints !== null && !inRange(resolved.basisPoints))
      return "a commission outside the allowed range, which fails validation";
    if (resolved.applyToAllProducts && resolved.basisPoints === null)
      return "an all-products collaboration without a commission, which fails validation";
    if (resolved.products.some((product) => !inRange(product.basisPoints)))
      return "a product commission outside the allowed range, which fails validation";
  }
  const linkIds = resolved.products.map((product) => product.linkId);
  if (new Set(linkIds).size !== linkIds.length) return "the same product twice";

  if (await hasBrazilianStripeConnectAccount(BigInt(resolved.sellerId)))
    return "a seller with a Brazilian Stripe account, which fails validation";
  if (await hasBrazilianStripeConnectAccount(BigInt(user.id as number)))
    return "a collaborator with a Brazilian Stripe account, which fails validation";

  const ids = Prisma.join(linkIds);
  const links = await selectRows<Row>(
    Prisma.sql`SELECT ${Prisma.raw("`links`.*")} FROM ${table("links")} WHERE ${column("links", "id")} IN (${ids})`,
  );
  if (links.some((link) => link.deleted_at !== null)) return "a deleted product";
  const assigned = await one(
    Prisma.sql`SELECT ${column("affiliates_links", "id")} FROM ${table("affiliates_links")} INNER JOIN ${table("affiliates")} ON ${a("id")} = ${column("affiliates_links", "affiliate_id")} WHERE ${column("affiliates_links", "link_id")} IN (${ids}) AND (${a("type")} <> ${COLLABORATOR} OR ${a("deleted_at")} IS NULL) LIMIT 1`,
  );
  if (assigned !== undefined) return "a product that already has a collaborator or an affiliate";
  const selfService = await one(
    Prisma.sql`SELECT ${column("self_service_affiliate_products", "id")} FROM ${table("self_service_affiliate_products")} WHERE ${column("self_service_affiliate_products", "product_id")} IN (${ids}) LIMIT 1`,
  );
  if (selfService !== undefined) return "a product with a self-service affiliate, which the callback disables";

  for (const link of links) {
    const product = Links.load(castRow<Link>("Link", link));
    product.assign({ flags: LinkFlags.set(product.get("flags"), "is_collab", true) });
    // Validating the changed record also refuses a save Node has not ported, before anything is written.
    if (!(await Links.valid(product))) return "a product that would fail its own validation";
  }
  return null;
}

// `Link.where(id: ids).order(:id).lock.load`
const lockProducts = (ids: number[]) =>
  selectRows(
    Prisma.sql`SELECT ${column("links", "id")} FROM ${table("links")} WHERE ${column("links", "id")} IN (${Prisma.join(ids)}) ORDER BY ${column("links", "id")} ASC FOR UPDATE`,
  );

// `collaborator.save` inside the transaction `process` opens; returns the id of the new collaboration.
export async function createCollaboration(resolved: Resolved): Promise<number> {
  return transaction(async () => {
    await lockProducts(resolved.products.map((product) => product.linkId));
    let flags = 0;
    if (resolved.applyToAllProducts) flags |= APPLY_TO_ALL_PRODUCTS_FLAG;
    if (resolved.dontShow) flags |= DONT_SHOW_AS_CO_CREATOR_FLAG;
    const collaborator = Collaborators.build({
      seller_id: resolved.sellerId,
      affiliate_user_id: resolved.affiliateUserId,
      affiliate_basis_points: resolved.basisPoints,
      destination_url: null,
      flags,
      type: COLLABORATOR,
    } as Partial<Affiliate>);
    await Collaborators.saveBang(collaborator);
    const id = collaborator.get("id");

    for (const assignment of resolved.products) {
      // The assignment's own locks come first, then the insert, then its product is marked as a collab.
      await lockProducts([assignment.linkId]);
      await selectRows(Prisma.sql`SELECT ${a("id")} FROM ${table("affiliates")} WHERE ${a("id")} = ${id} FOR UPDATE`);
      await ProductAffiliates.saveBang(
        ProductAffiliates.build({
          affiliate_id: id,
          link_id: assignment.linkId,
          affiliate_basis_points: assignment.basisPoints,
          destination_url: null,
          flags: assignment.dontShow ? ASSIGNMENT_DONT_SHOW_FLAG : 0n,
        } as Partial<ProductAffiliate>),
      );
      const [row] = await selectRows(
        Prisma.sql`SELECT ${Prisma.raw("`links`.*")} FROM ${table("links")} WHERE ${column("links", "id")} = ${assignment.linkId} LIMIT 1`,
      );
      const product = Links.load(castRow<Link>("Link", row!));
      await Links.updateBang(product, { flags: LinkFlags.set(product.get("flags"), "is_collab", true) });
    }
    if (resolved.invited)
      await CollaboratorInvitations.saveBang(
        CollaboratorInvitations.build({ collaborator_id: BigInt(id) } as Partial<CollaboratorInvitation>),
      );
    return id;
  });
}
