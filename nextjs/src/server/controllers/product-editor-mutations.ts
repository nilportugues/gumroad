// ProductDuplicatesController#create and #show, BundlesController#show and Products::BuildsController#index. A duplication itself
// (DuplicateProductWorker) stays a Sidekiq job; the success branch of #show renders the dashboard row of the copy and goes to Rails.
import { Prisma } from "@prisma/client";

import { decrypt, encrypt as externalId } from "../../lib/obfuscate-ids.ts";
import { isFeatureEnabled, userActor } from "../infra/flipper.ts";
import { getRedis } from "../infra/redis.ts";
import { performAsync } from "../models/concerns/job-runtime.ts";
import { LinkFlags, Links } from "../models/link.ts";
import { promoteBuildBang } from "../models/product-build-promote.ts";
import { column, selectRows, table } from "../models/sql.ts";
import { NotPortedError } from "../models/user.ts";
import { authorize } from "../policies/authorize.ts";
import { collaboratingProductIds, linkPolicy, productDuplicatesLinkPolicy } from "../policies/link.ts";
import type { SellerContext } from "../policies/seller-context.ts";

import {
  type ActionContext,
  type ActionResult,
  HandBackToRails,
  processAction,
  RoutingError,
} from "./application-controller.ts";
import { jsonAction, jsonSellerGuard } from "./json-actions.ts";
import { sellerJsonAction } from "./json-seller.ts";
import { registerMutations } from "./mutation.ts";
import { find } from "./products-mutations.ts";
import { requestFormat } from "./rails-params.ts";
import { authorizeJson, json, noContent } from "./seller-json.ts";

// ProductDuplicatorService
const DUPLICATING = "product_duplicating";
const DUPLICATION_FAILED = "product_duplication_failed";
const DUPLICATOR_NAMESPACE = "product_duplicator_service";
const DUPLICATION_IN_PROGRESS = "Duplication in progress...";

registerMutations({
  method: "POST",
  pattern: "/product_duplicates",
  json: true,
  async run(input) {
    const found = await find(input, "ownership", (context) => authorize(productDuplicatesLinkPolicy.create, context));
    if (found.halt) return found.halt;
    const product = found.product;
    if (LinkFlags.isSet(product.get("flags"), "is_duplicating"))
      return json({ success: false, error_message: DUPLICATION_IN_PROGRESS });
    await performAsync("DuplicateProductWorker", [product.get("id")]);
    // Validations are skipped: a product can carry update-only errors unrelated to this flag.
    await Links.updateBang(
      product,
      { flags: LinkFlags.set(product.get("flags"), "is_duplicating", true) },
      { validate: false },
    );
    return json({ success: true });
  },
});

export const productDuplicateShowResponse = (
  incoming: Request,
  routeParams: Record<string, string>,
): Promise<Response> =>
  jsonAction(incoming, routeParams, {}, async (input) => {
    if (requestFormat(input.request) !== "json")
      throw new HandBackToRails("a product duplicate asked for in another format");
    const found = await find(input, "ownership", (context) => authorize(productDuplicatesLinkPolicy.create, context));
    if (found.halt) return found.halt;
    const product = found.product;
    if (LinkFlags.isSet(product.get("flags"), "is_duplicating"))
      return json({ success: false, status: DUPLICATING, error_message: DUPLICATION_IN_PROGRESS });
    const redis = getRedis("main");
    const duplicatedId = await redis.get(`${DUPLICATOR_NAMESPACE}:${String(product.get("id"))}`);
    if (duplicatedId !== null) {
      const [copy] = await selectRows(
        Prisma.sql`SELECT 1 AS one FROM ${table("links")} WHERE ${column("links", "id")} = ${duplicatedId} LIMIT 1`,
      );
      if (copy !== undefined) throw new HandBackToRails("a finished duplication renders the dashboard row of the copy");
    }
    return json({
      success: false,
      status: DUPLICATION_FAILED,
      error_message: await redis.get(`${DUPLICATOR_NAMESPACE}:error:${String(product.get("id"))}`),
    });
  });

