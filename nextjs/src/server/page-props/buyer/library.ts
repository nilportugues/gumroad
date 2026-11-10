// Port of app/presenters/library_presenter.rb: LibraryPresenter#library_props for LibraryController#index.
// Memberships that still grant access, installment plans and bundles (member rows replace the bundle row)
// are served here, a refunded subscription row linking to the buyer's latest paid renewal (library_download_location).
// A request for the subscriptions tab (status labels, billing-only cards) or a bundle filter that resolves
// to a bundle purchase with a download page (ZIP archives) goes to Rails whole (HandBackToRails).
import { Prisma, type Link, type Purchase, type User } from "@prisma/client";

import { db } from "../../../lib/db.ts";
import { decrypt, encrypt } from "../../../lib/obfuscate-ids.ts";
import { HandBackToRails } from "../../controllers/application-controller.ts";
import { grantsAccess } from "../../controllers/url-redirects/access.ts";
import { LinkFlags } from "../../models/link.ts";
import { castRow, column, selectRows, table } from "../../models/sql.ts";
import { SubscriptionFlags } from "../../models/subscription.ts";
import { PurchaseFlags } from "../../search/flags.ts";
import { domainConfig } from "../domain.ts";

import { thumbnailOrCoverUrl } from "./products.ts";
import { avatarUrl, profileUrl } from "./users.ts";

const PURCHASES = "purchases";
const LINKS = "links";
// LibraryPresenter::PER_PAGE
const PER_PAGE = 15;
const LIBRARY_RECOMMENDER = "library";
const SUCCESS_STATES = [
  "preorder_authorization_successful",
  "successful",
  "not_charged",
  "gift_receiver_purchase_successful",
];

export type LibraryParams = {
  page: string;
  sort: string;
  query: string;
  creators: string;
  bundles: string;
  showArchivedOnly: boolean;
  subscriptionsOnly: boolean;
};

const flag = (name: Parameters<typeof PurchaseFlags.condition>[0], enabled: boolean) =>
  PurchaseFlags.condition(name, enabled);

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

// `bundle_ids.filter_map { Link.from_external_id(_1) }`
const bundleLinkIds = (bundleIds: string[]) => bundleIds.flatMap((id) => decrypt(id) ?? []);

// Whether the port can answer. The controller's filter asks before the page renders, since a page
// that is rendering cannot hand the request back.
export async function assertLibrarySupported(
  userId: bigint,
  params: Pick<LibraryParams, "bundles" | "subscriptionsOnly">,
): Promise<void> {
  if (params.subscriptionsOnly) throw new HandBackToRails();
  const base = visibleInLibrary(userId);
  const linkIds = bundleLinkIds(rubySplitComma(params.bundles));
  if (linkIds.length === 0) return;
  // bundle_downloads: the ZIP archive state is not ported, so a bundle with a download page hands back.
  const downloads = await selectRows(
    Prisma.sql`SELECT 1 FROM ${table(PURCHASES)} INNER JOIN ${table("url_redirects")} ON url_redirects.purchase_id = purchases.id WHERE ${base} AND ${flag("is_bundle_purchase", true)} AND ${column(PURCHASES, "link_id")} IN (${Prisma.join(linkIds)}) LIMIT 1`,
  );
  if (downloads.length > 0) throw new HandBackToRails();
}

type RenewalCandidate = { subscription_id: bigint; link_id: bigint; purchase_state: string; token: string | null };

// The first candidate (already ordered succeeded_at DESC, id DESC) that is in the subscription's
// successful state and has a download page.
export function pickReplacementToken(candidates: RenewalCandidate[], successfulState: string): string | null {
  return candidates.find((candidate) => candidate.purchase_state === successfulState && candidate.token)?.token ?? null;
}

