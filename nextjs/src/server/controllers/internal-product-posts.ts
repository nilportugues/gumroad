// Api::Internal::ProductPostsController#index (PaginatedProductPostsPresenter over Installment.receivable_by_customers_of_product):
// the posts a buyer of one product receives, newest first, ten to a page.
import { Prisma, type Installment, type InstallmentRule } from "@prisma/client";

import { encrypt } from "../../lib/obfuscate-ids.ts";
import { railsLoggedInUser } from "../auth/resolve.ts";
import { escapeSegment } from "../mail/routes.ts";
import { displayableTimeDuration } from "../models/installment-rule.ts";
import { InstallmentFlags, InstallmentPost } from "../models/installment-post.ts";
import { castRow, column, selectRows, table } from "../models/sql.ts";
import { NotPortedError } from "../models/user.ts";
import { filterValue } from "../models/with-filtering.ts";
import { NotPortedError as PageNotPortedError } from "../page-props/not-ported.ts";
import { subdomainWithProtocol } from "../presenters/product.ts";
import { HandBackToRails, RoutingError, type ActionResult } from "./application-controller.ts";
import { json, jsonAction } from "./json-actions.ts";
import type { MutationInput } from "./mutation.ts";
import { notFoundJson } from "./seller-json.ts";

const PER_PAGE = 10;
const SOURCE = "installment.rb";

const present = (value: string | null | undefined): value is string => value !== null && value !== undefined && !/^\s*$/u.test(value);

// `product.alive_variants.map(&:external_id)`
async function aliveVariantExternalIds(productId: bigint): Promise<string[]> {
  const rows = await selectRows<{ id: bigint }>(
    Prisma.sql`SELECT ${column("base_variants", "id")} FROM ${table("base_variants")} INNER JOIN ${table("variant_categories")} ON ${column("variant_categories", "id")} = ${column("base_variants", "variant_category_id")} WHERE ${column("variant_categories", "link_id")} = ${productId} AND ${column("variant_categories", "deleted_at")} IS NULL AND ${column("base_variants", "type")} = 'Variant' AND ${column("base_variants", "deleted_at")} IS NULL`,
  );
  return rows.map((row) => encrypt(row.id));
}

// A saved list of permalinks or variant ids, as `present?` reads it: null for none.
function list(post: InstallmentPost, key: string): string[] | null {
  const value = filterValue(post, key);
  if (value === null) return null;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) throw new NotPortedError(`${key} that is not a list of text`, SOURCE);
  return value as string[];
}

type Receivable = { post: InstallmentPost; rule: InstallmentRule | null; workflowRule: boolean };

// Installment.receivable_by_customers_of_product
async function receivable(product: { id: bigint; user_id: bigint; unique_permalink: string }, variantExternalId: string | null): Promise<Receivable[]> {
  const rows = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`installments`.*")} FROM ${table("installments")} WHERE ${column("installments", "seller_id")} = ${product.user_id} AND ${column("installments", "deleted_at")} IS NULL AND ${column("installments", "published_at")} IS NOT NULL`,
  );
  const variantIds = await aliveVariantExternalIds(product.id);
  const kept: InstallmentPost[] = [];
  for (const row of rows) {
    const post = new InstallmentPost(castRow<Installment>("Installment", row));
    if (InstallmentFlags.isSet(post.row.flags, "single_recipient_email") || !post.sellerOrProductOrVariantType) continue;
    const boughtProducts = list(post, "bought_products");
    const boughtVariants = list(post, "bought_variants");
    const forThisProduct = boughtProducts?.includes(product.unique_permalink) === true;
    const forAVariant = boughtVariants?.some((id) => variantIds.includes(id)) === true;
    if (!(forThisProduct || forAVariant || (boughtProducts === null && boughtVariants === null))) continue;
    if (present(variantExternalId)) {
      const everyone = boughtProducts === null && boughtVariants === null;
      if (!(everyone || boughtProducts?.includes(product.unique_permalink) === true || boughtVariants?.includes(variantExternalId) === true)) continue;
    }
    kept.push(post);
  }
  if (kept.length === 0) return [];

  const ids = kept.map((post) => post.id);
  const rules = await selectRows(Prisma.sql`SELECT ${Prisma.raw("`installment_rules`.*")} FROM ${table("installment_rules")} WHERE ${column("installment_rules", "installment_id")} IN (${Prisma.join(ids)})`);
  const ruleOf = new Map(rules.map((rule) => [Number((rule as { installment_id: bigint }).installment_id), castRow<InstallmentRule>("InstallmentRule", rule)]));
  return kept.map((post) => {
    const rule = ruleOf.get(post.id) ?? null;
    return { post, rule, workflowRule: post.row.workflow_id !== null && rule !== null };
  });
}

