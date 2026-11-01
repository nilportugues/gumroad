// ProductPresenter#edit_props for LinksController#edit (Products/Edit), for the products whose editor state is
// proven: a plain digital, course or ebook product. Everything the port does not read is a row that does not exist
// (`editBlockers`), and a product with one goes to Rails whole (HandBackToRails) before anything renders.
import { createHmac } from "node:crypto";

import { Prisma } from "@prisma/client";

import { encrypt as externalId } from "../../../lib/obfuscate-ids.ts";
import { HandBackToRails } from "../../controllers/application-controller.ts";
import { evaluateFeature, isFeatureEnabled, parseGateValues, readFeatureDoc, userActor } from "../../infra/flipper.ts";
import { getConfig } from "../../infra/config.ts";
import { railsEnv } from "../../infra/rails-env.ts";
import { instantInTimeZoneIso8601 } from "../../models/concerns/rails-time-zone.ts";
import { jsonGet } from "../../models/concerns/json-data.ts";
import { RubyHash, type YamlValue } from "../../models/concerns/psych.ts";
import { LinkFlags } from "../../models/link.ts";
import { column, selectRows, table } from "../../models/sql.ts";
import { rubyStrip, subdomain as userSubdomain, UserFlags, Users } from "../../models/user.ts";
import { castRow } from "../../models/sql.ts";
import type { User } from "@prisma/client";
import { jsonDataHash, authorBylineProps } from "../../presenters/product.ts";
import type { LinkRow, UserRow } from "../../presenters/product-reads.ts";
import { fromAddressWithName } from "../audience/mail-addresses.ts";
import { domainConfig } from "../domain.ts";
import data from "./edit-data.generated.json" with { type: "json" };

// Link::NATIVE_TYPE_DIGITAL, _COURSE, _EBOOK: the types whose editor state is the plain product's (no tiers, calls,
// shipping, commissions, bundle contents or coffee amounts).
export const EDIT_NATIVE_TYPES = ["digital", "course", "ebook"] as const;
const MAX_VIEW_CONTENT_BUTTON_TEXT_LENGTH = 26;
const MAX_CUSTOM_RECEIPT_TEXT_LENGTH = 500;
const MAX_CUSTOM_FAILED_PAYMENT_TEXT_LENGTH = 500;
const CUSTOM_ATTRIBUTE_NAME_SUGGESTION_PRODUCT_LIMIT = 200;
const MAX_CUSTOM_ATTRIBUTE_NAME_SUGGESTIONS = 20;
const INTEGRATION_NAMES = ["circle", "discord", "zoom", "google_calendar"] as const;
// BaseVariant::MINIMUM_DAYS_TIL_EXISTING_MEMBERSHIP_PRICE_CHANGE
const MINIMUM_DAYS_TIL_EXISTING_MEMBERSHIP_PRICE_CHANGE = 7;
const DAY_MS = 86_400_000;
const EDITOR_REVISION_VERSION = "v4";
// User::LAST_ALLOWED_TIME_FOR_PRODUCT_LEVEL_REFUND_POLICY (`Time.new(2025, 3, 31).end_of_day`, in the server's zone: UTC)
const LAST_ALLOWED_TIME_FOR_PRODUCT_LEVEL_REFUND_POLICY = Date.UTC(2025, 2, 31, 23, 59, 59, 999);
// RefundPolicy::ALLOWED_REFUND_PERIODS_IN_DAYS, DEFAULT_REFUND_PERIOD_IN_DAYS
const ALLOWED_REFUND_PERIODS_IN_DAYS: ReadonlyArray<readonly [number, string]> = [
  [0, "No refunds allowed"],
  [7, "7-day money back guarantee"],
  [14, "14-day money back guarantee"],
  [30, "30-day money back guarantee"],
  [183, "6-month money back guarantee"],
];
const DEFAULT_REFUND_PERIOD_IN_DAYS = 30;
// RendersCustomHtmlPages::GLOBAL_NAV_PATHS
const CUSTOM_HTML_GLOBAL_NAV_PATHS = ["/library", "/checkout"];

