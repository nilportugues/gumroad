// AffiliatesController (app/controllers/affiliates_controller.rb) other than the pages and #statistics: the sign-in and role
// checks, the 404s, and the refusals #create and #update decide before they save.
//
// Ported: the lookups and authorization of every action, and the "Invalid affiliate parameters", unknown account, own account,
// opted-out account, no enabled product and "already exists" refusals of #create and #update.
// #destroy runs in Node (`mark_deleted!` of the DirectAffiliate, then `AffiliateMailer.direct_affiliate_removal(id).deliver_later`)
// for the shapes `removalBlocker` accepts; the rest goes to Rails before the write.
// #create runs in Node for one plain product (models/direct-affiliate-create.ts: the affiliate, its assignment, the audience member, the
// workflow schedule job and the invitation mail), and #update for an edit that only moves fees on the affiliate's one product
// (models/direct-affiliate-update.ts); `creationBlocker` and `updateBlocker` hand the rest back before any write.
// Handed to Rails before any write: #subscribe_posts and #unsubscribe_posts (a write,
// and an ERB page Node has no shell for). #export is not registered: the export service mails or streams a file, and a signed-in
// HTML GET would make Node seed the dashboard nav before handing back. Param shapes Rails would fail
// on (a 400 or a 500) or cast differently from Node hand back too.
import { Prisma } from "@prisma/client";

import { db } from "../../lib/db.ts";
import { decrypt, decryptNumeric } from "../../lib/obfuscate-ids.ts";
import { deliverLater } from "../mail/active-job.ts";
import { mailRoute } from "../mail/delivery.ts";
import { isBlank } from "../models/compliance-countries.ts";
import { currentJobsRuntime } from "../models/concerns/job-runtime.ts";
import { creationBlocker, createDirectAffiliate, rubyToI } from "../models/direct-affiliate-create.ts";
import {
  loadAffiliate,
  markDeletedBang,
  removalBlocker,
  type AffiliateRemovalRow,
} from "../models/direct-affiliate-removal.ts";
import { updateBlocker, updateDirectAffiliate } from "../models/direct-affiliate-update.ts";
import { column, selectRows, table } from "../models/sql.ts";
import { UserFlags } from "../models/user.ts";
import { sellerGuard } from "../page-props/audience/seller-guard.ts";
import { findDirectAffiliate } from "../page-props/dashboard/affiliates.ts";
import { domainConfig } from "../page-props/domain.ts";
import { authorize } from "../policies/authorize.ts";
import { directAffiliatePolicy } from "../policies/direct-affiliate.ts";

import { HandBackToRails, RoutingError, type ActionResult, type Redirected } from "./application-controller.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";
import { requireHtml } from "./users-controller.ts";

const FOUND = 302;
const SEE_OTHER = 303;
const NEW_AFFILIATE_PATH = "/affiliates/new";

const isHash = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const guardInput = (input: MutationInput) => ({
  context: input.context,
  config: domainConfig(process.env),
  url: input.url,
  params: input.routeParams,
  urlOptions: input.urlOptions,
});

// `redirect_to path, inertia: { errors: { base: [message] } }`
const refusal = (location: string, message: string): Redirected => ({
  status: FOUND,
  location,
  inertiaErrors: { base: [message] },
});

// `current_seller.direct_affiliates.find_by_external_id(params[:id]) || e404`
async function ownAffiliate(input: MutationInput) {
  const id = decrypt(input.routeParams.id ?? "");
  const affiliate = id === null ? null : await findDirectAffiliate(input.context.currentSeller!.id, id);
  if (affiliate === null) throw new RoutingError("Not Found");
  return affiliate;
}

// `params.require(:affiliate).permit(...)`: only text, numbers, booleans and null survive as scalars; the shapes Rails would
// reject or filter differently go to Rails.
type Product = { id: unknown; enabled: boolean; feePercent: string | number | null; destinationUrl: unknown };
type Submitted = {
  email: string | null;
  applyToAllProducts: boolean;
  feePercent: string | number | null;
  destinationUrl: unknown;
  products: Product[] | null;
};

const scalar = (value: unknown): string | number | null => {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" || typeof value === "number") return value;
  throw new HandBackToRails("a parameter that is not text or a number");
};
const truthy = (value: unknown): boolean => {
  if (value === undefined || value === null) return false;
  if (typeof value === "boolean") return value;
  // "false" is truthy in Ruby, which a form post would send.
  throw new HandBackToRails("a flag that is not a boolean, which Rails reads by Ruby truthiness");
};
const blank = (value: string | number | null) => value === null || (typeof value === "string" && isBlank(value));

