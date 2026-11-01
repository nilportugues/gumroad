// LibraryPresenter#library_props for LibraryController#index, for a library of one-time purchases.
// A buyer whose library holds a membership or installment plan (subscription labels, no-access
// filtering, billing-only cards), a bundle (replaced rows, ZIP downloads), or a request that asks for
// the subscriptions tab, a bundle filter or purchase analytics, goes to Rails whole (HandBackToRails).
import { Prisma, type Link, type Purchase, type User } from "@prisma/client";

import { db } from "../../../lib/db.ts";
import { encrypt } from "../../../lib/obfuscate-ids.ts";
import { HandBackToRails } from "../../controllers/application-controller.ts";
import { LinkFlags } from "../../models/link.ts";
import { castRow, column, selectRows, table } from "../../models/sql.ts";
import { PurchaseFlags } from "../../search/flags.ts";
import { domainConfig } from "../domain.ts";
import { thumbnailOrCoverUrl } from "./products.ts";
import { avatarUrl, profileUrl } from "./users.ts";

const PURCHASES = "purchases";
const LINKS = "links";
// LibraryPresenter::PER_PAGE
const PER_PAGE = 15;
const LIBRARY_RECOMMENDER = "library";
const SUCCESS_STATES = ["preorder_authorization_successful", "successful", "not_charged", "gift_receiver_purchase_successful"];

export type LibraryParams = {
  page: string;
  sort: string;
  query: string;
  creators: string;
  bundles: string;
  showArchivedOnly: boolean;
  subscriptionsOnly: boolean;
};

const flag = (name: Parameters<typeof PurchaseFlags.condition>[0], enabled: boolean) => PurchaseFlags.condition(name, enabled);

// `Purchase.visible_in_library`, for one purchaser.
const visibleInLibrary = (userId: bigint) => Prisma.sql`${column(PURCHASES, "purchaser_id")} = ${userId}
  AND ${column(PURCHASES, "purchase_state")} IN (${Prisma.join(SUCCESS_STATES)})
  AND ${flag("is_additional_contribution", false)}
  AND (purchases.subscription_id IS NULL OR ${flag("is_original_subscription_purchase", true)} OR ${flag("is_gift_receiver_purchase", true)})
  AND ${flag("is_gift_sender_purchase", false)}
  AND ((purchases.subscription_id IS NULL AND (purchases.stripe_refunded IS NULL OR purchases.stripe_refunded = 0)) OR purchases.subscription_id IS NOT NULL)
  AND (purchases.chargeback_date IS NULL OR (purchases.chargeback_date IS NOT NULL AND ${flag("chargeback_reversed", true)}))
  AND ${flag("is_archived_original_subscription_purchase", false)}
  AND ${flag("is_access_revoked", false)}
  AND (purchases.rental_expired = 0 OR purchases.rental_expired IS NULL)
  AND ${flag("is_deleted_by_buyer", false)}`;

// Ruby's String#split(","): no trailing empty fields, and no fields at all for an empty string.
export function rubySplitComma(value: string): string[] {
  const fields = value.split(",");
  while (fields.length > 0 && fields.at(-1) === "") fields.pop();
  return fields;
}

// Integer("12abc") style `to_i`: leading digits, else 0.
const rubyToI = (value: string) => Number.parseInt(/^\s*[+-]?\d+/.exec(value)?.[0] ?? "0", 10) || 0;

// Whether the port can answer. The controller's filter asks before the page renders, since a page
// that is rendering cannot hand the request back.
export async function assertLibrarySupported(userId: bigint, params: Pick<LibraryParams, "bundles" | "subscriptionsOnly">): Promise<void> {
  if (params.subscriptionsOnly || rubySplitComma(params.bundles).length > 0) throw new HandBackToRails();
  const rows = await selectRows(
    Prisma.sql`SELECT 1 FROM ${table(PURCHASES)} INNER JOIN ${table(LINKS)} ON ${column(LINKS, "id")} = ${column(PURCHASES, "link_id")} WHERE ${visibleInLibrary(userId)} AND (purchases.subscription_id IS NOT NULL OR ${LinkFlags.condition("is_recurring_billing", true)} OR ${flag("is_bundle_purchase", true)}) LIMIT 1`,
  );
  if (rows.length > 0) throw new HandBackToRails();
}