const TAXONOMY_LABELS = data.taxonomy_labels as Record<string, string>;
const present = (value: unknown): boolean => value !== null && value !== undefined && !(typeof value === "string" && value.trim() === "") && !(Array.isArray(value) && value.length === 0);
const refundPeriodTitle = (days: number | null) => ALLOWED_REFUND_PERIODS_IN_DAYS.find(([key]) => key === days)?.[1] ?? null;

// `Object#as_json` of a parsed json_data value.
function plain(value: YamlValue | undefined): unknown {
  if (value instanceof RubyHash) return Object.fromEntries(value.entries.map(([key, entry]) => [key, plain(entry)]));
  if (Array.isArray(value)) return value.map((entry) => plain(entry));
  return value === undefined ? null : value;
}

type Blocker = { blocker: string };

// The rows that would make the editor's state something this port does not model. Each is a table the presenter reads
// (files, rich content, versions, covers, integrations, tags ...) or a sale, whose count Rails reads from Elasticsearch.
export async function editBlockers(product: LinkRow, seller: UserRow): Promise<string[]> {
  const id = product.id;
  const sellerId = seller.id;
  const exists = (name: string, from: Prisma.Sql) => Prisma.sql`(SELECT ${Prisma.raw(`'${name}'`)} AS blocker FROM ${from} LIMIT 1)`;
  const probes = [
    exists("asset_previews", Prisma.sql`${table("asset_previews")} WHERE ${column("asset_previews", "link_id")} = ${id} AND ${column("asset_previews", "deleted_at")} IS NULL`),
    exists("thumbnail", Prisma.sql`${table("thumbnails")} WHERE ${column("thumbnails", "product_id")} = ${id} AND ${column("thumbnails", "deleted_at")} IS NULL`),
    exists("product_files", Prisma.sql`${table("product_files")} WHERE ${column("product_files", "link_id")} = ${id} AND ${column("product_files", "deleted_at")} IS NULL`),
    exists("rich_contents", Prisma.sql`${table("rich_contents")} WHERE ${column("rich_contents", "entity_id")} = ${id} AND ${column("rich_contents", "entity_type")} = 'Link' AND ${column("rich_contents", "deleted_at")} IS NULL`),
    exists("variant_categories", Prisma.sql`${table("variant_categories")} WHERE ${column("variant_categories", "link_id")} = ${id} AND ${column("variant_categories", "deleted_at")} IS NULL`),
    exists("skus", Prisma.sql`${table("base_variants")} WHERE ${column("base_variants", "link_id")} = ${id} AND ${column("base_variants", "deleted_at")} IS NULL`),
    exists("integrations", Prisma.sql`${table("product_integrations")} WHERE ${column("product_integrations", "product_id")} = ${id} AND ${column("product_integrations", "deleted_at")} IS NULL`),
    exists("shipping_destinations", Prisma.sql`${table("shipping_destinations")} WHERE ${column("shipping_destinations", "link_id")} = ${id} AND ${column("shipping_destinations", "deleted_at")} IS NULL`),
    exists("shipping_exclusions", Prisma.sql`${table("shipping_exclusions")} WHERE ${column("shipping_exclusions", "product_id")} = ${id}`),
    exists("tags", Prisma.sql`${table("product_taggings")} WHERE ${column("product_taggings", "product_id")} = ${id}`),
    exists("collaborator", Prisma.sql`${table("affiliates_links")} INNER JOIN ${table("affiliates")} ON ${column("affiliates", "id")} = ${column("affiliates_links", "affiliate_id")} WHERE ${column("affiliates_links", "link_id")} = ${id} AND ${column("affiliates", "type")} = 'Collaborator'`),
    exists("custom_html", Prisma.sql`${table("pages")} WHERE ${column("pages", "pageable_type")} = 'Link' AND ${column("pages", "pageable_id")} = ${id}`),
    exists("custom_domain", Prisma.sql`${table("custom_domains")} WHERE ${column("custom_domains", "product_id")} = ${id} AND ${column("custom_domains", "deleted_at")} IS NULL`),
    exists("installment_plan", Prisma.sql`${table("product_installment_plans")} WHERE ${column("product_installment_plans", "link_id")} = ${id} AND ${column("product_installment_plans", "deleted_at")} IS NULL`),
    exists("public_files", Prisma.sql`${table("public_files")} WHERE ${column("public_files", "resource_type")} = 'Link' AND ${column("public_files", "resource_id")} = ${id} AND ${column("public_files", "deleted_at")} IS NULL`),
    exists("product_builds", Prisma.sql`${table("product_builds")} WHERE ${column("product_builds", "product_id")} = ${id}`),
    exists("waitlist", Prisma.sql`${table("waitlist_entries")} WHERE ${column("waitlist_entries", "product_id")} = ${id}`),
    exists("sales", Prisma.sql`${table("purchases")} WHERE ${column("purchases", "link_id")} = ${id}`),
    exists("reviews", Prisma.sql`${table("product_review_stats")} WHERE ${column("product_review_stats", "link_id")} = ${id} AND ${column("product_review_stats", "reviews_count")} > 0`),
    // The picker offers the seller's whole file library.
    exists("existing_files", Prisma.sql`${table("product_files")} INNER JOIN ${table("links")} ON ${column("links", "id")} = ${column("product_files", "link_id")} WHERE ${column("links", "user_id")} = ${sellerId} AND ${column("product_files", "deleted_at")} IS NULL`),
    exists("other_refund_policies", Prisma.sql`${table("refund_policies")} WHERE ${column("refund_policies", "seller_id")} = ${sellerId} AND ${column("refund_policies", "product_id")} IS NOT NULL AND ${column("refund_policies", "product_id")} <> ${id}`),
    exists("seller_custom_domain", Prisma.sql`${table("custom_domains")} WHERE ${column("custom_domains", "user_id")} = ${sellerId} AND ${column("custom_domains", "deleted_at")} IS NULL`),
    exists("seller_refund_policy_missing", Prisma.sql`${table("users")} WHERE ${column("users", "id")} = ${sellerId} AND NOT EXISTS (SELECT 1 FROM ${table("refund_policies")} WHERE ${column("refund_policies", "seller_id")} = ${sellerId} AND ${column("refund_policies", "product_id")} IS NULL)`),
    exists("taxonomy_attribute_values", Prisma.sql`${table("taxonomy_attributes")} WHERE ${column("taxonomy_attributes", "active")} = TRUE AND JSON_TYPE(${column("taxonomy_attributes", "values")}) NOT IN ('ARRAY', 'NULL')`),
  ];
  const rows = await selectRows<Blocker>(Prisma.sql`${Prisma.join(probes, " UNION ALL ")}`);
  const blockers = rows.map((row) => row.blocker);

  const flags = product.flags;
  const set = (flag: Parameters<typeof LinkFlags.isSet>[1]) => LinkFlags.isSet(flags as bigint, flag);
  if (!(EDIT_NATIVE_TYPES as readonly (string | null)[]).includes(product.native_type)) blockers.push("native_type");
  for (const flag of ["is_recurring_billing", "is_tiered_membership", "is_physical", "is_bundle", "is_in_preorder_state", "free_trial_enabled", "is_collab", "skus_enabled"] as const) {
    if (set(flag)) blockers.push(flag);
  }
  if (product.max_purchase_count !== null) blockers.push("max_purchase_count");
  if (product.default_offer_code_id !== null) blockers.push("default_offer_code");
  if (product.subscription_duration !== null) blockers.push("subscription_duration");
  if (product.free_trial_duration_amount !== null || product.free_trial_duration_unit !== null) blockers.push("free_trial");
  if (product.price_currency_type === null) blockers.push("price_currency_type");
  return blockers;
}