function submitted(input: MutationInput): Submitted {
  const affiliate = input.params.affiliate;
  if (!isHash(affiliate) || Object.keys(affiliate).length === 0)
    throw new HandBackToRails("affiliate is missing or not a hash, which params.require turns into a 400");
  const email = scalar(affiliate.email);
  if (typeof email === "number") throw new HandBackToRails("an email that is a number");
  const rawProducts = affiliate.products;
  let products: Product[] | null = null;
  if (rawProducts !== undefined && rawProducts !== null) {
    if (!Array.isArray(rawProducts) || !rawProducts.every(isHash))
      throw new HandBackToRails("products that are not a list of hashes");
    products = rawProducts.map((product) => ({
      id: product.id,
      enabled: truthy(product.enabled),
      feePercent: scalar(product.fee_percent),
      destinationUrl: product.destination_url,
    }));
  }
  return {
    email,
    applyToAllProducts: truthy(affiliate.apply_to_all_products),
    feePercent: scalar(affiliate.fee_percent),
    destinationUrl: affiliate.destination_url,
    products,
  };
}

// `AffiliatesController#process_affiliate_params` up to the point where it saves; #create saves when the shape is proven.
async function refuseOrHandBack(
  input: MutationInput,
  failureLocation: string,
  editedId: number | null,
): Promise<ActionResult> {
  const seller = input.context.currentSeller!;
  const { email, applyToAllProducts, feePercent, destinationUrl, products } = submitted(input);

  // `affiliate_params[:products].any?` raises on a missing list; `||` only reaches it without apply_to_all_products.
  if (!applyToAllProducts && products === null)
    throw new HandBackToRails("a missing products list, which Rails raises on");
  const invalidFee =
    (applyToAllProducts && blank(feePercent)) ||
    (!applyToAllProducts && products!.some((product) => product.enabled && blank(product.feePercent)));
  if (email === null || isBlank(email) || invalidFee) return refusal(failureLocation, "Invalid affiliate parameters");

  const affiliateUser = await db.user.findFirst({ where: { email, deleted_at: null }, orderBy: { id: "asc" } });
  if (affiliateUser === null)
    return refusal(failureLocation, "The affiliate has not created a Gumroad account with this email address.");
  if (affiliateUser.id === seller.id)
    return refusal(failureLocation, "You found you. Good job. You can't be your own affiliate though.");
  if (UserFlags.isSet(affiliateUser.flags, "disable_affiliate_requests"))
    return refusal(failureLocation, "This user has disabled being added as an affiliate.");

  if (products === null) throw new HandBackToRails("a missing products list, which Rails raises on");
  if (!applyToAllProducts && !products.some((product) => product.enabled))
    return refusal(failureLocation, "Please enable at least one product.");

  const linkIds: number[] = [];
  if (!applyToAllProducts) {
    // `current_seller.links.find_by_external_id_numeric(id.to_i).id` raises on a product the seller does not have.
    for (const product of products.filter((candidate) => candidate.enabled)) {
      const numeric = Number(product.id);
      if (!Number.isInteger(numeric)) throw new HandBackToRails("a product id Rails would cast with to_i");
      const [row] = await selectRows<{ id: number }>(
        Prisma.sql`SELECT ${column("links", "id")} FROM ${table("links")} WHERE ${column("links", "user_id")} = ${seller.id} AND ${column("links", "id")} = ${decryptNumeric(numeric)} LIMIT 1`,
      );
      if (row === undefined) throw new HandBackToRails("a product the seller does not have, which Rails raises on");
      linkIds.push(Number(row.id));
    }
  }

  const [existing] = await selectRows(
    Prisma.sql`SELECT ${column("affiliates", "id")} FROM ${table("affiliates")} INNER JOIN ${table("affiliates_links")} ON ${column("affiliates_links", "affiliate_id")} = ${column("affiliates", "id")} INNER JOIN ${table("links")} ON ${column("links", "id")} = ${column("affiliates_links", "link_id")} WHERE ${column("affiliates", "type")} = 'DirectAffiliate' AND ${column("affiliates", "seller_id")} = ${seller.id} AND ${column("affiliates", "deleted_at")} IS NULL AND ${column("affiliates", "affiliate_user_id")} = ${affiliateUser.id}${editedId === null ? Prisma.empty : Prisma.sql` AND ${column("affiliates", "id")} <> ${editedId}`} LIMIT 1`,
  );
  if (existing !== undefined) return refusal(failureLocation, "This affiliate already exists.");

  const enabled = products.filter((product) => product.enabled);
  const productFee = enabled.length === 1 ? rubyToI(enabled[0]!.feePercent) * 100 : 0;
  if (affiliateUser.email === null) throw new HandBackToRails("an account without an email");
  // `fee_percent.present? ? fee * 100 : the lowest fee of the products`
  const candidate = {
    sellerId: Number(seller.id),
    affiliateUserId: Number(affiliateUser.id),
    affiliateUserEmail: affiliateUser.email,
    basisPoints: blank(feePercent) ? productFee : rubyToI(feePercent) * 100,
    productId: linkIds[0] ?? 0,
  };
  const requested = {
    applyToAllProducts,
    enabledProducts: enabled.map((product) => ({ destinationUrl: product.destinationUrl })),
    destinationUrl,
  };

  if (editedId !== null) {
    const edited = { ...candidate, id: editedId, productBasisPoints: productFee };
    const editBlocker = await updateBlocker(requested, edited);
    if (editBlocker !== null) throw new HandBackToRails(editBlocker);
    await updateDirectAffiliate(edited);
    return { status: SEE_OTHER, location: AFFILIATES_PATH, flash: { notice: "Affiliate updated successfully" } };
  }

  const blocker = await creationBlocker(requested, candidate);
  if (blocker !== null) throw new HandBackToRails(blocker);

  await createDirectAffiliate({ ...candidate, productBasisPoints: productFee });
  return { status: SEE_OTHER, location: AFFILIATES_PATH, flash: { notice: "Affiliate created successfully" } };
}

