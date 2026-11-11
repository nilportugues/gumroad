// UtmLinkPresenter, PaginatedUtmLinksPresenter and UtmLinksStatsPresenter, and the three
// UtmLinksController GET actions (index, new, edit).
import { Prisma, type User } from "@prisma/client";
import { randomBytes } from "node:crypto";

import { decrypt } from "../../../lib/obfuscate-ids.ts";

import { rubyFloatRoundDigits } from "../../models/concerns/ruby-numeric.ts";
import { column, selectRows, table } from "../../models/sql.ts";
import { domainConfig } from "../domain.ts";
import { externalId, paramToI, present, profileUrl, rackParam, shortDomainWithProtocol, stringParam, userSubdomainWithProtocol, withQueryValues, type QuerySource } from "./support.ts";

const UTM_LINKS = "utm_links";
const PER_PAGE = 100;
const PAGE_SORT_KEYS = ["link", "date", "source", "medium", "campaign", "clicks", "sales_count", "revenue_cents", "conversion_rate"];
const SORT_KEY_TO_COLUMN: Record<string, string> = {
  link: "title",
  date: "created_at",
  source: "utm_source",
  medium: "utm_medium",
  campaign: "utm_campaign",
  clicks: "unique_clicks",
  sales_count: "sales_count",
  revenue_cents: "revenue_cents",
  conversion_rate: "conversion_rate",
};
const SALES_SORT_COLUMNS = ["sales_count", "revenue_cents", "conversion_rate"];
const PERMALINK_LENGTH = 8;

export type UtmLinkRow = {
  id: bigint;
  seller_id: bigint;
  title: string;
  target_resource_type: string;
  target_resource_id: bigint | null;
  permalink: string;
  utm_campaign: string;
  utm_medium: string;
  utm_source: string;
  utm_term: string | null;
  utm_content: string | null;
  unique_clicks: number;
  created_at: Date;
  // Present when the list was sorted by sales (the presenter's grouped select).
  sales_count?: bigint | number;
  revenue_cents?: bigint | number | string;
  conversion_rate?: number | string;
};

type LinkRow = { id: number; user_id: number; unique_permalink: string; custom_permalink: string | null; name: string };
type InstallmentRow = { id: number; seller_id: number | null; link_id: number | null; name: string | null; slug: string | null };

const aliveUtmLinks = (sellerId: bigint) => Prisma.sql`${column(UTM_LINKS, "seller_id")} = ${sellerId} AND ${column(UTM_LINKS, "deleted_at")} IS NULL`;

// SecureRandom.alphanumeric(8).downcase
export function generatePermalink(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = randomBytes(PERMALINK_LENGTH * 4);
  let result = "";
  // Rejection sampling, as SecureRandom does, so every character is uniform.
  for (const byte of bytes) {
    if (byte < 248 && result.length < PERMALINK_LENGTH) result += alphabet[byte % alphabet.length];
  }
  return result.toLowerCase();
}

// The `UtmLink.exists?(permalink:)` retry loop of UtmLink.generate_permalink.
export async function generateUniquePermalink(maxRetries = 10): Promise<string> {
  let retries = 0;
  let candidate = generatePermalink();
  while ((await selectRows(Prisma.sql`SELECT 1 AS one FROM ${table(UTM_LINKS)} WHERE ${column(UTM_LINKS, "permalink")} = ${candidate} LIMIT 1`)).length > 0) {
    retries += 1;
    if (retries >= maxRetries) throw new Error(`Failed to generate unique permalink after ${maxRetries} attempts`);
    candidate = generatePermalink();
  }
  return candidate;
}

const shortUrl = (permalink: string) => `${shortDomainWithProtocol()}/u/${permalink}`;

type Seller = { row: User };

async function users(ids: number[]): Promise<Map<number, User>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const found = await selectRows<User>(Prisma.sql`SELECT * FROM ${table("users")} WHERE ${column("users", "id")} IN (${Prisma.join(unique)})`);
  return new Map(found.map((user) => [Number(user.id), user]));
}