export async function assertEditSupported(product: LinkRow, seller: UserRow, currentSellerId: bigint): Promise<void> {
  // A collaborator edits the owner's product: `collaborator_editing?` narrows the file picker and `waitlist` goes blank.
  if (product.user_id === null || product.user_id !== seller.id || currentSellerId !== seller.id) throw new HandBackToRails();
  if ((await editBlockers(product, seller)).length > 0) throw new HandBackToRails();
}

// Product::EditorRevision.current for a product with none of the five collections the digest covers.
export function editorRevision(product: LinkRow, secretKeyBase = getConfig("SECRET_KEY_BASE") ?? ""): string {
  const flag = (name: Parameters<typeof LinkFlags.isSet>[1]) => LinkFlags.isSet(product.flags as bigint, name);
  const fingerprint = {
    version: EDITOR_REVISION_VERSION,
    product: Number(product.id),
    product_state: { has_same_rich_content_for_all_variants: flag("has_same_rich_content_for_all_variants"), is_tiered_membership: flag("is_tiered_membership"), is_physical: flag("is_physical") },
    rich_content: [],
    variants: [],
    variant_categories: [],
    files: [],
    public_files: [],
    integrations: [],
    variant_integrations: [],
  };
  return createHmac("sha256", secretKeyBase).update(JSON.stringify(fingerprint)).digest("hex").slice(0, 32);
}

