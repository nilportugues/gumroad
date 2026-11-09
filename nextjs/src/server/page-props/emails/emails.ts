// PaginatedInstallmentsPresenter, InstallmentPresenter's page props and the lookups of EmailsController.
import { Prisma, type Installment, type InstallmentRule, type User } from "@prisma/client";

import { decrypt } from "../../../lib/obfuscate-ids.ts";
import { storageConfig } from "../../infra/storage.ts";
import { parseJsonData, filterValue } from "../../models/with-filtering.ts";
import { column, selectRows, table } from "../../models/sql.ts";
import { audienceTypes, affiliateProductsForFilterBox, productsForFilterBox } from "../audience/user-presenter.ts";
import { displayedName, engagementOf, flagSet, preloadEngagement } from "../audience/installments.ts";
import { timeZoneAbbreviation } from "../audience/workflows.ts";
import { externalId, paramToI, present, stringParam, type QuerySource } from "../audience/support.ts";
import DATA from "../audience/audience-data.generated.json" with { type: "json" };
import { NotPortedError } from "../not-ported.ts";
import { searchInstallments, type InstallmentListType } from "./installment-search.ts";
import { postInstallmentProps, type Blast, type PostContext } from "./installment-props.ts";

const INSTALLMENTS = "installments";
const PER_PAGE = 25;
const EMAILED_POST_OPTIONS_LIMIT = 50;
const FLAG_ALLOW_COMMENTS = 2 ** 10;
const FLAG_SEND_EMAILS = 2 ** 8;
const FLAG_READY_TO_PUBLISH = 2 ** 9;
const FLAG_SINGLE_RECIPIENT_EMAIL = 2 ** 11;
const USA = "United States";

// A query parameter Rack parses into an array or a hash makes Rails raise (`Array#to_i`, `Array#strip`).
function scalarParam(request: QuerySource, name: string): string {
  if (request.queryString.split("&").some((pair) => pair.startsWith(`${name}[`) || pair.startsWith(`${encodeURIComponent(name)}%5B`))) {
    throw new NotPortedError(`a ${name} parameter that is an array or hash`);
  }
  return stringParam(request, name);
}

export const emailsListParams = (request: QuerySource) => ({
  page: Math.max(paramToI(scalarParam(request, "page")), 1),
  query: scalarParam(request, "query").trim(),
});

// ----- installments of a seller

const typeCondition = (type: InstallmentListType) => {
  const flags = column(INSTALLMENTS, "flags");
  const published = column(INSTALLMENTS, "published_at");
  if (type === "published") return Prisma.sql`${published} IS NOT NULL`;
  if (type === "scheduled") return Prisma.sql`${published} IS NULL AND ${flags} & ${FLAG_READY_TO_PUBLISH} = ${FLAG_READY_TO_PUBLISH}`;
  return Prisma.sql`${published} IS NULL AND ${flags} & ${FLAG_READY_TO_PUBLISH} = 0`;
};

// Installment.ordered_updates(seller, type): the seller's posts and those of their products.
const ownedInstallments = (seller: User) =>
  Prisma.sql`((SELECT * FROM ${table(INSTALLMENTS)} WHERE ${column(INSTALLMENTS, "seller_id")} = ${seller.id}) UNION (SELECT * FROM ${table(INSTALLMENTS)} WHERE ${column(INSTALLMENTS, "link_id")} IN (SELECT ${column("links", "id")} FROM ${table("links")} WHERE ${column("links", "user_id")} = ${seller.id} AND ${column("links", "deleted_at")} IS NULL))) ${table(INSTALLMENTS)}`;

const aliveNotWorkflow = Prisma.sql`${column(INSTALLMENTS, "deleted_at")} IS NULL AND ${column(INSTALLMENTS, "workflow_id")} IS NULL`;

function orderFor(type: InstallmentListType) {
  if (type === "draft") return Prisma.sql`${column(INSTALLMENTS, "updated_at")} DESC`;
  if (type === "scheduled") return Prisma.sql`${column("installment_rules", "to_be_published_at")} ASC`;
  return Prisma.sql`published_at IS NULL, COALESCE(published_at, ${column(INSTALLMENTS, "created_at")}) DESC`;
}