// The product and post a page of links points at, with the owners their URLs need.
export async function targets(links: UtmLinkRow[]) {
  const ids = (type: string) => [...new Set(links.filter((link) => link.target_resource_type === type && link.target_resource_id !== null).map((link) => Number(link.target_resource_id)))];
  const productIds = ids("product_page");
  const postIds = ids("post_page");
  const products = new Map<number, LinkRow>();
  const posts = new Map<number, InstallmentRow>();
  if (productIds.length > 0) {
    for (const row of await selectRows<LinkRow>(Prisma.sql`SELECT * FROM ${table("links")} WHERE ${column("links", "id")} IN (${Prisma.join(productIds)})`)) products.set(Number(row.id), row);
  }
  if (postIds.length > 0) {
    for (const row of await selectRows<InstallmentRow>(Prisma.sql`SELECT * FROM ${table("installments")} WHERE ${column("installments", "id")} IN (${Prisma.join(postIds)})`)) posts.set(Number(row.id), row);
  }
  const owners = await users([
    ...[...products.values()].map((row) => Number(row.user_id)),
    ...[...posts.values()].filter((row) => row.seller_id !== null).map((row) => Number(row.seller_id)),
  ]);
  // Installment#user is `seller.presence || link.user`.
  const postLinks = new Map<number, LinkRow>();
  const sellerless = [...posts.values()].filter((row) => row.seller_id === null && row.link_id !== null).map((row) => Number(row.link_id));
  if (sellerless.length > 0) {
    for (const row of await selectRows<LinkRow>(Prisma.sql`SELECT * FROM ${table("links")} WHERE ${column("links", "id")} IN (${Prisma.join(sellerless)})`)) postLinks.set(Number(row.id), row);
    const more = await users([...postLinks.values()].map((row) => Number(row.user_id)));
    for (const [id, user] of more) owners.set(id, user);
  }
  return { products, posts, postLinks, owners };
}

export type Targets = Awaited<ReturnType<typeof targets>>;

// Link#long_url
function productLongUrl(product: LinkRow, { owners }: Targets): string {
  const host = userSubdomainWithProtocol(owners.get(Number(product.user_id))!) ?? `${domainConfig(process.env).protocol}://${domainConfig(process.env).domain}`;
  const permalink = present(product.custom_permalink) ? product.custom_permalink : product.unique_permalink;
  return `${host}/l/${encodeURIComponent(permalink)}`;
}

// Installment#full_url
function postFullUrl(post: InstallmentRow, { owners, postLinks }: Targets): string | null {
  if (!present(post.slug)) return null;
  const owner = post.seller_id !== null ? owners.get(Number(post.seller_id)) : owners.get(Number(postLinks.get(Number(post.link_id))?.user_id));
  const host = owner ? userSubdomainWithProtocol(owner) : null;
  if (host === null || host === undefined) throw new NotPortedInstallmentUrl();
  return `${host}/p/${encodeURIComponent(post.slug)}`;
}

class NotPortedInstallmentUrl extends Error {
  constructor() {
    super("Installment#full_url for a seller without a subdomain");
    this.name = "NotPortedError";
  }
}

type DestinationOption = { id: string; label: string; url: string | null };

// UtmLinkPresenter#destination_option
export function destinationOption(
  seller: User,
  type: string,
  resource: { product?: LinkRow; post?: InstallmentRow; targets: Targets } | null,
  addLabelPrefix: boolean,
): DestinationOption | null {
  const resourceId = type === "product_page" && resource?.product ? externalId(resource.product.id) : type === "post_page" && resource?.post ? externalId(resource.post.id) : null;
  const id = type === "profile_page" || type === "subscribe_page" ? type : [type, resourceId].filter((part) => part !== null && part !== "").join("-");
  switch (type) {
    case "product_page":
      return { id, label: `${addLabelPrefix ? "Product — " : ""}${resource?.product?.name ?? "deleted"}`, url: resource?.product ? productLongUrl(resource.product, resource.targets) : null };
    case "post_page":
      return { id, label: `${addLabelPrefix ? "Post — " : ""}${resource?.post?.name ?? "deleted"}`, url: resource?.post ? postFullUrl(resource.post, resource.targets) : null };
    case "profile_page":
      return { id, label: "Profile page", url: profileUrl(seller) };
    case "subscribe_page":
      return { id, label: "Subscribe page", url: `${userSubdomainWithProtocol(seller)}/subscribe` };
    default:
      return null;
  }
}

const emptyTargets: Targets = { products: new Map(), posts: new Map(), postLinks: new Map(), owners: new Map() };