// BundlesController#show: `Link.can_be_bundle.find_by_external_id!`, `authorize bundle` (show? is new?), then a permanent redirect.
export const bundleShowResponse = (incoming: Request, routeParams: Record<string, string>): Promise<Response> =>
  jsonAction(incoming, routeParams, {}, async (input) => {
    let redirect: ActionResult | null = null;
    const refused = await jsonSellerGuard(input, async (context) => {
      const id = decrypt(input.routeParams.id!);
      const [row] =
        id === null
          ? []
          : await selectRows<{ id: bigint }>(
              Prisma.sql`SELECT ${column("links", "id")} FROM ${table("links")} WHERE ${column("links", "id")} = ${id} AND ((${LinkFlags.condition("is_recurring_billing", false)} AND ${column("links", "native_type")} <> 'call'
                AND NOT EXISTS (SELECT 1 FROM ${table("variant_categories")} WHERE ${column("variant_categories", "link_id")} = ${column("links", "id")} AND ${column("variant_categories", "deleted_at")} IS NULL)) OR ${LinkFlags.condition("is_bundle")}) LIMIT 1`,
            );
      if (row === undefined) throw new RoutingError("Not Found");
      authorize(linkPolicy.new, context);
      redirect = { status: 301, location: `/bundles/${externalId(row.id)}/product/edit` };
    });
    return refused ?? redirect!;
  });

// Products::BuildsController#fetch_product: any visible product, `authorize @product, :update?`, then 404 unless the player is on.
async function fetchBuildsProduct(
  action: Pick<ActionContext, "context">,
  sellerContext: SellerContext,
  productId: string | undefined,
): Promise<{ product: { id: bigint; user_id: bigint | null } } | { halt: ActionResult }> {
  const [product] = await selectRows<{ id: bigint; user_id: bigint | null; flags: bigint }>(
    Prisma.sql`SELECT ${column("links", "id")}, ${column("links", "user_id")}, ${column("links", "flags")} FROM ${table("links")} WHERE ${column("links", "deleted_at")} IS NULL AND ${column("links", "unique_permalink")} = ${productId ?? ""} LIMIT 1`,
  );
  if (product === undefined) throw new RoutingError("Not Found");
  const collaborating = await collaboratingProductIds(sellerContext, [product.id]);
  const denied = await authorizeJson(action, () =>
    authorize((c, record) => linkPolicy.update(c, record, collaborating), sellerContext, product),
  );
  if (denied) return { halt: denied };
  if (!(await isFeatureEnabled("product_build_player", userActor(String(product.user_id)))))
    throw new RoutingError("Not Found");
  return { product };
}

async function buildsIndex(action: ActionContext, routeParams: Record<string, string>): Promise<ActionResult> {
  return sellerJsonAction(
    action,
    () => true,
    async (sellerContext) => {
      const fetched = await fetchBuildsProduct(action, sellerContext, routeParams.product_id);
      if ("halt" in fetched) return fetched.halt;
      const { product } = fetched;
      const rows = await selectRows<{
        public_id: string;
        number: number;
        status: string;
        byte_size: bigint;
        created_at: Date;
        promoted_at: Date | null;
      }>(
        Prisma.sql`SELECT ${column("product_builds", "public_id")}, ${column("product_builds", "number")}, ${column("product_builds", "status")}, ${column("product_builds", "byte_size")}, ${column("product_builds", "created_at")}, ${column("product_builds", "promoted_at")} FROM ${table("product_builds")} WHERE ${column("product_builds", "product_id")} = ${product.id} ORDER BY ${column("product_builds", "number")} DESC`,
      );
      return json({
        builds: rows.map((row) => ({
          id: row.public_id,
          number: row.number,
          status: row.status,
          byte_size: Number(row.byte_size),
          created_at: row.created_at.toISOString(),
          promoted_at: row.promoted_at?.toISOString() ?? null,
        })),
      });
    },
  );
}

// Products::BuildsController#promote (POST /products/:product_id/builds/:id/promote): the guards, then ProductBuild#promote! for a
// product with one set of pages (promoteBuildBang); a live build, versions and folders are handed back from inside it, before a write.
registerMutations({
  method: "POST",
  pattern: "/products/:product_id/builds/:id/promote.json",
  json: true,
  run: (input) =>
    sellerJsonAction(
      input,
      () => true,
      async (sellerContext) => {
        const fetched = await fetchBuildsProduct(input, sellerContext, input.routeParams.product_id);
        if ("halt" in fetched) return fetched.halt;
        const [build] = await selectRows<{ id: bigint }>(
          Prisma.sql`SELECT ${column("product_builds", "id")} FROM ${table("product_builds")} WHERE ${column("product_builds", "product_id")} = ${fetched.product.id} AND ${column("product_builds", "public_id")} = ${input.routeParams.id ?? ""} LIMIT 1`,
        );
        if (build === undefined) throw new RoutingError("Not Found");
        try {
          await promoteBuildBang(fetched.product.id, build.id);
        } catch (error) {
          if (error instanceof NotPortedError) throw new HandBackToRails(error.message);
          throw error;
        }
        return noContent();
      },
    ),
});

export const buildsResponse = (incoming: Request, routeParams: Record<string, string>): Promise<Response> =>
  processAction(incoming, {}, (action) => buildsIndex(action, routeParams));