export async function libraryProps(user: User, params: LibraryParams) {
  const sort = params.sort === "purchase_date" ? "purchase_date" : "recently_updated";
  const creatorIds = rubySplitComma(params.creators);
  const base = visibleInLibrary(user.id);

  const archivedCount = await count(Prisma.sql`SELECT COUNT(*) AS count FROM ${table(PURCHASES)} WHERE ${base} AND ${flag("is_archived", true)}`);
  const unarchivedCount = await count(Prisma.sql`SELECT COUNT(*) AS count FROM ${table(PURCHASES)} WHERE ${base} AND ${flag("is_archived", false)}`);

  // The filters, over the archive partition of the library.
  const conditions: Prisma.Sql[] = [base, flag("is_archived", params.showArchivedOnly)];
  let joins = Prisma.empty;
  let linkJoined = false;
  const joinLink = () => {
    if (linkJoined) return;
    linkJoined = true;
    joins = Prisma.sql`${joins} INNER JOIN ${table(LINKS)} ON ${column(LINKS, "id")} = ${column(PURCHASES, "link_id")}`;
  };
  if (creatorIds.length > 0) {
    const creatorUserIds = (await db.user.findMany({ where: { external_id: { in: creatorIds } }, select: { id: true } })).map((row) => row.id);
    joinLink();
    conditions.push(creatorUserIds.length === 0 ? Prisma.sql`1 = 0` : Prisma.sql`${column(LINKS, "user_id")} IN (${Prisma.join(creatorUserIds)})`);
  }
  if (params.query !== "") {
    // sanitize_sql_like escapes backslash, percent and underscore with a backslash.
    const like = `%${params.query.replace(/[\\%_]/g, "\\$&")}%`;
    joinLink();
    joins = Prisma.sql`${joins} INNER JOIN ${table("users")} ON ${column("users", "id")} = ${column(LINKS, "user_id")}`;
    conditions.push(
      Prisma.sql`(${column(LINKS, "name")} LIKE ${like} OR COALESCE(${column("users", "name")}, NULLIF(${column("users", "username")}, ''), ${column("users", "external_id")}) LIKE ${like})`,
    );
  }
  const where = Prisma.join(conditions, " AND ");

  // Pagy, overflow: :last_page
  const total = await count(Prisma.sql`SELECT COUNT(*) AS count FROM ${table(PURCHASES)}${joins} WHERE ${where}`);
  const pages = Math.max(Math.ceil(total / PER_PAGE), 1);
  const page = Math.min(Math.max(rubyToI(params.page), 1), pages);
  const offset = (page - 1) * PER_PAGE;

  let orderedJoins = joins;
  let order: Prisma.Sql;
  if (sort === "purchase_date") {
    order = Prisma.sql`ORDER BY ${column(PURCHASES, "id")} DESC`;
  } else {
    if (!linkJoined) orderedJoins = Prisma.sql`${joins} INNER JOIN ${table(LINKS)} ON ${column(LINKS, "id")} = ${column(PURCHASES, "link_id")}`;
    order = Prisma.sql`ORDER BY COALESCE(links.content_updated_at, links.created_at) DESC, ${column(PURCHASES, "id")} DESC`;
  }
  const pageRows = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`purchases`.*")} FROM ${table(PURCHASES)}${orderedJoins} WHERE ${where} ${order} LIMIT ${PER_PAGE} OFFSET ${offset}`,
  );
  const purchases = pageRows.map((row) => castRow<Purchase>("Purchase", row));

  return {
    results: await buildCards(purchases),
    pagination: { page, pages, from: Math.min(offset + 1, total), to: Math.min(offset + purchases.length, total), count: total },
    creators: await creatorsForTab(base, params.showArchivedOnly),
    bundles: [],
    bundle_downloads: [],
    archived_count: archivedCount,
    unarchived_count: unarchivedCount,
    search: {
      sort,
      query: params.query,
      creators: creatorIds,
      bundles: [],
      show_archived_only: params.showArchivedOnly,
      subscriptions_only: false,
    },
  };
}