// UtmLink#utm_url: nil when the target is gone.
export function utmUrl(seller: User, link: UtmLinkRow, resolved: Targets): string | null {
  let url: string | null;
  switch (link.target_resource_type) {
    case "profile_page":
      url = profileUrl(seller);
      break;
    case "subscribe_page":
      url = `${userSubdomainWithProtocol(seller)}/subscribe`;
      break;
    case "product_page": {
      const product = resolved.products.get(Number(link.target_resource_id));
      url = product ? productLongUrl(product, resolved) : null;
      break;
    }
    case "post_page": {
      const post = resolved.posts.get(Number(link.target_resource_id));
      url = post ? postFullUrl(post, resolved) : null;
      break;
    }
    default:
      url = null;
  }
  if (url === null) return null;
  const params: Record<string, string> = { utm_source: link.utm_source, utm_medium: link.utm_medium, utm_campaign: link.utm_campaign };
  if (present(link.utm_term)) params.utm_term = link.utm_term;
  if (present(link.utm_content)) params.utm_content = link.utm_content;
  return withQueryValues(url, params);
}

const rounded = (value: number | string) => rubyFloatRoundDigits(Number(value), 4);

// UtmLinkPresenter#utm_link_props
export function utmLinkProps(seller: User, link: UtmLinkRow, resolved: Targets): Record<string, unknown> {
  const withSales = link.sales_count !== undefined;
  const resource = (() => {
    if (link.target_resource_type === "product_page") return { product: resolved.products.get(Number(link.target_resource_id)), targets: resolved };
    if (link.target_resource_type === "post_page") return { post: resolved.posts.get(Number(link.target_resource_id)), targets: resolved };
    return { targets: resolved };
  })();
  return {
    id: externalId(link.id),
    title: link.title,
    short_url: shortUrl(link.permalink),
    utm_url: utmUrl(seller, link, resolved),
    created_at: link.created_at.toISOString().replace(/\.\d{3}Z$/u, "Z"),
    source: link.utm_source,
    medium: link.utm_medium,
    campaign: link.utm_campaign,
    term: link.utm_term,
    content: link.utm_content,
    clicks: link.unique_clicks,
    destination_option: destinationOption(seller, link.target_resource_type, resource, false),
    sales_count: withSales ? Number(link.sales_count) : null,
    revenue_cents: withSales ? Number(link.revenue_cents) : null,
    conversion_rate: withSales ? rounded(link.conversion_rate!) : null,
  };
}

// The grouped select both the sorted list and the stats presenter use.
const SALES_SELECT = Prisma.raw(
  "utm_links.*, COUNT(purchases.id) AS sales_count, COALESCE(SUM(purchases.price_cents), 0) AS revenue_cents, CASE WHEN utm_links.unique_clicks > 0 THEN LEAST(CAST(COUNT(purchases.id) AS FLOAT) / utm_links.unique_clicks, 1) ELSE 0 END AS conversion_rate",
);
const SALES_JOINS = Prisma.raw(
  "LEFT OUTER JOIN `utm_link_driven_sales` ON `utm_link_driven_sales`.`utm_link_id` = `utm_links`.`id` LEFT OUTER JOIN `purchases` ON `purchases`.`purchase_state` IN ('successful', 'preorder_authorization_successful', 'gift_receiver_purchase_successful') AND `purchases`.`id` = `utm_link_driven_sales`.`purchase_id` AND (purchases.stripe_refunded IS NULL OR purchases.stripe_refunded = 0) AND (purchases.chargeback_date IS NULL OR (purchases.chargeback_date IS NOT NULL AND purchases.flags & '512' != 0)) AND ((`purchases`.`flags` & 32 = 0))",
);

export type IndexParams = { query: string | null; page: number; sort: { key: string; direction: "asc" | "desc" } | null };

// UtmLinksController#index_params / #extract_sort_params
export function indexParams(request: QuerySource): IndexParams {
  const key = rackParam(request, "key");
  const direction = rackParam(request, "direction");
  const query = rackParam(request, "query");
  return {
    query: typeof query === "string" ? query : null,
    page: paramToI(stringParam(request, "page")),
    sort: typeof key === "string" && PAGE_SORT_KEYS.includes(key) ? { key, direction: direction === "desc" ? "desc" : "asc" } : null,
  };
}