async function pageFromDatabase(seller: User, type: InstallmentListType, page: number) {
  const join = type === "scheduled" ? Prisma.sql`LEFT OUTER JOIN ${table("installment_rules")} ON ${column("installment_rules", "installment_id")} = ${column(INSTALLMENTS, "id")}` : Prisma.empty;
  const [counted] = await selectRows<{ count: bigint | number }>(
    Prisma.sql`SELECT COUNT(DISTINCT ${column(INSTALLMENTS, "id")}) AS count FROM ${ownedInstallments(seller)} ${join} WHERE ${aliveNotWorkflow} AND ${typeCondition(type)}`,
  );
  const count = Number(counted?.count ?? 0);
  const installments = await selectRows<Installment>(
    Prisma.sql`SELECT ${table(INSTALLMENTS)}.* FROM ${ownedInstallments(seller)} ${join} WHERE ${aliveNotWorkflow} AND ${typeCondition(type)} ORDER BY ${orderFor(type)} LIMIT ${PER_PAGE} OFFSET ${(page - 1) * PER_PAGE}`,
  );
  // Pagy: the last page is at least 1, and a page past it answers empty with no next.
  const last = Math.max(Math.ceil(count / PER_PAGE), 1);
  return { installments, count, next: page < last ? page + 1 : null };
}

async function pageFromSearch(seller: User, type: InstallmentListType, page: number, query: string) {
  const offset = (page - 1) * PER_PAGE;
  const { ids, total } = await searchInstallments({ sellerId: seller.id, type, q: query, from: offset, size: PER_PAGE });
  let installments: Installment[] = [];
  if (ids.length > 0) {
    const rows = await selectRows<Installment>(Prisma.sql`SELECT * FROM ${table(INSTALLMENTS)} WHERE ${column(INSTALLMENTS, "id")} IN (${Prisma.join(ids)})`);
    // Elasticsearch::Model::Adapter::ActiveRecord::Records: hit order; ids without a row drop out.
    installments = ids.flatMap((id) => rows.filter((row) => Number(row.id) === id));
  }
  return { installments, count: total, next: total > offset + PER_PAGE ? page + 1 : null };
}

// ----- the presenter's reads

type SectionRow = { id: number; header: string | null; json_data: unknown };

async function postsSections(seller: User): Promise<SectionRow[]> {
  return selectRows<SectionRow>(
    Prisma.sql`SELECT * FROM ${table("seller_profile_sections")} WHERE ${column("seller_profile_sections", "seller_id")} = ${seller.id} AND ${column("seller_profile_sections", "type")} = 'SellerProfilePostsSection' ORDER BY ${column("seller_profile_sections", "id")} ASC`,
  );
}

function shownPosts(section: SectionRow): number[] {
  const json = typeof section.json_data === "string" ? JSON.parse(section.json_data) : section.json_data;
  const posts = (json as { shown_posts?: unknown } | null)?.shown_posts;
  if (!Array.isArray(posts)) throw new TypeError("undefined method 'include?' for nil");
  return posts.map(Number);
}