// POST /affiliates
async function create(input: MutationInput): Promise<ActionResult> {
  const redirect = await sellerGuard(guardInput(input), (context) => authorize(directAffiliatePolicy.create, context));
  if (redirect !== null) return redirect;
  return refuseOrHandBack(input, NEW_AFFILIATE_PATH, null);
}

// PATCH|PUT /affiliates/:id
async function update(input: MutationInput): Promise<ActionResult> {
  const holder: { id: number | null } = { id: null };
  const redirect = await sellerGuard(guardInput(input), async (context) => {
    holder.id = (await ownAffiliate(input)).id;
    authorize(directAffiliatePolicy.update, context);
  });
  if (redirect !== null) return redirect;
  // edit_affiliate_path(@affiliate): Affiliate has no #to_param, so the path carries the database id.
  return refuseOrHandBack(input, `/affiliates/${holder.id}/edit`, holder.id);
}

const AFFILIATE_MAILER = "AffiliateMailer";
const REMOVAL_MAIL = "direct_affiliate_removal";
const AFFILIATES_PATH = "/affiliates";

// `current_seller.direct_affiliates.find_by_external_id(params[:id])`, with the columns `mark_deleted!` and its validations read.
async function removableAffiliate(sellerId: bigint, id: number) {
  const a = (name: string) => column("affiliates", name);
  const [row] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`affiliates`.*")} FROM ${table("affiliates")} WHERE ${a("type")} = 'DirectAffiliate' AND ${a("seller_id")} = ${sellerId} AND ${a("id")} = ${id} LIMIT 1`,
  );
  return row as (AffiliateRemovalRow & Record<string, unknown>) | undefined;
}

// DELETE /affiliates/:id
async function destroy(input: MutationInput): Promise<ActionResult> {
  const found: { row?: AffiliateRemovalRow & Record<string, unknown> } = {};
  const redirect = await sellerGuard(guardInput(input), async (context) => {
    const owned = await ownAffiliate(input);
    found.row = await removableAffiliate(input.context.currentSeller!.id, owned.id);
    authorize(directAffiliatePolicy.destroy, context);
  });
  if (redirect !== null) return redirect;
  const row = found.row;
  if (row === undefined) throw new RoutingError("Not Found");
  const blocker = await removalBlocker(row);
  if (blocker !== null) throw new HandBackToRails(blocker);

  await markDeletedBang(loadAffiliate(row));
  // After the commit: `deliver_later` is the last thing the action does, so a refused removal never mails.
  await deliverLater(
    currentJobsRuntime(),
    { mailer: AFFILIATE_MAILER, method: REMOVAL_MAIL, args: [Number(row.id)] },
    mailRoute(AFFILIATE_MAILER, REMOVAL_MAIL),
  );
  return { status: FOUND, location: AFFILIATES_PATH, flash: { notice: "Affiliate deleted successfully" } };
}

// GET /affiliates/:id/subscribe_posts and /unsubscribe_posts: public; `DirectAffiliate.find_by_external_id(params[:id])`, any seller.
async function postsSubscription(input: MutationInput): Promise<ActionResult> {
  requireHtml(input);
  const id = decrypt(input.routeParams.id ?? "");
  const [row] =
    id === null
      ? []
      : await selectRows(
          Prisma.sql`SELECT ${column("affiliates", "id")} FROM ${table("affiliates")} WHERE ${column("affiliates", "type")} = 'DirectAffiliate' AND ${column("affiliates", "id")} = ${id} LIMIT 1`,
        );
  if (row === undefined) throw new RoutingError("Not Found");
  throw new HandBackToRails("a posts subscription change, which writes and renders an ERB page");
}

registerMutations(
  { method: "POST", pattern: "/affiliates", run: create },
  { method: "PATCH", pattern: "/affiliates/:id", run: update },
  { method: "PUT", pattern: "/affiliates/:id", run: update },
  { method: "DELETE", pattern: "/affiliates/:id", run: destroy },
  { method: "GET", pattern: "/affiliates/:id/subscribe_posts", skipForgeryProtection: true, run: postsSubscription },
  { method: "GET", pattern: "/affiliates/:id/unsubscribe_posts", skipForgeryProtection: true, run: postsSubscription },
);