// Taxonomy-label ordering: Ruby compares Strings bytewise.
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

type NavTaxonomy = { key: string; label: string | null; slug: string; parent_key: string | null };

// Discover::TaxonomyPresenter#taxonomies_for_nav, uncached (Rails keeps it in Rails.cache for an hour).
async function taxonomiesForNav(): Promise<NavTaxonomy[]> {
  const rows = await selectRows<{ id: bigint; slug: string; parent_id: bigint | null; recent_sales_count: number | null }>(
    Prisma.sql`SELECT ${column("taxonomies", "id")}, ${column("taxonomies", "slug")}, ${column("taxonomies", "parent_id")}, ${column("taxonomy_stats", "recent_sales_count")} FROM ${table("taxonomies")} LEFT OUTER JOIN ${table("taxonomy_stats")} ON ${column("taxonomy_stats", "taxonomy_id")} = ${column("taxonomies", "id")} ORDER BY ${column("taxonomies", "id")} ASC`,
  );
  const sortKey = (row: (typeof rows)[number]): [number, string] => (row.slug === "other" ? [1, row.slug] : [-(row.recent_sales_count ?? 0), row.slug]);
  return [...rows]
    .sort((a, b) => {
      const [aCount, aSlug] = sortKey(a);
      const [bCount, bSlug] = sortKey(b);
      return aCount === bCount ? compare(aSlug, bSlug) : aCount - bCount;
    })
    .map((row) => ({ key: String(row.id), label: TAXONOMY_LABELS[row.slug] ?? null, slug: row.slug, parent_key: row.parent_id === null ? null : String(row.parent_id) }));
}

// Discover::TaxonomyPresenter#taxonomies_for_category_picker
export async function taxonomiesForCategoryPicker(): Promise<NavTaxonomy[]> {
  const taxonomies = await taxonomiesForNav();
  const byKey = new Map(taxonomies.map((taxonomy) => [taxonomy.key, taxonomy]));
  const breadcrumbs = new Map<string, string>();
  const breadcrumb = (taxonomy: NavTaxonomy): string => {
    const cached = breadcrumbs.get(taxonomy.key);
    if (cached !== undefined) return cached;
    const parent = taxonomy.parent_key === null ? undefined : byKey.get(taxonomy.parent_key);
    const value = `${parent ? `${breadcrumb(parent)} > ` : ""}${taxonomy.label ?? ""}`;
    breadcrumbs.set(taxonomy.key, value);
    return value;
  };
  return taxonomies.map((taxonomy) => ({ taxonomy, sort: breadcrumb(taxonomy).toLowerCase() })).sort((a, b) => compare(a.sort, b.sort)).map(({ taxonomy }) => taxonomy);
}