async function loadContexts(seller: User, installments: Installment[], engagement: Awaited<ReturnType<typeof preloadEngagement>> | null): Promise<Map<number, PostContext & { rule: InstallmentRule | null }>> {
  const result = new Map<number, PostContext & { rule: InstallmentRule | null }>();
  if (installments.length === 0) return result;
  const ids = installments.map((installment) => installment.id);
  const rules = await selectRows<InstallmentRule>(Prisma.sql`SELECT * FROM ${table("installment_rules")} WHERE ${column("installment_rules", "installment_id")} IN (${Prisma.join(ids)})`);
  const blasts = await selectRows<Blast & { post_id: number }>(Prisma.sql`SELECT * FROM ${table("post_email_blasts")} WHERE ${column("post_email_blasts", "post_id")} IN (${Prisma.join(ids)}) ORDER BY ${column("post_email_blasts", "id")} ASC`);
  const linkIds = [...new Set(installments.flatMap((installment) => (installment.link_id === null ? [] : [installment.link_id])))];
  const links = linkIds.length === 0 ? [] : await selectRows<{ id: number; name: string; unique_permalink: string }>(Prisma.sql`SELECT * FROM ${table("links")} WHERE ${column("links", "id")} IN (${Prisma.join(linkIds)})`);
  const variantIds = [...new Set(installments.flatMap((installment) => (installment.base_variant_id === null ? [] : [installment.base_variant_id])))];
  const variants = variantIds.length === 0 ? [] : await selectRows<{ id: number; name: string | null }>(Prisma.sql`SELECT * FROM ${table("base_variants")} WHERE ${column("base_variants", "id")} IN (${Prisma.join(variantIds)})`);
  const sections = (await postsSections(seller)).map((section) => ({ externalId: externalId(section.id), shownPosts: shownPosts(section) }));

  for (const installment of installments) {
    const link = links.find((candidate) => Number(candidate.id) === Number(installment.link_id));
    const variant = variants.find((candidate) => Number(candidate.id) === Number(installment.base_variant_id));
    const isProductOrVariant = installment.installment_type === "product" || installment.installment_type === "variant";
    if (isProductOrVariant && !link) throw new TypeError("undefined method 'unique_permalink' for nil");
    result.set(installment.id, {
      rule: rules.find((rule) => Number(rule.installment_id) === installment.id) ?? null,
      engagement: engagement?.get(installment.id) ?? (await engagementOf(installment.id)),
      permalink: isProductOrVariant ? link!.unique_permalink : null,
      variantExternalId: installment.installment_type === "variant" && variant ? externalId(variant.id) : null,
      blasts: blasts.filter((blast) => Number(blast.post_id) === installment.id),
      sections,
      linkName: link?.name ?? null,
      variantName: variant?.name ?? null,
    });
  }
  return result;
}

async function presentAll(seller: User, installments: Installment[]) {
  const engagement = await preloadEngagement(installments);
  const contexts = await loadContexts(seller, installments, engagement);
  const props: Record<string, unknown>[] = [];
  for (const installment of installments) {
    const context = contexts.get(installment.id)!;
    props.push(await postInstallmentProps({ seller, installment, context, rule: context.rule }));
  }
  return props;
}

// PaginatedInstallmentsPresenter#props
export async function paginatedInstallmentsProps(seller: User, type: InstallmentListType, { page, query }: { page: number; query: string }) {
  const found = query === "" ? await pageFromDatabase(seller, type, page) : await pageFromSearch(seller, type, page, query);
  return { installments: await presentAll(seller, found.installments), pagination: { count: found.count, next: found.next } };
}

// PaginatedInstallmentsPresenter#has_posts?
export async function hasPosts(seller: User, type: InstallmentListType): Promise<boolean> {
  const rows = await selectRows(
    Prisma.sql`SELECT 1 AS one FROM ${table(INSTALLMENTS)} WHERE ${column(INSTALLMENTS, "seller_id")} = ${seller.id} AND ${aliveNotWorkflow} AND ${typeCondition(type)} LIMIT 1`,
  );
  return rows.length > 0;
}

// `current_seller.installments.alive.not_workflow_installment.scheduled.exists?`
export const hasScheduledEmails = (seller: User) => hasPosts(seller, "scheduled");

// ----- lookups

export async function findInstallmentByExternalId(seller: User, id: string): Promise<Installment | null> {
  const decrypted = decrypt(id);
  if (decrypted === null) return null;
  const [row] = await selectRows<Installment>(
    Prisma.sql`SELECT * FROM ${table(INSTALLMENTS)} WHERE ${column(INSTALLMENTS, "seller_id")} = ${seller.id} AND ${column(INSTALLMENTS, "deleted_at")} IS NULL AND ${column(INSTALLMENTS, "id")} = ${decrypted} LIMIT 1`,
  );
  return row ?? null;
}

// InstallmentPresenter#props for one post.
export async function installmentPropsFor(seller: User, installment: Installment): Promise<Record<string, unknown>> {
  const context = (await loadContexts(seller, [installment], null)).get(installment.id)!;
  return postInstallmentProps({ seller, installment, context, rule: context.rule });
}

