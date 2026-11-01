// WidgetPresenter#widget_props for PublicController#widgets.
import type { User } from "@prisma/client";
import { Prisma } from "@prisma/client";

import { railsMessageVerifierGenerate } from "../auth/message-verifier.ts";
import { column, selectRows, table } from "../models/sql.ts";
import { subdomainWithProtocol, Users } from "../models/user.ts";
import { domainConfig } from "./domain.ts";
import { NotPortedError } from "./not-ported.ts";

// Link::ANALYTICS_SCRIPT_TOKEN_PURPOSE and Link.analytics_view_verifier
const ANALYTICS_SCRIPT_TOKEN_PURPOSE = "external_landing_page_script";
const ANALYTICS_VERIFIER_NAME = "product_analytics_view";
const DEMO_PERMALINK = "demo";

type ProductRow = { id: bigint; name: string | null; custom_permalink: string | null; unique_permalink: string; user_id: bigint };

const PRODUCT_COLUMNS = Prisma.raw(["id", "name", "custom_permalink", "unique_permalink", "user_id"].map((name) => `\`links\`.\`${name}\``).join(", "));

const rootDomainWithProtocol = () => {
  const config = domainConfig(process.env);
  return `${config.protocol}://${config.rootDomain}`;
};

// Link.fetch("demo"): `Link.visible.find_by(unique_permalink:)`.
async function demoProducts(): Promise<ProductRow[]> {
  return selectRows<ProductRow>(
    Prisma.sql`SELECT ${PRODUCT_COLUMNS} FROM ${table("links")} WHERE ${column("links", "deleted_at")} IS NULL AND ${column("links", "unique_permalink")} = ${DEMO_PERMALINK} LIMIT 1`,
  );
}

// `seller.links.alive.order(created_at: :desc)`
const sellerProducts = (sellerId: bigint) =>
  selectRows<ProductRow>(
    Prisma.sql`SELECT ${PRODUCT_COLUMNS} FROM ${table("links")} WHERE ${column("links", "user_id")} = ${sellerId} AND ${column("links", "purchase_disabled_at")} IS NULL AND ${column("links", "banned_at")} IS NULL AND ${column("links", "deleted_at")} IS NULL ORDER BY ${column("links", "created_at")} DESC`,
  );

async function hasAffiliatedProducts(sellerId: bigint): Promise<boolean> {
  const rows = await selectRows(
    Prisma.sql`SELECT 1 FROM ${table("links")} LEFT OUTER JOIN ${table("affiliates_links")} ON ${column("affiliates_links", "link_id")} = ${column("links", "id")} LEFT OUTER JOIN ${table("affiliates")} ON ${column("affiliates", "id")} = ${column("affiliates_links", "affiliate_id")} AND ${column("affiliates", "type")} = 'DirectAffiliate' WHERE ${column("affiliates", "deleted_at")} IS NULL AND ${column("links", "purchase_disabled_at")} IS NULL AND ${column("links", "banned_at")} IS NULL AND ${column("links", "deleted_at")} IS NULL AND ${column("affiliates", "affiliate_user_id")} = ${sellerId} LIMIT 1`,
  );
  return rows.length > 0;
}

const generalPermalink = (product: ProductRow) => (product.custom_permalink ? product.custom_permalink : product.unique_permalink);

async function userRow(id: bigint): Promise<User> {
  const { db } = await import("../../lib/db.ts");
  return db.user.findUniqueOrThrow({ where: { id } });
}

export async function widgetProps(seller: User | null): Promise<Record<string, unknown>> {
  let ownProducts: ProductRow[] = [];
  let sellerBase = rootDomainWithProtocol();
  if (seller) {
    // UrlService.widget_script_base_url / widget_product_link_base_url consult the seller's custom
    // domain, which needs a DNS and certificate check.
    const customDomain = await selectRows(Prisma.sql`SELECT 1 FROM ${table("custom_domains")} WHERE ${column("custom_domains", "user_id")} = ${seller.id} AND ${column("custom_domains", "deleted_at")} IS NULL LIMIT 1`);
    if (customDomain.length > 0 && process.env.RAILS_ENV !== "development") throw new NotPortedError("Widgets for a seller with a custom domain (CustomDomainVerificationService DNS check)");
    // Referral URLs are built from the affiliate's permalink.
    if (await hasAffiliatedProducts(seller.id)) throw new NotPortedError("Widgets for a seller with affiliated products (Affiliate#referral_url_for_product)");
    ownProducts = await sellerProducts(seller.id);
    sellerBase = subdomainWithProtocol(Users.load(seller)) ?? sellerBase;
  }
  const products = seller && ownProducts.length > 0 ? ownProducts : await demoProducts();
  const defaultProduct = products[0];
  // WidgetPresenter#product_props(nil) raises NoMethodError when there is no demo product.
  if (!defaultProduct) throw new Error("undefined method 'name' for nil");

  const productProps = async (product: ProductRow) => {
    // A product that is not the seller's (the demo product) links to its own seller's host.
    const base = seller && product.user_id === seller.id ? sellerBase : (subdomainWithProtocol(Users.load(await userRow(product.user_id))) ?? `${domainConfig(process.env).protocol}://${domainConfig(process.env).domain}`);
    const url = `${base}/l/${generalPermalink(product)}`;
    return {
      name: product.name,
      script_base_url: rootDomainWithProtocol(),
      analytics_script_token: railsMessageVerifierGenerate(ANALYTICS_VERIFIER_NAME, { product_id: Number(product.id) }, ANALYTICS_SCRIPT_TOKEN_PURPOSE),
      url,
      gumroad_domain_url: url,
    };
  };

  return {
    display_product_select: seller !== null,
    products: await Promise.all(products.map(productProps)),
    affiliated_products: [],
    default_product: await productProps(defaultProduct),
  };
}
