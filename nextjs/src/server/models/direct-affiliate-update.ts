// The save `AffiliatesController#update` makes when an edit keeps the affiliate, its account and its one product and only moves fees
// (app/models/direct_affiliate.rb, product_affiliate.rb): the product's row lock, the affiliate's UPDATE, the assignment's UPDATE, and
// when the product's fee moved the mail `AffiliateMailer.notify_direct_affiliate_of_updated_products(id).deliver_later`.
//
// Not ported, and refused before the first write by `updateBlocker`: an edit that changes the account, the products, the
// all-products flag or a destination URL (they rewrite assignments and the audience member), and the shapes `creationBlocker`
// refuses (a fee outside 1%..75%, a collab or deleted product, a Brazilian Stripe Connect account).
import { Prisma, type Affiliate, type ProductAffiliate } from "@prisma/client";

import { deliverLater } from "../mail/active-job.ts";
import { mailRoute } from "../mail/delivery.ts";

import { currentJobsRuntime } from "./concerns/job-runtime.ts";
import { creationBlocker, ProductAffiliates, type Requested } from "./direct-affiliate-create.ts";
import { DIRECT_AFFILIATE, DirectAffiliates } from "./direct-affiliate-removal.ts";
import { PRODUCT_AFFILIATES } from "./product-affiliate.ts";
import { transaction } from "./runtime/transaction.ts";
import { castRow, column, selectRows, table } from "./sql.ts";

const AFFILIATE_MAILER = "AffiliateMailer";
const UPDATED_PRODUCTS_MAIL = "notify_direct_affiliate_of_updated_products";
// Affiliate: `has_flags 1 => :apply_to_all_products`
const APPLY_TO_ALL_PRODUCTS_FLAG = 1;

export type EditedAffiliate = {
  id: number;
  sellerId: number;
  affiliateUserId: number;
  affiliateUserEmail: string;
  basisPoints: number;
  productId: number;
  productBasisPoints: number;
};

type Rows = { affiliate: Affiliate; assignments: ProductAffiliate[] };

async function currentRows(id: number): Promise<Rows | null> {
  const [affiliate] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`affiliates`.*")} FROM ${table("affiliates")} WHERE ${column("affiliates", "id")} = ${id} LIMIT 1`,
  );
  if (affiliate === undefined) return null;
  const assignments = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw(`\`${PRODUCT_AFFILIATES}\`.*`)} FROM ${table(PRODUCT_AFFILIATES)} WHERE ${column(PRODUCT_AFFILIATES, "affiliate_id")} = ${id}`,
  );
  return {
    affiliate: castRow<Affiliate>("Affiliate", affiliate),
    assignments: assignments.map((row) => castRow<ProductAffiliate>("ProductAffiliate", row)),
  };
}

// Why the edit cannot be answered here, or null. Reads only: nothing has been written.
export async function updateBlocker(requested: Requested, edited: EditedAffiliate): Promise<string | null> {
  const rows = await currentRows(edited.id);
  if (rows === null) return "an affiliate that no longer exists";
  const { affiliate, assignments } = rows;
  if (affiliate.type !== DIRECT_AFFILIATE || affiliate.deleted_at !== null) return "an affiliate that is deleted";
  if (affiliate.affiliate_user_id !== edited.affiliateUserId)
    return "an edit that moves the affiliation to another account";
  if ((affiliate.flags & APPLY_TO_ALL_PRODUCTS_FLAG) !== 0) return "an affiliate for all products";
  if (affiliate.destination_url !== null) return "an affiliate with a destination URL";
  if (assignments.length !== 1 || assignments[0]!.link_id !== edited.productId)
    return "an edit that changes the products of the affiliate";
  if (assignments[0]!.destination_url !== null) return "a product with a destination URL";

  // `existing_affiliate` (the newest live affiliation of the account) decides send_posts: it must be this one.
  const alive = await selectRows<{ id: number }>(
    Prisma.sql`SELECT ${column("affiliates", "id")} FROM ${table("affiliates")} WHERE ${column("affiliates", "type")} = ${DIRECT_AFFILIATE} AND ${column("affiliates", "seller_id")} = ${edited.sellerId} AND ${column("affiliates", "affiliate_user_id")} = ${edited.affiliateUserId} AND ${column("affiliates", "deleted_at")} IS NULL`,
  );
  if (alive.length !== 1) return "an account the seller has as several live affiliates";

  // The checks a creation makes of the request and the product, without its uniqueness read: this affiliate is the one live row.
  return creationBlocker(requested, edited, { editing: true });
}

const lockProduct = (productId: number) =>
  selectRows(
    Prisma.sql`SELECT ${column("links", "id")} FROM ${table("links")} WHERE ${column("links", "id")} = ${productId} LIMIT 1 FOR UPDATE`,
  );
const lockAffiliate = (affiliateId: number) =>
  selectRows(
    Prisma.sql`SELECT ${column("affiliates", "id")} FROM ${table("affiliates")} WHERE ${column("affiliates", "id")} = ${affiliateId} FOR UPDATE`,
  );

// `affiliate.save` for the edited fees, then the mail when the product's fee moved.
export async function updateDirectAffiliate(edited: EditedAffiliate): Promise<void> {
  const productFeeMoved = await transaction(async () => {
    const rows = (await currentRows(edited.id))!;
    const assignment = ProductAffiliates.load(rows.assignments[0]!);
    const moved = assignment.get("affiliate_basis_points") !== edited.productBasisPoints;
    assignment.set("affiliate_basis_points", edited.productBasisPoints);
    // lock_products_for_assignment_changes: only when an assignment changed.
    if (assignment.hasChangesToSave()) await lockProduct(edited.productId);

    const affiliate = DirectAffiliates.load(rows.affiliate);
    affiliate.set("affiliate_basis_points", edited.basisPoints);
    await DirectAffiliates.saveBang(affiliate);

    // The autosaved assignment, when it changed: its own locks, the uniqueness read, then the UPDATE.
    if (assignment.hasChangesToSave()) {
      await lockProduct(edited.productId);
      await lockAffiliate(edited.id);
      await selectRows(
        Prisma.sql`SELECT 1 AS \`one\` FROM ${table(PRODUCT_AFFILIATES)} WHERE ${column(PRODUCT_AFFILIATES, "affiliate_id")} = ${edited.id} AND ${column(PRODUCT_AFFILIATES, "link_id")} = ${edited.productId} AND ${column(PRODUCT_AFFILIATES, "id")} <> ${assignment.get("id")} LIMIT 1 FOR UPDATE`,
      );
      await ProductAffiliates.saveBang(assignment);
    }
    return moved;
  });
  if (!productFeeMoved) return;
  await deliverLater(
    currentJobsRuntime(),
    { mailer: AFFILIATE_MAILER, method: UPDATED_PRODUCTS_MAIL, args: [edited.id] },
    mailRoute(AFFILIATE_MAILER, UPDATED_PRODUCTS_MAIL),
  );
}