async function count(sql: Prisma.Sql): Promise<number> {
  const [row] = await selectRows<{ count: bigint }>(sql);
  return Number(row?.count ?? 0);
}

// `creator.name || creator.username || creator.external_id`, with User#username's own fallback.
const creatorName = (creator: User) => creator.name ?? (creator.username && creator.username.trim() !== "" ? creator.username : creator.external_id);

async function creatorsForTab(base: Prisma.Sql, showArchivedOnly: boolean) {
  const rows = await selectRows<{ user_id: bigint; count: bigint }>(
    Prisma.sql`SELECT ${column(LINKS, "user_id")} AS user_id, COUNT(*) AS count FROM ${table(PURCHASES)} INNER JOIN ${table(LINKS)} ON ${column(LINKS, "id")} = ${column(PURCHASES, "link_id")} WHERE ${base} AND ${flag("is_archived", showArchivedOnly)} GROUP BY ${column(LINKS, "user_id")}`,
  );
  const counts = new Map(rows.map((row) => [row.user_id, Number(row.count)]));
  const creators = await db.user.findMany({ where: { id: { in: [...counts.keys()] } }, orderBy: { id: "asc" } });
  return creators.map((creator) => ({ id: creator.external_id, name: creatorName(creator), count: counts.get(creator.id) }));
}

async function buildCards(purchases: Purchase[]) {
  const sellerData = new Map<bigint, { name: string | null; profile_url: string; avatar_url: string }>();
  const cards = [];
  for (const purchase of purchases) {
    const product: Link = await db.link.findUniqueOrThrow({ where: { id: purchase.link_id! } });
    const seller = await db.user.findUniqueOrThrow({ where: { id: product.user_id! } });
    if (!sellerData.has(seller.id)) {
      sellerData.set(seller.id, {
        name: seller.name ?? (seller.username && seller.username.trim() !== "" ? seller.username : seller.external_id),
        profile_url: profileUrl(seller, { recommendedBy: LIBRARY_RECOMMENDER }),
        avatar_url: await avatarUrl(seller),
      });
    }
    const redirect = await db.urlRedirect.findFirst({ where: { purchase_id: purchase.id }, orderBy: { id: "asc" } });
    const config = domainConfig(process.env);
    cards.push({
      product: {
        name: product.name,
        creator: sellerData.get(seller.id),
        thumbnail_url: await thumbnailOrCoverUrl(product.id),
        native_type: product.native_type,
      },
      purchase: {
        id: encrypt(purchase.id),
        is_archived: PurchaseFlags.isSet(purchase.flags, "is_archived"),
        download_url: redirect ? `${config.protocol}://${config.domain}/d/${redirect.token}` : null,
        variants: (await variantNames(purchase.id)).join(", "),
      },
    });
  }
  return cards;
}

// `purchase.variant_attributes.map(&:name)`
async function variantNames(purchaseId: bigint): Promise<string[]> {
  const rows = await selectRows<{ name: string | null }>(
    Prisma.sql`SELECT ${column("base_variants", "name")} FROM ${table("base_variants")} INNER JOIN ${table("base_variants_purchases")} ON ${column("base_variants", "id")} = ${column("base_variants_purchases", "base_variant_id")} WHERE ${column("base_variants_purchases", "purchase_id")} = ${purchaseId} ORDER BY ${column("base_variants", "id")} ASC`,
  );
  return rows.map((row) => row.name ?? "");
}