// `replacement_redirects_for`: a refunded original (or gift receiver) row links to the viewer's own
// latest paid renewal instead of its own download page. Keyed by purchase id; null when none exists.
export async function replacementTokens(userId: bigint, purchases: Purchase[]): Promise<Map<bigint, string | null>> {
  const refunded = purchases.filter(
    (purchase) =>
      purchase.stripe_refunded === true &&
      purchase.subscription_id !== null &&
      (PurchaseFlags.isSet(purchase.flags, "is_original_subscription_purchase") ||
        PurchaseFlags.isSet(purchase.flags, "is_gift_receiver_purchase")),
  );
  const tokens = new Map<bigint, string | null>();
  if (refunded.length === 0) return tokens;
  const pairs = new Map(refunded.map((purchase) => [`${purchase.subscription_id}:${purchase.link_id}`, purchase]));
  const pairConditions = [...pairs.values()].map(
    (purchase) =>
      Prisma.sql`(${column(PURCHASES, "subscription_id")} = ${purchase.subscription_id} AND ${column(PURCHASES, "link_id")} = ${purchase.link_id})`,
  );
  // Only the viewer's own renewals qualify: UrlRedirectsController#check_permissions authorizes against the
  // rendered purchase's purchaser, so another owner's renewal would bounce the viewer to verification.
  const candidates = await selectRows<RenewalCandidate>(
    Prisma.sql`SELECT ${column(PURCHASES, "subscription_id")} AS subscription_id, ${column(PURCHASES, "link_id")} AS link_id, ${column(PURCHASES, "purchase_state")} AS purchase_state, (SELECT url_redirects.token FROM ${table("url_redirects")} WHERE url_redirects.purchase_id = purchases.id ORDER BY url_redirects.id ASC LIMIT 1) AS token FROM ${table(PURCHASES)} WHERE (${Prisma.join(pairConditions, " OR ")}) AND ${column(PURCHASES, "purchaser_id")} = ${userId} AND ${column(PURCHASES, "purchase_state")} IN ('successful', 'test_successful') AND (purchases.stripe_refunded IS NULL OR purchases.stripe_refunded = 0) AND (purchases.chargeback_date IS NULL OR ${flag("chargeback_reversed", true)}) AND ${flag("is_access_revoked", false)} AND ${flag("is_original_subscription_purchase", false)} AND ${flag("is_gift_receiver_purchase", false)} ORDER BY ${column(PURCHASES, "succeeded_at")} DESC, ${column(PURCHASES, "id")} DESC`,
  );
  const subscriptionIds = [...new Set(refunded.flatMap((purchase) => purchase.subscription_id ?? []))];
  const subscriptions = await selectRows<{ id: bigint; flags: bigint | number }>(
    Prisma.sql`SELECT ${column("subscriptions", "id")} AS id, ${column("subscriptions", "flags")} AS flags FROM ${table("subscriptions")} WHERE ${column("subscriptions", "id")} IN (${Prisma.join(subscriptionIds)})`,
  );
  const testSubscriptions = new Set(
    subscriptions
      .filter((subscription) => SubscriptionFlags.isSet(subscription.flags, "is_test_subscription"))
      .map((subscription) => BigInt(subscription.id)),
  );
  for (const purchase of refunded) {
    const matching = candidates.filter(
      (candidate) =>
        BigInt(candidate.subscription_id) === purchase.subscription_id &&
        BigInt(candidate.link_id) === purchase.link_id,
    );
    const state = testSubscriptions.has(purchase.subscription_id!) ? "test_successful" : "successful";
    tokens.set(purchase.id, pickReplacementToken(matching, state));
  }
  return tokens;
}

