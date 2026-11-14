// BundlePresenter#edit_product_props and #edit_share_props (Bundles/Product/Edit, Bundles/Share/Edit), for a bundle whose
// editor state is proven: a bundle of plain products (no versions, no SKUs) with none of the rows the port does not read
// (covers, thumbnail, files, public files, an offer code, an installment plan, sales or reviews). A
// bundle with one goes to Rails whole (HandBackToRails) before anything renders.
// Bundles/Content/Edit answers its first load; its `search_data` is a deferred Elasticsearch result (BundleSearchProductsService)
// that a partial reload gets from Rails.
import { Prisma } from "@prisma/client";

import { encrypt as externalId } from "../../../lib/obfuscate-ids.ts";
import { HandBackToRails } from "../../controllers/application-controller.ts";
import { isFeatureEnabled, userActor } from "../../infra/flipper.ts";
import { LinkFlags } from "../../models/link.ts";
import { column, selectRows, table } from "../../models/sql.ts";
import { findLink, type LinkRow, type UserRow } from "../../presenters/product-reads.ts";
import { cardForWeb } from "../../presenters/product.ts";
import { deferMerge } from "../lazy-props.ts";
import { assertNoPublishSchedule, publishScheduleEditorProps } from "../publish-schedule-props.ts";
import { NotPortedError } from "../not-ported.ts";
import {
  accountLevelRefundPolicyEnabled,
  ALLOWED_REFUND_PERIODS_IN_DAYS,
  DEFAULT_REFUND_PERIOD_IN_DAYS,
  collaboratingUserProps,
  jsonSettings,
  otherProductRefundPolicies,
  present,
  productTagNames,
  profileSections,
  refundPeriodTitle,
  rowBlockers,
  taxonomiesForCategoryPicker,
} from "../seller-products/edit.ts";

const NATIVE_TYPE_BUNDLE = "bundle";
// Rows the bundle presenters never read: the product editor's rich content, integrations, shipping, builds, waitlist and
// file picker, and the seller-wide domain and attribute probes. `custom_html` stays for the Share tab.
const UNREAD_BY_BUNDLE_PRODUCT_EDITOR = [
  "rich_contents",
  "variant_integrations",
  "integrations",
  "shipping_destinations",
  "shipping_exclusions",
  "custom_domain",
  "product_builds",
  "waitlist",
  "existing_files",
  "seller_custom_domain",
  "taxonomy_attribute_values",
  "custom_html",
];
const UNREAD_BY_SHARE_EDITOR = UNREAD_BY_BUNDLE_PRODUCT_EDITOR.filter((name) => name !== "custom_html");

export type BundleTab = "product" | "share" | "content";

// What would make the editor's state something this port does not model; empty when the bundle renders in Node.
export async function bundleBlockers(bundle: LinkRow, seller: UserRow, tab: BundleTab = "product"): Promise<string[]> {
  const unread = tab === "share" ? UNREAD_BY_SHARE_EDITOR : UNREAD_BY_BUNDLE_PRODUCT_EDITOR;
  const blockers = (await rowBlockers(bundle, seller)).filter((name) => !unread.includes(name));
  const set = (flag: Parameters<typeof LinkFlags.isSet>[1]) => LinkFlags.isSet(bundle.flags as bigint, flag);
  // A product being converted to a bundle renders a flash alert ("Select products and save your changes ...").
  if (!set("is_bundle") || bundle.native_type !== NATIVE_TYPE_BUNDLE) blockers.push("not_a_bundle");
  // ProductInstallmentPlan.eligible_for_product?
  for (const flag of ["is_recurring_billing", "is_tiered_membership", "is_in_preorder_state"] as const) {
    if (set(flag)) blockers.push(flag);
  }
  if (bundle.default_offer_code_id !== null) blockers.push("default_offer_code");
  return blockers;
}

export async function assertBundleEditSupported(bundle: LinkRow, seller: UserRow, tab: BundleTab): Promise<void> {
  // A collaborator edits the owner's bundle through the same props: the presenter never reads `pundit_user`.
  if (bundle.user_id === null || bundle.user_id !== seller.id) throw new HandBackToRails();
  if ((await bundleBlockers(bundle, seller, tab)).length > 0) throw new HandBackToRails();
  await assertNoPublishSchedule(bundle);
  // Bundles::ShareController#ensure_published redirects with a flash alert; `Link#published?`.
  if (tab === "share" && (bundle.draft || bundle.purchase_disabled_at !== null || bundle.deleted_at !== null))
    throw new HandBackToRails();
}

// `created_at.iso8601`: second precision, UTC (config.time_zone is unset).
const iso8601 = (date: Date) => date.toISOString().replace(/\.\d{3}Z$/u, "Z");