async function taxonomyAttributes() {
  const rows = await selectRows<{ taxonomy_id: bigint; name: string; label: string; value_type: string; values: unknown }>(
    Prisma.sql`SELECT ${column("taxonomy_attributes", "taxonomy_id")}, ${column("taxonomy_attributes", "name")}, ${column("taxonomy_attributes", "label")}, ${column("taxonomy_attributes", "value_type")}, ${column("taxonomy_attributes", "values")} FROM ${table("taxonomy_attributes")} WHERE ${column("taxonomy_attributes", "active")} = TRUE ORDER BY ${column("taxonomy_attributes", "position")} ASC, ${column("taxonomy_attributes", "id")} ASC`,
  );
  return rows.map((row) => {
    const values = typeof row.values === "string" ? (JSON.parse(row.values) as unknown) : row.values;
    // TaxonomyAttribute#normalized_options: Array(values).map(&:to_s)
    return { taxonomy_id: String(row.taxonomy_id), name: row.name, label: row.label, value_type: row.value_type, values: Array.isArray(values) ? values.map((value) => String(value)) : [] };
  });
}

type SectionRow = { id: bigint; header: string | null; json_data: unknown };

async function profileSections(seller: UserRow) {
  const rows = await selectRows<SectionRow>(
    Prisma.sql`SELECT ${column("seller_profile_sections", "id")}, ${column("seller_profile_sections", "header")}, ${column("seller_profile_sections", "json_data")} FROM ${table("seller_profile_sections")} WHERE ${column("seller_profile_sections", "seller_id")} = ${seller.id} AND ${column("seller_profile_sections", "type")} = 'SellerProfileProductsSection' AND ${column("seller_profile_sections", "product_id")} IS NULL ORDER BY ${column("seller_profile_sections", "id")} ASC`,
  );
  return Promise.all(
    rows.map(async (row) => {
      const data = (typeof row.json_data === "string" ? JSON.parse(row.json_data) : (row.json_data ?? {})) as { shown_products?: number[]; add_new_products?: boolean };
      const shown = data.shown_products ?? [];
      const names =
        shown.length === 0
          ? []
          : (await selectRows<{ name: string | null }>(Prisma.sql`SELECT ${column("links", "name")} FROM ${table("links")} WHERE ${column("links", "user_id")} = ${seller.id} AND ${column("links", "id")} IN (${Prisma.join(shown)}) ORDER BY ${column("links", "id")} ASC`)).map((link) => link.name);
      return { row, shown, names, defaultSection: data.add_new_products ?? null };
    }),
  );
}

async function customAttributeNameSuggestions(productId: bigint, sellerId: bigint): Promise<string[]> {
  const rows = await selectRows<{ name: string }>(
    Prisma.sql`SELECT DISTINCT detail_names.name AS name FROM (SELECT ${column("links", "json_data")} AS json_data FROM ${table("links")} WHERE ${column("links", "user_id")} = ${sellerId} AND NOT (${column("links", "id")} = ${productId}) ORDER BY ${column("links", "updated_at")} DESC LIMIT ${CUSTOM_ATTRIBUTE_NAME_SUGGESTION_PRODUCT_LIMIT}) AS suggestion_products JOIN JSON_TABLE(suggestion_products.json_data, '$.custom_attributes[*]' COLUMNS (name TEXT PATH '$.name')) AS detail_names ON TRUE WHERE detail_names.name IS NOT NULL ORDER BY detail_names.name ASC LIMIT ${MAX_CUSTOM_ATTRIBUTE_NAME_SUGGESTIONS}`,
  );
  return [...new Set(rows.map((row) => rubyStrip(String(row.name))).filter((name) => name !== ""))];
}