// `no_access_membership_purchase_ids`: a purchase whose subscription row is missing stays visible.
async function noAccessMembershipPurchaseIds(base: Prisma.Sql): Promise<bigint[]> {
  const pairs = await selectRows<{ id: bigint; subscription_id: bigint | null }>(
    Prisma.sql`SELECT ${column(PURCHASES, "id")} AS id, ${column(PURCHASES, "subscription_id")} AS subscription_id FROM ${table(PURCHASES)} INNER JOIN ${table(LINKS)} ON ${column(LINKS, "id")} = ${column(PURCHASES, "link_id")} WHERE ${base} AND ${LinkFlags.condition("is_recurring_billing", true)} ORDER BY ${column(PURCHASES, "id")} ASC`,
  );
  if (pairs.length === 0) return [];
  const subscriptionIds = [...new Set(pairs.flatMap((pair) => pair.subscription_id ?? []))];
  const subscriptions = new Map(
    (await db.subscription.findMany({ where: { id: { in: subscriptionIds } } })).map((subscription) => [
      subscription.id,
      subscription,
    ]),
  );
  const linkIds = [...new Set([...subscriptions.values()].flatMap((subscription) => subscription.link_id ?? []))];
  const links = new Map((await db.link.findMany({ where: { id: { in: linkIds } } })).map((link) => [link.id, link]));
  const now = new Date();
  return pairs.flatMap((pair) => {
    const subscription = pair.subscription_id === null ? undefined : subscriptions.get(pair.subscription_id);
    if (!subscription) return [];
    return grantsAccess(
      subscription,
      subscription.link_id === null ? null : (links.get(subscription.link_id) ?? null),
      now,
    )
      ? []
      : [pair.id];
  });
}

// `replaced_bundle_purchase_ids`: a bundle row is dropped only when one of its member rows is in the library.
async function replacedBundlePurchaseIds(base: Prisma.Sql): Promise<bigint[]> {
  const bundles = await selectRows<{ id: bigint }>(
    Prisma.sql`SELECT ${column(PURCHASES, "id")} AS id FROM ${table(PURCHASES)} WHERE ${base} AND ${flag("is_bundle_purchase", true)}`,
  );
  if (bundles.length === 0) return [];
  const rows = await selectRows<{ bundle_purchase_id: bigint }>(
    Prisma.sql`SELECT DISTINCT bundle_purchase_id FROM ${table("bundle_product_purchases")} WHERE bundle_purchase_id IN (${Prisma.join(bundles.map((row) => row.id))}) AND product_purchase_id IN (SELECT purchases.id FROM ${table(PURCHASES)} WHERE ${base})`,
  );
  return rows.map((row) => row.bundle_purchase_id);
}

const notIn = (ids: bigint[]) =>
  ids.length === 0 ? Prisma.sql`1 = 1` : Prisma.sql`${column(PURCHASES, "id")} NOT IN (${Prisma.join(ids)})`;

// `bundle_filter_options`
async function bundleFilterOptions(base: Prisma.Sql, replacedIds: bigint[]) {
  if (replacedIds.length === 0) return [];
  const rows = await selectRows<{ link_id: bigint }>(
    Prisma.sql`SELECT ${column(PURCHASES, "link_id")} AS link_id FROM ${table(PURCHASES)} WHERE ${base} AND ${column(PURCHASES, "id")} IN (${Prisma.join(replacedIds)}) ORDER BY ${column(PURCHASES, "id")} DESC`,
  );
  const linkIds = [...new Set(rows.map((row) => row.link_id))];
  const links = new Map((await db.link.findMany({ where: { id: { in: linkIds } } })).map((link) => [link.id, link]));
  return linkIds.flatMap((id) => {
    const link = links.get(id);
    return link ? [{ id: encrypt(link.id), label: link.name }] : [];
  });
}