// Port of BundlePresenter.bundle_product for a member without versions: `variants` is nil and the card is the canonical one.
async function bundleProduct(member: LinkRow, quantity: number) {
  const [category] = await selectRows<{ one: number }>(
    Prisma.sql`SELECT 1 AS one FROM ${table("variant_categories")} WHERE ${column("variant_categories", "link_id")} = ${member.id} AND ${column("variant_categories", "deleted_at")} IS NULL LIMIT 1`,
  );
  if (category || LinkFlags.isSet(member.flags as bigint, "skus_enabled"))
    throw new NotPortedError("A bundle product with versions or SKUs (BundlePresenter.bundle_product)");
  return {
    ...(await cardForWeb(member.id)),
    is_quantity_enabled: LinkFlags.isSet(member.flags as bigint, "quantity_enabled"),
    quantity,
    price_cents: member.price_cents as number,
    created_at: iso8601(member.created_at as Date),
    variants: null,
  };
}

// `bundle.bundle_products.alive.in_order`
async function bundleProducts(bundleId: bigint) {
  const rows = await selectRows<{ product_id: bigint; variant_id: bigint | null; quantity: number }>(
    Prisma.sql`SELECT ${column("bundle_products", "product_id")}, ${column("bundle_products", "variant_id")}, ${column("bundle_products", "quantity")} FROM ${table("bundle_products")} WHERE ${column("bundle_products", "bundle_id")} = ${bundleId} AND ${column("bundle_products", "deleted_at")} IS NULL ORDER BY ${column("bundle_products", "position")} ASC, ${column("bundle_products", "id")} ASC`,
  );
  const products: Record<string, unknown>[] = [];
  for (const row of rows) {
    if (row.variant_id !== null)
      throw new NotPortedError("A bundle product with a selected version (BundlePresenter.bundle_product)");
    const member = await findLink(row.product_id);
    if (!member) throw new NotPortedError("A bundle product whose product is gone");
    products.push(await bundleProduct(member, row.quantity));
  }
  return products;
}

// BundlePresenter#refund_policy_props
function refundPolicyProps(policy: { max_refund_period_in_days: number | null; fine_print: string | null }) {
  return {
    allowed_refund_periods_in_days: ALLOWED_REFUND_PERIODS_IN_DAYS.map(([key, value]) => ({ key, value })),
    max_refund_period_in_days: policy.max_refund_period_in_days,
    fine_print: policy.fine_print,
    fine_print_enabled: present(policy.fine_print),
    title: refundPeriodTitle(policy.max_refund_period_in_days),
  };
}

async function refundPolicies(bundle: LinkRow, seller: UserRow) {
  const [own] = await selectRows<{ max_refund_period_in_days: number | null; fine_print: string | null }>(
    Prisma.sql`SELECT ${column("refund_policies", "max_refund_period_in_days")}, ${column("refund_policies", "fine_print")} FROM ${table("refund_policies")} WHERE ${column("refund_policies", "product_id")} = ${bundle.id} LIMIT 1`,
  );
  const [sellerPolicy] = await selectRows<{ max_refund_period_in_days: number | null; fine_print: string | null }>(
    Prisma.sql`SELECT ${column("refund_policies", "max_refund_period_in_days")}, ${column("refund_policies", "fine_print")} FROM ${table("refund_policies")} WHERE ${column("refund_policies", "seller_id")} = ${seller.id} AND ${column("refund_policies", "product_id")} IS NULL LIMIT 1`,
  );
  return {
    // find_or_initialize_product_refund_policy: an unsaved policy takes the attribute defaults.
    own: own ?? { max_refund_period_in_days: DEFAULT_REFUND_PERIOD_IN_DAYS, fine_print: null },
    seller: { title: refundPeriodTitle(sellerPolicy!.max_refund_period_in_days), fine_print: sellerPolicy!.fine_print },
  };
}