// User#account_level_refund_policy_enabled?
async function accountLevelRefundPolicyEnabled(seller: UserRow, now: Date): Promise<boolean> {
  if (await isFeatureEnabled("seller_refund_policy_disabled_for_all")) return false;
  const delayed = (await isFeatureEnabled("account_level_refund_policy_delayed_for_sellers", userActor(seller.id))) && now.getTime() <= LAST_ALLOWED_TIME_FOR_PRODUCT_LEVEL_REFUND_POLICY;
  if (delayed) return false;
  return UserFlags.isSet(seller.flags as bigint, "refund_policy_enabled");
}

// Marketing::Eligibility.enabled_for?: `HoldoutAssignment.for_seller!` inserts the seller's row on first sight, a write
// the port leaves to Rails.
async function autoMarketingEnabled(seller: UserRow): Promise<boolean> {
  const [assignment] = await selectRows<{ marketing_holdout: boolean }>(
    Prisma.sql`SELECT ${column("marketing_holdout_assignments", "marketing_holdout")} FROM ${table("marketing_holdout_assignments")} WHERE ${column("marketing_holdout_assignments", "user_id")} = ${seller.id} LIMIT 1`,
  );
  if (!assignment) throw new HandBackToRails();
  if (assignment.marketing_holdout) return false;
  try {
    return evaluateFeature("auto_marketing", parseGateValues(await readFeatureDoc("auto_marketing")), userActor(seller.id));
  } catch {
    return false;
  }
}

export type EditPropsInput = { product: LinkRow; seller: UserRow; sellerExternalId: string; aiGenerated: boolean; now?: Date };