// PaginatedUtmLinksPresenter#props
export async function paginatedUtmLinks(seller: User, params: IndexParams) {
  const query = params.query?.trim() ? params.query.trim() : null;
  const page = Math.max(params.page, 1);
  const sortKey = SORT_KEY_TO_COLUMN[params.sort?.key ?? ""] ?? SORT_KEY_TO_COLUMN.date!;
  const direction = (params.sort?.direction ?? "").toLowerCase() === "asc" ? "asc" : "desc";

  const like = `%${query}%`;
  const search = query ? Prisma.sql`(title LIKE ${like} OR utm_source LIKE ${like} OR utm_medium LIKE ${like} OR utm_campaign LIKE ${like} OR utm_term LIKE ${like} OR utm_content LIKE ${like})` : null;
  const sales = SALES_SORT_COLUMNS.includes(sortKey);
  const from = sales
    ? Prisma.sql`(SELECT ${SALES_SELECT} FROM ${table(UTM_LINKS)} ${SALES_JOINS} WHERE ${aliveUtmLinks(seller.id)} GROUP BY ${column(UTM_LINKS, "id")}) AS utm_links`
    : Prisma.sql`${table(UTM_LINKS)}`;
  // The grouped subquery is already scoped to the seller's alive links.
  const conditions = [...(sales ? [] : [aliveUtmLinks(seller.id)]), ...(search ? [search] : [])];
  const whereWithValues = conditions.length > 0 ? Prisma.sql` WHERE ${Prisma.join(conditions, " AND ")}` : Prisma.empty;

  const [counted] = await selectRows<{ count: bigint | number }>(Prisma.sql`SELECT COUNT(*) AS count FROM ${from}${whereWithValues}`);
  const total = Number(counted?.count ?? 0);
  // Pagy with overflow: :last_page
  const pages = Math.max(Math.ceil(total / PER_PAGE), 1);
  const current = Math.min(page, pages);
  const rows = await selectRows<UtmLinkRow>(
    Prisma.sql`SELECT ${table(UTM_LINKS)}.* FROM ${from}${whereWithValues} ORDER BY ${Prisma.raw(`${sortKey} ${direction}`)} LIMIT ${PER_PAGE} OFFSET ${(current - 1) * PER_PAGE}`,
  );
  const resolved = await targets(rows);
  return { utm_links: rows.map((row) => utmLinkProps(seller, row, resolved)), pagination: { pages, page: current } };
}

// UtmLinksController#fetch_utm_links_stats
export async function utmLinksStats(seller: User, ids: string | string[] | undefined) {
  const list = (Array.isArray(ids) ? ids : ids === undefined || ids === "" ? [] : [ids]).map((id) => decrypt(id)).filter((id): id is number => id !== null);
  if (list.length === 0) return {};
  const owned = await selectRows<{ id: bigint }>(Prisma.sql`SELECT ${column(UTM_LINKS, "id")} FROM ${table(UTM_LINKS)} WHERE ${column(UTM_LINKS, "seller_id")} = ${seller.id} AND ${column(UTM_LINKS, "id")} IN (${Prisma.join(list)})`);
  if (owned.length === 0) return {};
  const rows = await selectRows<UtmLinkRow>(
    Prisma.sql`SELECT ${column(UTM_LINKS, "id")}, COUNT(purchases.id) AS sales_count, COALESCE(SUM(purchases.price_cents), 0) AS revenue_cents, CASE WHEN utm_links.unique_clicks > 0 THEN LEAST(CAST(COUNT(purchases.id) AS FLOAT) / utm_links.unique_clicks, 1) ELSE 0 END AS conversion_rate FROM ${table(UTM_LINKS)} ${SALES_JOINS} WHERE ${column(UTM_LINKS, "seller_id")} = ${seller.id} AND ${column(UTM_LINKS, "id")} IN (${Prisma.join(owned.map((row) => row.id))}) GROUP BY ${column(UTM_LINKS, "id")}`,
  );
  return Object.fromEntries(
    rows.map((row) => [externalId(row.id), { sales_count: Number(row.sales_count), revenue_cents: Number(row.revenue_cents), conversion_rate: rounded(row.conversion_rate!) }]),
  );
}