// ----- the form context

async function emailedPostOptions(seller: User, savedId: string | null) {
  const rows = await selectRows<Installment>(
    Prisma.sql`SELECT * FROM ${table(INSTALLMENTS)} WHERE ${column(INSTALLMENTS, "seller_id")} = ${seller.id} AND ${aliveNotWorkflow} AND ${column(INSTALLMENTS, "published_at")} IS NOT NULL AND ${column(INSTALLMENTS, "flags")} & ${FLAG_SEND_EMAILS} > 0 AND ${column(INSTALLMENTS, "flags")} & ${FLAG_SINGLE_RECIPIENT_EMAIL} = 0 AND ${column(INSTALLMENTS, "installment_type")} IN ('seller', 'product', 'variant') ORDER BY ${column(INSTALLMENTS, "published_at")} DESC LIMIT ${EMAILED_POST_OPTIONS_LIMIT}`,
  );
  const option = (row: Installment) => ({ external_id: externalId(row.id), name: displayedName(row) });
  const posts = rows.map(option);
  if (!present(savedId) || posts.some((post) => post.external_id === savedId)) return posts;
  const saved = await findInstallmentByExternalId(seller, savedId);
  return saved ? [option(saved), ...posts] : posts;
}

// InstallmentPresenter#installment_form_context_props
export async function installmentFormContext(seller: User, { notClickedPostId, fromTab }: { notClickedPostId: string | null; fromTab: string | null }) {
  const products = await productsForFilterBox(seller);
  const affiliateProducts = await affiliateProductsForFilterBox(seller);
  const waitlist = await selectRows<{ name: string; unique_permalink: string }>(
    Prisma.sql`SELECT ${column("links", "name")}, ${column("links", "unique_permalink")} FROM ${table("links")} WHERE ${column("links", "user_id")} = ${seller.id} AND ${column("links", "deleted_at")} IS NULL AND EXISTS (SELECT 1 FROM ${table("waitlist_entries")} WHERE ${column("waitlist_entries", "product_id")} = ${column("links", "id")}) ORDER BY ${column("links", "created_at")} DESC`,
  );
  const [lastInstallment] = await selectRows<Installment>(
    Prisma.sql`SELECT * FROM ${table(INSTALLMENTS)} WHERE ${column(INSTALLMENTS, "seller_id")} = ${seller.id} AND ${column(INSTALLMENTS, "workflow_id")} IS NULL ORDER BY ${column(INSTALLMENTS, "created_at")} DESC LIMIT 1`,
  );
  const storage = storageConfig();
  return {
    audience_types: await audienceTypes(seller),
    products: products.map((product) => ({
      permalink: product.unique_permalink,
      name: product.name,
      archived: product.archived,
      variants: product.variants.map((variant) => ({ id: externalId(variant.id), name: variant.name })),
    })),
    affiliate_products: affiliateProducts.map((product) => ({ permalink: product.unique_permalink, name: product.name, archived: product.archived })),
    waitlist_products: waitlist.map((product) => ({ permalink: product.unique_permalink, name: product.name })),
    timezone: timeZoneAbbreviation(seller.timezone),
    currency_type: seller.currency_type ?? "",
    countries: [USA, ...(DATA.countries as string[]).filter((name) => name !== USA)],
    profile_sections: (await postsSections(seller)).map((section) => ({ id: externalId(section.id), name: section.header })),
    has_scheduled_emails: await hasScheduledEmails(seller),
    emailed_posts: await emailedPostOptions(seller, notClickedPostId),
    aws_access_key_id: storage.accessKeyId ?? null,
    s3_url: `${storage.s3Endpoint}/${storage.s3Bucket}`,
    user_id: seller.external_id,
    allow_comments_by_default: lastInstallment ? flagSet(lastInstallment.flags, FLAG_ALLOW_COMMENTS) : true,
    from_tab: fromTab,
  };
}

export const notClickedPostIdOf = (installment: Installment | null): string | null => {
  if (!installment) return null;
  const value = filterValue({ jsonData: () => parseJsonData(installment.json_data) }, "not_clicked_post_id");
  return value === null ? null : String(value);
};