export async function editProps({ product, seller, sellerExternalId, aiGenerated, now = new Date() }: EditPropsInput) {
  const flag = (name: Parameters<typeof LinkFlags.isSet>[1]) => LinkFlags.isSet(product.flags as bigint, name);
  const json = jsonDataHash(product.json_data);
  const jsonValue = (key: string) => (json ? jsonGet(json, key) : undefined);
  const jsonText = (key: string): string | null => {
    const value = jsonValue(key);
    return present(value) ? (value as string) : null;
  };
  const jsonObject = (key: string) => {
    const value = jsonValue(key);
    const hash = value instanceof RubyHash ? value : value !== null && typeof value === "object" && !Array.isArray(value) ? new RubyHash(Object.entries(value)) : null;
    return hash && hash.entries.length > 0 ? plain(hash) : {};
  };
  const customAttributes = (() => {
    const value = jsonValue("custom_attributes");
    return present(value) ? (plain(value) as unknown[]) : [];
  })();

  const [refund] = await selectRows<{ max_refund_period_in_days: number | null; fine_print: string | null }>(
    Prisma.sql`SELECT ${column("refund_policies", "max_refund_period_in_days")}, ${column("refund_policies", "fine_print")} FROM ${table("refund_policies")} WHERE ${column("refund_policies", "product_id")} = ${product.id} LIMIT 1`,
  );
  const [sellerRefund] = await selectRows<{ max_refund_period_in_days: number | null; fine_print: string | null }>(
    Prisma.sql`SELECT ${column("refund_policies", "max_refund_period_in_days")}, ${column("refund_policies", "fine_print")} FROM ${table("refund_policies")} WHERE ${column("refund_policies", "seller_id")} = ${seller.id} AND ${column("refund_policies", "product_id")} IS NULL ORDER BY ${column("refund_policies", "id")} ASC LIMIT 1`,
  );
  // find_or_initialize_product_refund_policy: an unsaved policy takes the attribute defaults.
  const refundPolicy = refund ?? { max_refund_period_in_days: DEFAULT_REFUND_PERIOD_IN_DAYS, fine_print: null };

  const sections = await profileSections(seller);
  const actor = userActor(seller.id);
  const sellerRecord = Users.load(castRow<User>("User", seller as never));
  const config = domainConfig(process.env);
  const subdomainName = userSubdomain(sellerRecord);
  const subdomainHost = subdomainName ? subdomainName.split(":")[0]! : null;
  const sellerTimezone = (seller.timezone as string | null) ?? "UTC";
  const mailDomain = railsEnv() === "production" ? getConfig("CUSTOMERS_MAIL_DOMAIN_PROD", "customers.gumroad.com") : getConfig("CUSTOMERS_MAIL_DOMAIN_DEV", "staging.customers.gumroad.com");
  const s3Bucket = { development: "gumroad-dev", staging: "gumroad_dev", test: "gumroad-specs", production: "gumroad" }[railsEnv()];

  return {
    product: {
      name: product.name,
      editor_revision: editorRevision(product),
      loaded_integrations: Object.fromEntries(INTEGRATION_NAMES.map((name) => [name, false])),
      custom_permalink: product.custom_permalink,
      description: product.description ?? "",
      price_cents: product.price_cents as number,
      customizable_price: !!product.customizable_price,
      suggested_price_cents: product.suggested_price_cents,
      eligible_for_installment_plans: true,
      allow_installment_plan: false,
      installment_plan: null,
      custom_button_text_option: jsonText("custom_button_text_option"),
      custom_summary: (jsonValue("custom_summary") ?? null) as string | null,
      custom_html: null,
      custom_view_content_button_text: jsonText("custom_view_content_button_text"),
      custom_view_content_button_text_max_length: MAX_VIEW_CONTENT_BUTTON_TEXT_LENGTH,
      custom_receipt_text: jsonText("custom_receipt_text"),
      custom_receipt_text_max_length: MAX_CUSTOM_RECEIPT_TEXT_LENGTH,
      custom_failed_payment_text: jsonText("custom_failed_payment_text"),
      custom_failed_payment_text_max_length: MAX_CUSTOM_FAILED_PAYMENT_TEXT_LENGTH,
      custom_attributes: customAttributes,
      taxonomy_attribute_values: jsonObject("taxonomy_attribute_values"),
      inferred_taxonomy_attribute_values: jsonObject("inferred_taxonomy_attribute_values"),
      file_attributes: [],
      max_purchase_count: null,
      quantity_enabled: flag("quantity_enabled"),
      can_enable_quantity: true,
      should_show_sales_count: flag("should_show_sales_count"),
      hide_sold_out_variants: flag("hide_sold_out_variants"),
      waitlist_enabled: flag("waitlist_enabled"),
      is_epublication: flag("is_epublication"),
      product_refund_policy_enabled: flag("product_refund_policy_enabled"),
      refund_policy: {
        allowed_refund_periods_in_days: ALLOWED_REFUND_PERIODS_IN_DAYS.map(([key, value]) => ({ key, value })),
        max_refund_period_in_days: refundPolicy.max_refund_period_in_days,
        fine_print: refundPolicy.fine_print,
        fine_print_enabled: present(refundPolicy.fine_print),
        title: refundPeriodTitle(refundPolicy.max_refund_period_in_days),
      },
      covers: [],
      is_published: !product.draft && product.purchase_disabled_at === null && product.banned_at === null && product.deleted_at === null,
      first_published_at: product.first_published_at ? instantInTimeZoneIso8601("UTC", product.first_published_at as Date) : null,
      require_shipping: false,
      integrations: Object.fromEntries(INTEGRATION_NAMES.map((name) => [name, null])),
      variants: [],
      availabilities: [],
      shipping_destinations: [],
      shipping_excluded_country_codes: [],
      section_ids: sections.filter((section) => section.shown.includes(Number(product.id))).map((section) => externalId(section.row.id)),
      taxonomy_id: product.taxonomy_id === null || product.taxonomy_id === undefined ? null : String(product.taxonomy_id),
      tags: [],
      display_product_reviews: flag("display_product_reviews"),
      is_adult: flag("is_adult"),
      discover_fee_per_thousand: product.discover_fee_per_thousand,
      custom_domain: "",
      free_trial_enabled: false,
      free_trial_duration_amount: null,
      free_trial_duration_unit: null,
      should_include_last_post: flag("should_include_last_post"),
      should_show_all_posts: flag("should_show_all_posts"),
      block_access_after_membership_cancellation: flag("block_access_after_membership_cancellation"),
      duration_in_months: product.duration_in_months,
      subscription_duration: null,
      collaborating_user: null,
      rich_content: [],
      files: [],
      has_same_rich_content_for_all_variants: false,
      is_multiseat_license: flag("is_multiseat_license"),
      call_limitation_info: null,
      native_type: product.native_type,
      cancellation_discount: null,
      default_offer_code_id: null,
      default_offer_code: null,
      public_files: [],
      community_chat_enabled: flag("community_chat_enabled"),
    },
    id: externalId(product.id),
    unique_permalink: product.unique_permalink,
    thumbnail: null,
    refund_policies: [],
    currency_type: product.price_currency_type,
    is_tiered_membership: false,
    can_close_membership_tiers: false,
    is_listed_on_discover: false,
    is_physical: false,
    profile_sections: sections.map((section) => ({ id: externalId(section.row.id), header: section.row.header ?? "", product_names: section.names, default: section.defaultSection })),
    taxonomies: await taxonomiesForCategoryPicker(),
    taxonomy_attributes: await taxonomyAttributes(),
    earliest_membership_price_change_date: instantInTimeZoneIso8601(sellerTimezone, new Date(now.getTime() + MINIMUM_DAYS_TIL_EXISTING_MEMBERSHIP_PRICE_CHANGE * DAY_MS)),
    custom_domain_verification_status: null,
    sales_count_for_inventory: 0,
    successful_sales_count: 0,
    ratings: { count: 0, average: 0.0, percentages: [0, 0, 0, 0, 0] },
    seller: await authorBylineProps(seller),
    current_seller_external_id: sellerExternalId,
    existing_files: [],
    s3_url: `${getConfig("AWS_S3_ENDPOINT", "https://s3.amazonaws.com")}/${s3Bucket}`,
    aws_key: getConfig("AWS_ACCESS_KEY_ID"),
    available_countries: data.shipping_countries,
    google_client_id: getConfig("GOOGLE_CLIENT_ID"),
    seller_refund_policy_enabled: await accountLevelRefundPolicyEnabled(seller, now),
    seller_refund_policy: { title: refundPeriodTitle(sellerRefund!.max_refund_period_in_days), fine_print: sellerRefund!.fine_print },
    cancellation_discounts_enabled: await isFeatureEnabled("cancellation_discounts", actor),
    receipt_email_from: fromAddressWithName(seller.name, `noreply@${mailDomain}`),
    price_checker_enabled: await isFeatureEnabled("price_checker", actor),
    has_web_builds: false,
    custom_html_pages_enabled: await isFeatureEnabled("custom_html_pages", actor),
    auto_marketing_enabled: await autoMarketingEnabled(seller),
    waitlist: null,
    custom_html_store_hostnames: subdomainHost ? [subdomainHost] : [],
    custom_html_global_nav_hosts: config.validRequestHosts,
    custom_html_global_nav_paths: CUSTOM_HTML_GLOBAL_NAV_PATHS,
    dropbox_api_key: getConfig("DROPBOX_PICKER_API_KEY"),
    ai_generated: aiGenerated,
    custom_attribute_name_suggestions: await customAttributeNameSuggestions(product.id, seller.id),
  };
}