// BundlePresenter#shared_props
async function sharedProps(
  bundle: LinkRow,
  seller: UserRow,
  policy: Awaited<ReturnType<typeof refundPolicies>>["own"],
) {
  const flag = (name: Parameters<typeof LinkFlags.isSet>[1]) => LinkFlags.isSet(bundle.flags as bigint, name);
  const { jsonValue, jsonText, customAttributes } = jsonSettings(bundle);
  const sections = await profileSections(seller);
  return {
    bundle: {
      name: bundle.name,
      description: bundle.description ?? "",
      custom_permalink: bundle.custom_permalink,
      price_cents: bundle.price_cents as number,
      customizable_price: !!bundle.customizable_price,
      suggested_price_cents: bundle.suggested_price_cents,
      eligible_for_installment_plans: true,
      allow_installment_plan: false,
      installment_plan: null,
      custom_button_text_option: jsonText("custom_button_text_option"),
      custom_summary: (jsonValue("custom_summary") ?? null) as string | null,
      custom_attributes: customAttributes,
      max_purchase_count: bundle.max_purchase_count,
      quantity_enabled: flag("quantity_enabled"),
      should_show_sales_count: flag("should_show_sales_count"),
      is_epublication: flag("is_epublication"),
      product_refund_policy_enabled: flag("product_refund_policy_enabled"),
      refund_policy: refundPolicyProps(policy),
      covers: [],
      taxonomy_id: bundle.taxonomy_id === null || bundle.taxonomy_id === undefined ? null : String(bundle.taxonomy_id),
      tags: await productTagNames(bundle.id),
      display_product_reviews: flag("display_product_reviews"),
      hide_bundle_product_reviews: flag("hide_bundle_product_reviews"),
      is_adult: flag("is_adult"),
      discover_fee_per_thousand: bundle.discover_fee_per_thousand,
      section_ids: sections
        .filter((section) => section.shown.includes(Number(bundle.id)))
        .map((section) => externalId(section.row.id)),
      is_published:
        !bundle.draft &&
        bundle.purchase_disabled_at === null &&
        bundle.banned_at === null &&
        bundle.deleted_at === null,
      ...(await publishScheduleEditorProps(bundle, seller.id)),
      products: await bundleProducts(bundle.id),
      collaborating_user: await collaboratingUserProps(bundle),
      public_files: [],
      retained_files: [],
      default_offer_code: null,
    },
    id: externalId(bundle.id),
    unique_permalink: bundle.unique_permalink,
    is_bundle: true,
    sections,
  };
}

const NO_RATINGS = { count: 0, average: 0.0, percentages: [0, 0, 0, 0, 0] };

export type BundleEditInput = { bundle: LinkRow; seller: UserRow; now?: Date };

// BundlePresenter#edit_product_props
export async function bundleEditProductProps({ bundle, seller, now = new Date() }: BundleEditInput) {
  const policies = await refundPolicies(bundle, seller);
  const { sections: _sections, ...shared } = await sharedProps(bundle, seller, policies.own);
  return {
    ...shared,
    currency_type: bundle.price_currency_type,
    thumbnail: null,
    sales_count_for_inventory: 0,
    ratings: NO_RATINGS,
    refund_policies: await otherProductRefundPolicies(bundle.id, seller.id),
    seller_refund_policy_enabled: await accountLevelRefundPolicyEnabled(seller, now),
    seller_refund_policy: policies.seller,
  };
}

// `bundle.user.products.alive.not_archived.not_is_recurring_billing.not_is_bundle.not_call.count`; `where.not(native_type:)` drops a NULL.
async function selectableProductsCount(sellerId: bigint): Promise<number> {
  const [row] = await selectRows<Record<string, unknown>>(
    Prisma.sql`SELECT COUNT(*) FROM ${table("links")} WHERE ${column("links", "user_id")} = ${sellerId} AND ${column("links", "purchase_disabled_at")} IS NULL AND ${column("links", "banned_at")} IS NULL AND ${column("links", "deleted_at")} IS NULL AND ${LinkFlags.condition("archived", false)} AND ${LinkFlags.condition("is_recurring_billing", false)} AND ${LinkFlags.condition("is_bundle", false)} AND ${column("links", "native_type")} != 'call'`,
  );
  return Number(Object.values(row ?? {})[0] ?? 0);
}

// BundlePresenter#edit_content_props, and the deferred `search_data` of Bundles::ContentController#edit.
export async function bundleEditContentProps({ bundle, seller }: BundleEditInput) {
  const policies = await refundPolicies(bundle, seller);
  const { sections: _sections, ...shared } = await sharedProps(bundle, seller, policies.own);
  return {
    ...shared,
    products_count: await selectableProductsCount(seller.id),
    has_outdated_purchases: LinkFlags.isSet(bundle.flags as bigint, "has_outdated_purchases"),
    search_data: deferMerge(() => {
      throw new HandBackToRails();
    }),
  };
}

// BundlePresenter#edit_share_props
export async function bundleEditShareProps({ bundle, seller, now = new Date() }: BundleEditInput) {
  const policies = await refundPolicies(bundle, seller);
  const { sections, ...shared } = await sharedProps(bundle, seller, policies.own);
  return {
    ...shared,
    taxonomies: await taxonomiesForCategoryPicker(),
    profile_sections: sections.map((section) => ({
      id: externalId(section.row.id),
      header: section.row.header ?? "",
      product_names: section.names,
      default: section.defaultSection,
    })),
    currency_type: bundle.price_currency_type,
    sales_count_for_inventory: 0,
    ratings: NO_RATINGS,
    seller_refund_policy_enabled: await accountLevelRefundPolicyEnabled(seller, now),
    seller_refund_policy: policies.seller,
    custom_html_pages_enabled: await isFeatureEnabled("custom_html_pages", userActor(seller.id)),
    // The `custom_html` probe (bundleBlockers) keeps a bundle with a landing page in Rails.
    has_custom_landing_page: false,
  };
}