// UtmLinkPresenter#utm_link_form_context_props
async function formContext(seller: User, link: UtmLinkRow | null) {
  const products = await selectRows<LinkRow & { deleted_at: Date | null }>(
    Prisma.sql`SELECT * FROM ${table("links")} WHERE ${column("links", "user_id")} = ${seller.id} AND ${column("links", "purchase_disabled_at")} IS NULL AND ${column("links", "banned_at")} IS NULL AND ${column("links", "deleted_at")} IS NULL ORDER BY ${column("links", "name")} ASC`,
  );
  // `seller.products.alive`: Link.alive is not deleted and not banned.
  const posts = await selectRows<InstallmentRow>(
    Prisma.sql`SELECT * FROM ${table("installments")} WHERE ${column("installments", "seller_id")} = ${seller.id} AND ${column("installments", "installment_type")} = 'audience' AND (${column("installments", "flags")} & 128) > 0 AND ${column("installments", "workflow_id")} IS NULL AND ${column("installments", "published_at")} IS NOT NULL AND ${column("installments", "deleted_at")} IS NULL ORDER BY ${column("installments", "name")} ASC`,
  );
  const resolved: Targets = { ...emptyTargets, products: new Map(products.map((product) => [Number(product.id), product])), posts: new Map(posts.map((post) => [Number(post.id), post])), owners: new Map([[Number(seller.id), seller]]) };
  const fields = await selectRows<{ utm_campaign: string | null; utm_medium: string | null; utm_source: string | null; utm_term: string | null; utm_content: string | null }>(
    Prisma.sql`SELECT utm_campaign, utm_medium, utm_source, utm_term, utm_content FROM ${table(UTM_LINKS)} WHERE ${aliveUtmLinks(seller.id)}`,
  );
  const distinct = (values: (string | null)[]) => [...new Set(values.filter(present))];
  const option = (type: string, resource: { product?: LinkRow; post?: InstallmentRow }) => destinationOption(seller, type, { ...resource, targets: resolved }, true);

  return {
    destination_options: [
      destinationOption(seller, "profile_page", null, true),
      destinationOption(seller, "subscribe_page", null, true),
      ...products.map((product) => option("product_page", { product })),
      ...posts.map((post) => option("post_page", { post })),
    ],
    short_url: link ? shortUrl(link.permalink) : shortUrl(await generateUniquePermalink()),
    utm_fields_values: {
      campaigns: distinct(fields.map((row) => row.utm_campaign)),
      mediums: distinct(fields.map((row) => row.utm_medium)),
      sources: distinct(fields.map((row) => row.utm_source)),
      terms: distinct(fields.map((row) => row.utm_term)),
      contents: distinct(fields.map((row) => row.utm_content)),
    },
  };
}

async function findLink(seller: User, id: bigint | number, alive = true): Promise<UtmLinkRow | null> {
  const [row] = await selectRows<UtmLinkRow>(
    Prisma.sql`SELECT * FROM ${table(UTM_LINKS)} WHERE ${column(UTM_LINKS, "seller_id")} = ${seller.id} AND ${column(UTM_LINKS, "id")} = ${id}${alive ? Prisma.sql` AND ${column(UTM_LINKS, "deleted_at")} IS NULL` : Prisma.empty} LIMIT 1`,
  );
  return row ?? null;
}

// `current_seller.utm_links.find_by_external_id(id)`, optionally only among the alive links.
export async function findUtmLinkByExternalId(seller: User, id: string, alive = false): Promise<UtmLinkRow | null> {
  const decrypted = decrypt(id);
  return decrypted === null ? null : findLink(seller, decrypted, alive);
}

// UtmLinkPresenter#new_page_react_props, in the order UtmLinksController#new renders it.
export async function newPageProps(seller: User, copyFrom: string) {
  const reference = present(copyFrom) ? await findUtmLinkByExternalId(seller, copyFrom, true) : null;
  const context = await formContext(seller, null);
  if (!reference) return { utm_link: null, context };
  const { id: _id, ...copied } = utmLinkProps(seller, reference, await targets([reference]));
  return { utm_link: { ...copied, short_url: context.short_url }, context };
}

// UtmLinkPresenter#edit_page_react_props
export async function editPageProps(seller: User, link: UtmLinkRow) {
  const context = await formContext(seller, link);
  return { context, utm_link: utmLinkProps(seller, link, await targets([link])) };
}

export type { Seller };
