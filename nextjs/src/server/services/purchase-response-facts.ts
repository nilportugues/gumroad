// The reads behind Purchase#purchase_response for a plain free purchase, in the order Order::ChargeService's
// `ensure_all_purchases_processed` makes them (purchase-create.golden.json, after ActivateIntegrationsWorker is pushed).
// `purchaseResponse` renders the facts; a purchase that has any of the rows a plain free one lacks (a presentment, a shipment,
// an enabled integration, an affiliate credit, a custom field) is handed back, since the response renders none of them.
import { Prisma, type Link, type Purchase, type UrlRedirect, type User } from "@prisma/client";

import { ProductFileFlags } from "../models/product-file.ts";
import { INTEGRATION_NAMES, type PurchaseResponseFacts } from "../models/purchase-response.ts";
import { column, selectRows, table } from "../models/sql.ts";
import { NotPortedError } from "../models/user.ts";

const star = (name: string) => Prisma.raw(`\`${name}\`.*`);

const notPorted = (what: string) => new NotPortedError(`The purchase response with ${what}`, "app/models/purchase.rb");

// Integration subclass names (Integration::ALL_NAMES, `class_for(name)`)
const INTEGRATION_TYPES: Record<(typeof INTEGRATION_NAMES)[number], string> = {
  circle: "CircleIntegration",
  discord: "DiscordIntegration",
  zoom: "ZoomIntegration",
  google_calendar: "GoogleCalendarIntegration",
};

export type ResponseFactsInput = {
  purchase: Purchase;
  link: Link;
  seller: User;
  purchaser: User | null;
  urlRedirect: UrlRedirect | null;
  urlParameters?: Record<string, unknown> | null;
};

export async function loadPurchaseResponseFacts(input: ResponseFactsInput): Promise<PurchaseResponseFacts> {
  const { purchase, link, seller } = input;

  // link.has_stampable_pdfs?: the alive files, in position order
  const files = await selectRows<{ filetype: string | null; flags: bigint | number }>(
    Prisma.sql`SELECT ${star("product_files")} FROM ${table("product_files")} WHERE ${column("product_files", "link_id")} = ${link.id} AND ${column("product_files", "deleted_at")} IS NULL ORDER BY ${column("product_files", "position")} ASC`,
  );
  const hasStampablePdfs = files.some(
    (file) => file.filetype === "pdf" && ProductFileFlags.isSet(BigInt(file.flags), "pdf_stamp_enabled"),
  );
  // link.has_files?
  const hasFiles =
    (
      await selectRows(
        Prisma.sql`SELECT 1 AS one FROM ${table("product_files")} WHERE ${column("product_files", "link_id")} = ${link.id} AND ${column("product_files", "deleted_at")} IS NULL LIMIT 1`,
      )
    ).length > 0;
  // purchase.purchase_presentment
  const presentments = await selectRows(
    Prisma.sql`SELECT ${star("purchase_presentments")} FROM ${table("purchase_presentments")} WHERE ${column("purchase_presentments", "purchase_id")} = ${purchase.id} LIMIT 1`,
  );
  if (presentments.length > 0) throw notPorted("a presentment");
  // is_following?: Follower.active.where(email:, followed_id:).exists?
  const isFollowing =
    (
      await selectRows(
        Prisma.sql`SELECT 1 AS one FROM ${table("followers")} WHERE ${column("followers", "deleted_at")} IS NULL AND ${column("followers", "confirmed_at")} IS NOT NULL AND ${column("followers", "email")} = ${purchase.email} AND ${column("followers", "followed_id")} = ${seller.id} LIMIT 1`,
      )
    ).length > 0;
  // link.has_third_party_analytics?("receipt"): the product's, then the seller's universal ones
  const locations = Prisma.join(["receipt", "all"], ", ");
  let hasThirdPartyAnalytics =
    (
      await selectRows(
        Prisma.sql`SELECT ${star("third_party_analytics")} FROM ${table("third_party_analytics")} WHERE ${column("third_party_analytics", "link_id")} = ${link.id} AND ${column("third_party_analytics", "deleted_at")} IS NULL AND ${column("third_party_analytics", "location")} IN (${locations})`,
      )
    ).length > 0;
  if (!hasThirdPartyAnalytics)
    hasThirdPartyAnalytics =
      (
        await selectRows(
          Prisma.sql`SELECT ${star("third_party_analytics")} FROM ${table("third_party_analytics")} WHERE ${column("third_party_analytics", "user_id")} = ${seller.id} AND (link_id is null) AND ${column("third_party_analytics", "deleted_at")} IS NULL AND ${column("third_party_analytics", "location")} IN (${locations})`,
        )
      ).length > 0;
  // purchase.shipment
  const shipments = await selectRows(
    Prisma.sql`SELECT ${star("shipments")} FROM ${table("shipments")} WHERE ${column("shipments", "purchase_id")} = ${purchase.id} LIMIT 1`,
  );
  if (shipments.length > 0) throw notPorted("a shipment");
  // Integration.enabled_integrations_for(purchase): the product's integration of each kind
  const enabledIntegrations = {} as PurchaseResponseFacts["enabledIntegrations"];
  for (const name of INTEGRATION_NAMES) {
    const integrations = await selectRows(
      Prisma.sql`SELECT ${star("integrations")} FROM ${table("integrations")} INNER JOIN ${table("product_integrations")} ON ${column("integrations", "id")} = ${column("product_integrations", "integration_id")} WHERE ${column("product_integrations", "product_id")} = ${link.id} AND ${column("product_integrations", "deleted_at")} IS NULL AND ${column("integrations", "type")} = ${INTEGRATION_TYPES[name]} ORDER BY ${column("integrations", "id")} ASC LIMIT 1`,
    );
    if (integrations.length > 0) throw notPorted("an integration");
    enabledIntegrations[name] = false;
  }
  // variants_list: the product's tiers
  await selectRows(
    Prisma.sql`SELECT COUNT(*) FROM ${table("base_variants")} INNER JOIN ${table("variant_categories")} ON ${column("base_variants", "variant_category_id")} = ${column("variant_categories", "id")} WHERE ${column("base_variants", "type")} = ${"Variant"} AND ${column("variant_categories", "link_id")} = ${link.id} AND ${column("variant_categories", "deleted_at")} IS NULL AND ${column("variant_categories", "title")} = ${"Tier"} AND ${column("base_variants", "deleted_at")} IS NULL`,
  );
  // purchase.affiliate_credit
  const credits = await selectRows(
    Prisma.sql`SELECT ${star("affiliate_credits")} FROM ${table("affiliate_credits")} WHERE ${column("affiliate_credits", "purchase_id")} = ${purchase.id} AND ${column("affiliate_credits", "is_direct_affiliate_credit")} = FALSE LIMIT 1`,
  );
  if (credits.length > 0) throw notPorted("an affiliate credit");
  // purchase.purchase_custom_fields
  const customFields = await selectRows(
    Prisma.sql`SELECT ${star("purchase_custom_fields")} FROM ${table("purchase_custom_fields")} WHERE ${column("purchase_custom_fields", "purchase_id")} = ${purchase.id}`,
  );
  if (customFields.length > 0) throw notPorted("custom fields");

  return {
    purchase,
    link,
    seller,
    purchaser: input.purchaser,
    urlRedirect: input.urlRedirect,
    hasFiles,
    hasStampablePdfs,
    isFollowing,
    hasThirdPartyAnalytics,
    enabledIntegrations,
    urlParameters: input.urlParameters ?? null,
  };
}
