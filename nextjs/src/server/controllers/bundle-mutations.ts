// The writes of Bundles::{Product,Content,Share}Controller (app/controllers/bundles/): the sign-in check, the 404 for an id that is not a
// bundle candidate, the policy, and the refusals each action decides before it saves.
//
// Ported: those guards, #share's redirect for an unpublished bundle, #content's "Products must be an array." refusal,
// #update_purchases_content with no outdated purchases, and #remove_file's 404 for a file that is not attached.
// Handed to Rails before any write: a bundle save (product, content and share updates all save, reindex or enqueue), removing a
// file that is attached, and queueing the outdated-purchases job.
import { Prisma } from "@prisma/client";

import { decrypt, encrypt as externalId } from "../../lib/obfuscate-ids.ts";
import { railsLoggedInUser } from "../auth/resolve.ts";
import { LinkFlags } from "../models/link.ts";
import { column, selectRows, table } from "../models/sql.ts";
import { sellerGuard } from "../page-props/audience/seller-guard.ts";
import { findBundle } from "../page-props/bundles/pages.ts";
import { domainConfig } from "../page-props/domain.ts";
import { authorize } from "../policies/authorize.ts";
import { collaboratingProductIds, linkPolicy } from "../policies/link.ts";
import type { SellerContext } from "../policies/seller-context.ts";
import type { LinkRow } from "../presenters/product-reads.ts";

import { HandBackToRails, type ActionResult } from "./application-controller.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";
import { requestFormat } from "./rails-params.ts";
import { accountEmailRequired, authorizeJson, json, NOT_FOUND } from "./seller-json.ts";

const FOUND = 302;
const UNPUBLISHED_ALERT =
  "Not yet! You've got to publish your awesome product before you can share it with your audience and the world.";
const PRODUCTS_NOT_AN_ARRAY = "Products must be an array.";
const NO_OUTDATED_PURCHASES = "This bundle has no purchases with outdated content.";
const NUMERIC_KEY = /^\d+$/u;

const guardInput = (input: MutationInput) => ({
  context: input.context,
  config: domainConfig(process.env),
  url: input.url,
  params: input.routeParams,
  urlOptions: input.urlOptions,
});

const isHash = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const editContentPath = (bundle: LinkRow) => `/bundles/${externalId(bundle.id)}/content/edit`;

// `Link#published?`
const published = (bundle: LinkRow) =>
  bundle.deleted_at === null && bundle.purchase_disabled_at === null && !bundle.draft;

// Bundles::BaseController: `set_bundle`, then `authorize @bundle` (LinkPolicy#update?).
async function authorizedBundle(input: MutationInput, context: SellerContext): Promise<LinkRow> {
  const bundle = await findBundle(input.routeParams.bundle_id!);
  const collaborating = await collaboratingProductIds(context, [bundle.id]);
  authorize((c, record) => linkPolicy.update(c, record, collaborating), context, {
    id: bundle.id,
    user_id: bundle.user_id,
    flags: bundle.flags ?? 0,
  });
  return bundle;
}

async function guarded(input: MutationInput): Promise<{ redirect: ActionResult | null; bundle: LinkRow }> {
  const holder: { bundle?: LinkRow } = {};
  const redirect = await sellerGuard(guardInput(input), async (context) => {
    holder.bundle = await authorizedBundle(input, context);
  });
  return { redirect, bundle: holder.bundle! };
}

// PATCH /bundles/:bundle_id/product
async function updateProduct(input: MutationInput): Promise<ActionResult> {
  const { redirect } = await guarded(input);
  if (redirect !== null) return redirect;
  throw new HandBackToRails("saving a bundle, which reindexes it and can enqueue jobs");
}