// `sort_by { workflow rule ? DateTime.current + delayed_delivery_time : published_at }.reverse`. DateTime + Integer adds days, so a workflow
// post is always later than a published one; equal keys are ordered by Ruby's unstable sort and by clock reads, which is not worth guessing.
function newestFirst(posts: Receivable[]): Receivable[] {
  const key = (entry: Receivable) => (entry.workflowRule ? `w${String(entry.rule!.delayed_delivery_time).padStart(20, "0")}` : `p${entry.post.row.published_at!.getTime()}`);
  const keys = posts.map(key);
  if (new Set(keys).size !== keys.length) throw new NotPortedError("posts whose sort keys are equal", SOURCE);
  const rank = (entry: Receivable) => (entry.workflowRule ? [1, Number(entry.rule!.delayed_delivery_time)] : [0, entry.post.row.published_at!.getTime()]);
  return [...posts].sort((a, b) => {
    const [aKind, aValue] = rank(a) as [number, number];
    const [bKind, bValue] = rank(b) as [number, number];
    return bKind - aKind || bValue - aValue;
  });
}

// Installment#full_url: the seller's subdomain when it has a username, else a path under /username/p.
function fullUrl(post: InstallmentPost, seller: { username: string | null; external_id: string | null }): string | null {
  const slug = post.row.slug;
  if (!present(slug)) return null;
  const host = subdomainWithProtocol(seller);
  if (host !== null) return `${host}/p/${escapeSegment(slug)}`;
  const username = present(seller.username) ? seller.username : seller.external_id;
  if (!present(username)) throw new NotPortedError("a seller without a username or external id", SOURCE);
  return `/${escapeSegment(username)}/p/${escapeSegment(slug)}`;
}

// Pagy's page parameter: `options[:page].to_i`, at least 1.
function pageParam(value: unknown): number {
  if (value === undefined || value === null) return 1;
  if (typeof value !== "string") throw new HandBackToRails("a page that is not text");
  const match = /^[ \t\n\v\f\r]*([+-]?\d+(?:_\d+)*)/u.exec(value);
  return Math.max(match ? Number(match[1]!.replaceAll("_", "")) : 0, 1);
}

async function run(input: MutationInput): Promise<ActionResult> {
  const user = railsLoggedInUser(input.context);
  if (user === null) return { ...notFoundJson(), rescued: true };
  const seller = input.context.currentSeller;
  if (seller === null) throw new HandBackToRails("a signed-in request without a current seller");

  // FetchProductByUniquePermalink: `params[:id] || params[:link_id] || params[:product_id]`
  const given = input.params.id ?? input.params.link_id ?? input.routeParams.product_id;
  if (given !== undefined && given !== null && typeof given !== "string") throw new HandBackToRails("a product permalink that is not text");
  if (!present(given)) throw new RoutingError("Not Found");
  const [product] = await selectRows<{ id: bigint; user_id: bigint | null; unique_permalink: string }>(
    Prisma.sql`SELECT ${column("links", "id")}, ${column("links", "user_id")}, ${column("links", "unique_permalink")} FROM ${table("links")} WHERE ${column("links", "unique_permalink")} = ${given} LIMIT 1`,
  );
  if (!product) throw new RoutingError("Not Found");
  if (product.user_id === null || BigInt(product.user_id) !== BigInt(seller.id)) throw new RoutingError("Not Found");

  const variant = input.params.variant_id;
  if (variant !== undefined && variant !== null && typeof variant !== "string") throw new HandBackToRails("a variant_id that is not text");
  const page = pageParam(input.params.page);
  const posts = newestFirst(await receivable({ id: product.id, user_id: product.user_id, unique_permalink: product.unique_permalink }, variant ?? null));
  const pages = Math.max(Math.ceil(posts.length / PER_PAGE), 1);
  // Pagy::DEFAULT[:overflow] = :exception
  if (page > pages) throw new HandBackToRails("a page past the last");

  const shown = posts.slice((page - 1) * PER_PAGE, page * PER_PAGE);
  return json({
    total: posts.length,
    next_page: page < pages ? page + 1 : null,
    posts: shown.map(({ post, rule, workflowRule }) => ({
      id: encrypt(post.id),
      name: post.row.name,
      date: workflowRule ? { type: "workflow_email_rule", time_duration: displayableTimeDuration(rule!), time_period: rule!.time_period } : { type: "date", value: post.row.published_at!.toISOString() },
      url: fullUrl(post, seller),
    })),
  });
}

export const productPosts = (request: Request, routeParams: Record<string, string>) =>
  jsonAction(request, routeParams, {}, async (input) => {
    try {
      return await run(input);
    } catch (error) {
      if (error instanceof NotPortedError || error instanceof PageNotPortedError) throw new HandBackToRails(error.message);
      throw error;
    }
  });