export async function libraryProps(user: User, params: LibraryParams) {
  const sort = params.sort === "purchase_date" ? "purchase_date" : "recently_updated";
  const creatorIds = rubySplitComma(params.creators);
  const bundleIds = rubySplitComma(params.bundles);
  const base = visibleInLibrary(user.id);
  const replacedIds = await replacedBundlePurchaseIds(base);
  const visible = Prisma.sql`${base} AND ${notIn(await noAccessMembershipPurchaseIds(base))}`;
  const cards = Prisma.sql`${visible} AND ${notIn(replacedIds)}`;

  const archivedCount = await count(
    Prisma.sql`SELECT COUNT(*) AS count FROM ${table(PURCHASES)} WHERE ${visible} AND ${flag("is_archived", true)}`,
  );
  const unarchivedCount = await count(
    Prisma.sql`SELECT COUNT(*) AS count FROM ${table(PURCHASES)} WHERE ${visible} AND ${flag("is_archived", false)}`,
  );

  // The filters, over the archive partition of the library.
  const conditions: Prisma.Sql[] = [cards, flag("is_archived", params.showArchivedOnly)];
  let joins = Prisma.empty;
  let linkJoined = false;
  const joinLink = () => {
    if (linkJoined) return;
    linkJoined = true;
    joins = Prisma.sql`${joins} INNER JOIN ${table(LINKS)} ON ${column(LINKS, "id")} = ${column(PURCHASES, "link_id")}`;
  };
  if (creatorIds.length > 0) {
    const creatorUserIds = (
      await db.user.findMany({ where: { external_id: { in: creatorIds } }, select: { id: true } })
    ).map((row) => row.id);
    joinLink();
    conditions.push(
      creatorUserIds.length === 0
        ? Prisma.sql`1 = 0`
        : Prisma.sql`${column(LINKS, "user_id")} IN (${Prisma.join(creatorUserIds)})`,
    );
  }
  if (bundleIds.length > 0) {
    const linkIds = bundleLinkIds(bundleIds);
    conditions.push(
      linkIds.length === 0
        ? Prisma.sql`1 = 0`
        : Prisma.sql`purchases.id IN (SELECT bpp.product_purchase_id FROM ${table("bundle_product_purchases")} bpp INNER JOIN ${table(PURCHASES)} bundle ON bundle.id = bpp.bundle_purchase_id WHERE bundle.link_id IN (${Prisma.join(linkIds)}))`,
    );
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
    if (!linkJoined)
      orderedJoins = Prisma.sql`${joins} INNER JOIN ${table(LINKS)} ON ${column(LINKS, "id")} = ${column(PURCHASES, "link_id")}`;
    order = Prisma.sql`ORDER BY COALESCE(links.content_updated_at, links.created_at) DESC, ${column(PURCHASES, "id")} DESC`;
  }
  const pageRows = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`purchases`.*")} FROM ${table(PURCHASES)}${orderedJoins} WHERE ${where} ${order} LIMIT ${PER_PAGE} OFFSET ${offset}`,
  );
  const purchases = pageRows.map((row) => castRow<Purchase>("Purchase", row));

  return {
    results: await buildCards(user.id, purchases),
    pagination: {
      page,
      pages,
      from: Math.min(offset + 1, total),
      to: Math.min(offset + purchases.length, total),
      count: total,
    },
    creators: await creatorsForTab(cards, params.showArchivedOnly),
    bundles: await bundleFilterOptions(base, replacedIds),
    // assertLibrarySupported hands back whenever the selected bundles have a download page.
    bundle_downloads: [],
    archived_count: archivedCount,
    unarchived_count: unarchivedCount,
    search: {
      sort,
      query: params.query,
      creators: creatorIds,
      bundles: bundleIds,
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
const creatorName = (creator: User) =>
  creator.name ?? (creator.username && creator.username.trim() !== "" ? creator.username : creator.external_id);

async function creatorsForTab(base: Prisma.Sql, showArchivedOnly: boolean) {
  const rows = await selectRows<{ user_id: bigint; count: bigint }>(
    Prisma.sql`SELECT ${column(LINKS, "user_id")} AS user_id, COUNT(*) AS count FROM ${table(PURCHASES)} INNER JOIN ${table(LINKS)} ON ${column(LINKS, "id")} = ${column(PURCHASES, "link_id")} WHERE ${base} AND ${flag("is_archived", showArchivedOnly)} GROUP BY ${column(LINKS, "user_id")}`,
  );
  const counts = new Map(rows.map((row) => [row.user_id, Number(row.count)]));
  const creators = await db.user.findMany({ where: { id: { in: [...counts.keys()] } }, orderBy: { id: "asc" } });
  return creators.map((creator) => ({
    id: creator.external_id,
    name: creatorName(creator),
    count: counts.get(creator.id),
  }));
}

async function buildCards(userId: bigint, purchases: Purchase[]) {
  const replacements = await replacementTokens(userId, purchases);
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
    // library_download_location: a refunded row has no page of its own.
    const downloadToken = purchase.stripe_refunded
      ? (replacements.get(purchase.id) ?? null)
      : (redirect?.token ?? null);
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
        download_url: downloadToken ? `${config.protocol}://${config.domain}/d/${downloadToken}` : null,
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
