// Purchases::ProductController#show (GET /purchases/:purchase_id/product): the product page as it stood when the purchase was made,
// which sellers open to answer a chargeback. Rails reifies the product from its PaperTrail version at the purchase's `created_at`,
// then deep-merges PurchaseProductPresenter#product_props over ProductPresenter#product_props.
//
// Served for any visitor (the seller, the buyer or a stranger, signed in or not) and a product that has no version after the purchase (the live row is then the reified one), no
// asset previews, no variants or SKUs and a purchase without a refund policy snapshot: the time-travelling parts of the presenter
// then have nothing to differ on. The rest goes to Rails before the page renders.
import { db } from "../../../lib/db.ts";
import { decrypt } from "../../../lib/obfuscate-ids.ts";
import { railsLoggedInUser } from "../../auth/resolve.ts";
import {
  HandBackToRails,
  RoutingError,
  type Chain,
  type FilterOutcome,
} from "../../controllers/application-controller.ts";
import { requireHtml } from "../../controllers/buyer-pages.ts";
import { assertFlatQuery } from "../../controllers/rails-params.ts";
import { parseQuery } from "../../controllers/rails-query.ts";
import { LinkFlags } from "../../models/link.ts";
import { loadSellerContext } from "../../policies/seller-context.ts";
import { guidOf, sellerCustomDomainUrl, UNSUPPORTED_PRODUCT_PARAMS, viewerOf } from "../../presenters/product-page.ts";
import { productProps } from "../../presenters/product-props.ts";
import { findLink, findUserById } from "../../presenters/product-reads.ts";
import { remoteIp } from "../audience/events.ts";
import { NotPortedError } from "../not-ported.ts";
import type { PageSpec } from "../pages.ts";
import { sellerCustomStyles } from "../storefront/profile-pages.ts";

const STATE_KEY = "purchaseProductProps";
const PRODUCT_PATH = /^\/purchases\/([^/.]+)\/product$/u;

const safeDecode = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

async function productFilters(chain: Chain): Promise<FilterOutcome> {
  requireHtml(chain);
  assertFlatQuery(chain.request.queryString);
  // set_purchase: `Purchase.find_by_external_id(params[:purchase_id]) || e404`
  const externalId = PRODUCT_PATH.exec(chain.request.path)?.[1];
  const id = externalId === undefined ? null : decrypt(safeDecode(externalId));
  const purchase = id === null ? null : await db.purchase.findUnique({ where: { id: BigInt(id) } });
  if (!purchase) throw new RoutingError("Not Found");
  // set_noindex_header
  chain.headers.set("x-robots-tag", "noindex");

  const query = parseQuery(chain.request.queryString);
  for (const name of [...UNSUPPORTED_PRODUCT_PARAMS, "layout", "quantity", "code"])
    if (name in query) throw new HandBackToRails("a parameter the product presenter reads");

  const product = await findLink(purchase.link_id!);
  if (product === null) throw new HandBackToRails("a purchase whose product row is missing");
  const seller = (await findUserById(product.user_id!))!;

  // `purchase.link.paper_trail.version_at(purchase.created_at)`: the product as of the first change after the purchase.
  const changedAfter = await db.version.count({
    where: { item_type: "Link", item_id: product.id, created_at: { gte: purchase.created_at! } },
  });
  if (changedAfter > 0)
    throw new HandBackToRails("a product changed after the purchase, which Rails rebuilds from its version");
  const timeTravelled =
    (await db.assetPreview.count({ where: { link_id: product.id } })) +
    (await db.variantCategory.count({ where: { link_id: Number(product.id) } })) +
    (await db.purchaseRefundPolicy.count({ where: { purchase_id: purchase.id } }));
  if (timeTravelled > 0 || LinkFlags.isSet(product.flags, "skus_enabled"))
    throw new HandBackToRails("a product with covers, variants or a refund policy to rebuild as of the purchase");

  const config = {
    host: chain.request.host,
    hostWithPort: chain.request.hostWithPort,
    protocol: chain.request.protocol,
  };
  const user = railsLoggedInUser(chain.auth.context);
  const viewer = viewerOf(
    query,
    null,
    user,
    user ? await loadSellerContext(chain.auth.context) : null,
    remoteIp(chain.request.headers),
    guidOf(chain.request.headers.get("cookie")),
    sellerCustomDomainUrl(false, chain.request.hostWithPort),
    config,
  );
  try {
    const props = (await productProps(product, seller, { ...viewer, queryString: chain.request.queryString })) as {
      product: Record<string, unknown>;
    } & Record<string, unknown>;
    // PurchaseProductPresenter#product_props, on top of the product page's.
    const built = {
      ...props,
      product: {
        ...props.product,
        is_compliance_blocked: false,
        has_third_party_analytics: false,
        ppp_details: null,
        can_edit: false,
        refund_policy: null,
      },
      discount_code: null,
      purchase: null,
      custom_styles: await sellerCustomStyles(seller as unknown as Parameters<typeof sellerCustomStyles>[0]),
    };
    return { state: { [STATE_KEY]: built } };
  } catch (error) {
    if (error instanceof NotPortedError) throw new HandBackToRails(error.message);
    throw error;
  }
}

export const purchaseProductPage: PageSpec = {
  component: "Purchases/Product/Show",
  options: { filters: productFilters },
  props: (_params, action) => {
    const built = action.state[STATE_KEY] as Record<string, unknown> | undefined;
    if (built === undefined) throw new HandBackToRails("the purchase product page without its filter chain");
    return built;
  },
};
