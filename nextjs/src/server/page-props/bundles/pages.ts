// BundlesController#show (`/bundles/:id`). The bundle editors (Bundles/Product, Content and Share) are not ported
// yet: their props read the bundle's products, covers, files and offer codes. The `/bundles/:id/edit*` routes are
// Rails route redirects (config/routes.rb), not controller actions, so they stay in Rails.
import { Prisma } from "@prisma/client";

import { encrypt as externalId, decrypt } from "../../../lib/obfuscate-ids.ts";
import { HandBackToRails, RoutingError } from "../../controllers/application-controller.ts";
import { linkPolicy } from "../../policies/link.ts";
import { authorize } from "../../policies/authorize.ts";
import { LinkFlags } from "../../models/link.ts";
import { column, selectRows, table } from "../../models/sql.ts";
import { findLink, type LinkRow } from "../../presenters/product-reads.ts";
import { sellerGuard } from "../audience/seller-guard.ts";
import type { PageSpec } from "../pages.ts";

const NATIVE_TYPE_CALL = "call";

// Link.can_be_bundle: a bundle, or a product that is neither a membership nor a call and has no alive variant
// categories. `where.not(native_type:)` is SQL `!=`, which drops a NULL native_type, so NULL is excluded here too.
export function canBeBundle(product: Pick<LinkRow, "flags" | "native_type">, hasAliveVariantCategories: boolean): boolean {
  const flags = product.flags as bigint;
  if (LinkFlags.isSet(flags, "is_bundle")) return true;
  if (LinkFlags.isSet(flags, "is_recurring_billing")) return false;
  if (product.native_type === null || product.native_type === NATIVE_TYPE_CALL) return false;
  return !hasAliveVariantCategories;
}

// `Link.can_be_bundle.find_by_external_id!`: a missing id, or a product that cannot be a bundle, is a 404.
async function findBundle(externalIdParam: string): Promise<LinkRow> {
  const id = decrypt(externalIdParam);
  const product = id === null ? null : await findLink(id);
  if (!product) throw new RoutingError("Not Found");
  const [category] = await selectRows<{ one: number }>(
    Prisma.sql`SELECT 1 AS one FROM ${table("variant_categories")} WHERE ${column("variant_categories", "link_id")} = ${product.id} AND ${column("variant_categories", "deleted_at")} IS NULL LIMIT 1`,
  );
  if (!canBeBundle(product, category !== undefined)) throw new RoutingError("Not Found");
  return product;
}

// BundlesController#show: `authorize bundle` (LinkPolicy#show?, the product-writer verdict), then a 301 to the product
// editor for every bundle, whatever its type. A denied visitor is sent to the dashboard, as Sellers::BaseController does.
const bundleShow: PageSpec = {
  component: "Bundles/Product/Edit",
  guard: async (info) => {
    const found: { location?: string } = {};
    const redirected = await sellerGuard(info, async (context) => {
      const bundle = await findBundle(info.params.id!);
      authorize(linkPolicy.create, context, bundle);
      found.location = `/bundles/${externalId(bundle.id)}/product/edit`;
    });
    if (redirected) return redirected;
    return { status: 301, location: found.location! };
  },
  // The guard always answers a redirect (or throws), so the proxy never renders this page.
  props: () => {
    throw new HandBackToRails();
  },
};

export const BUNDLES_PAGES: Record<string, PageSpec> = {
  "/bundles/:id": bundleShow,
};