// PATCH /bundles/:bundle_id/share
async function updateShare(input: MutationInput): Promise<ActionResult> {
  const { redirect, bundle } = await guarded(input);
  if (redirect !== null) return redirect;
  // ensure_published is a before_action, so its redirect skips the after_actions.
  if (!published(bundle))
    return { status: FOUND, location: editContentPath(bundle), flash: { alert: UNPUBLISHED_ALERT }, rescued: true };
  throw new HandBackToRails("saving a bundle's share settings, which reindexes it and can enqueue jobs");
}

// PATCH /bundles/:bundle_id/content
async function updateContent(input: MutationInput): Promise<ActionResult> {
  const { redirect, bundle } = await guarded(input);
  if (redirect !== null) return redirect;
  const products = input.params.products;
  // `params.permit(products: [...]).fetch(:products, [])` is an Array for a list; an index-keyed form hash stays a hash.
  if (products === undefined || Array.isArray(products))
    throw new HandBackToRails("replacing a bundle's products, which saves, reindexes and can enqueue jobs");
  if (
    !isHash(products) ||
    Object.keys(products).length === 0 ||
    !Object.entries(products).every(
      ([key, entry]) => NUMERIC_KEY.test(key) && isHash(entry) && typeof entry.product_id === "string",
    )
  )
    throw new HandBackToRails("a products parameter whose strong-parameters shape Node does not reproduce");
  return { status: FOUND, location: editContentPath(bundle), flash: { alert: PRODUCTS_NOT_AN_ARRAY } };
}

// POST /bundles/:bundle_id/content/update_purchases_content
async function updatePurchasesContent(input: MutationInput): Promise<ActionResult> {
  const { redirect, bundle } = await guarded(input);
  if (redirect !== null) return redirect;
  if (LinkFlags.isSet(BigInt(bundle.flags ?? 0), "has_outdated_purchases"))
    throw new HandBackToRails("queueing the update of outdated purchases, which clears a flag and enqueues a job");
  return { status: FOUND, location: editContentPath(bundle), flash: { alert: NO_OUTDATED_PURCHASES } };
}

// POST /bundles/:bundle_id/product/remove_file
async function removeFile(input: MutationInput): Promise<ActionResult> {
  if (requestFormat(input.request) !== "json")
    throw new HandBackToRails("a bundle file removal requested in another format");
  if (!railsLoggedInUser(input.context)) throw new HandBackToRails("a signed-out request");
  const refused = accountEmailRequired(input);
  if (refused !== null) return refused;
  const holder: { bundle?: LinkRow } = {};
  const denied = await authorizeJson(input, async (context) => {
    holder.bundle = await authorizedBundle(input, context);
  });
  if (denied !== null) return denied;

  const fileId = input.params.file_id;
  if (typeof fileId !== "string") throw new HandBackToRails("a file id that is not text");
  // `@bundle.product_files.alive.find_by_external_id(params[:file_id])`
  const id = decrypt(fileId);
  const [file] =
    id === null
      ? []
      : await selectRows(
          Prisma.sql`SELECT ${column("product_files", "id")} FROM ${table("product_files")} WHERE ${column("product_files", "link_id")} = ${holder.bundle!.id} AND ${column("product_files", "deleted_at")} IS NULL AND ${column("product_files", "id")} = ${id} LIMIT 1`,
        );
  if (file !== undefined)
    throw new HandBackToRails("removing a product file, which archives, reindexes and enqueues jobs");
  return json({ success: false, error_message: "That file is no longer attached to this bundle." }, NOT_FOUND);
}

registerMutations(
  { method: "PATCH", pattern: "/bundles/:bundle_id/product", run: updateProduct },
  { method: "PATCH", pattern: "/bundles/:bundle_id/share", run: updateShare },
  { method: "PATCH", pattern: "/bundles/:bundle_id/content", run: updateContent },
  { method: "POST", pattern: "/bundles/:bundle_id/content/update_purchases_content", run: updatePurchasesContent },
  { method: "POST", pattern: "/bundles/:bundle_id/product/remove_file", json: true, run: removeFile },
);
