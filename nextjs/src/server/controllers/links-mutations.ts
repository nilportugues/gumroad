// The parts of LinksController that Node answers without a model port behind them: the product page's iframe endpoints, the
// 404/401/403 guards of the actions that stay in Rails (update, publish, release_preorder, price_check), `card`, which has no
// action, and the empty answers of `search`. Whatever passes a guard goes to Rails whole, before anything is written.
// disable_downloads_for_all_files and send_sample_price_change_email run in Node for the shapes their recordings prove.
import { Prisma } from "@prisma/client";

import { decrypt } from "../../lib/obfuscate-ids.ts";
import { railsLoggedInUser } from "../auth/resolve.ts";
import { isFeatureEnabled, userActor } from "../infra/flipper.ts";
import { keywordArgs, record, rubyDate, deliverLater } from "../mail/active-job.ts";
import { mailRoute } from "../mail/delivery.ts";
import { currentJobsRuntime } from "../models/concerns/job-runtime.ts";
import { priceCentsFromUnits } from "../models/price-units.ts";
import { disableDownloadsForAllFiles as disableDownloads } from "../models/product-disable-downloads.ts";
import { column, selectRows, table } from "../models/sql.ts";
import { UserFlags } from "../models/user.ts";
import { authorize } from "../policies/authorize.ts";
import { collaboratingProductIds, linkPolicy } from "../policies/link.ts";
import { loadSellerContext } from "../policies/seller-context.ts";
import { type LinkRow } from "../presenters/product-reads.ts";

import { HandBackToRails, ParameterMissing, RoutingError, type ActionResult, type Rendered } from "./application-controller.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";
import { fetchProductForShow } from "./product-page.ts";
import { find } from "./products-mutations.ts";
import { accountEmailRequired, authorizeJson, json, notFoundJson, UNPROCESSABLE_ENTITY } from "./seller-json.ts";

// ProfileSectionsPresenter::DEFAULT_PRODUCTS_SECTION_ID
const DEFAULT_PRODUCTS_SECTION_ID = "default-products";

const present = (value: string | null | undefined): value is string => value != null && /[^\s]/u.test(value);

// `head :not_found`: no body, and the content type of the request's format.
const headNotFound = (contentType: string): Rendered => ({ status: 404, body: "", contentType, paramsRead: true });

// ----- LinksController#landing_iframe_content and #landing_version

// fetch_product_for_show, check_banned, ensure_seller_is_not_deleted and ensure_domain_belongs_to_seller.
async function landingProduct(input: MutationInput) {
  const shown = await fetchProductForShow(input.request.host, input.routeParams.id ?? null);
  if (shown.product.banned_at !== null) throw new RoutingError("Not Found");
  if (shown.seller.deleted_at !== null) throw new RoutingError("Not Found");
  if (shown.isUserCustomDomain && shown.product.user_id !== shown.domainSeller?.id) throw new RoutingError("Not Found");
  return shown.product;
}

// can_preview_product_custom_html?: `logged_in_user == product.user || collaborator_for?(product) || is_team_member?`
async function canPreview(input: MutationInput, product: LinkRow): Promise<boolean> {
  const user = railsLoggedInUser(input.context);
  if (user === null) return false;
  if (user.id === product.user_id || UserFlags.isSet(user.flags, "is_team_member")) return true;
  const context = await loadSellerContext(input.context);
  return (await collaboratingProductIds(context, [product.id])).has(product.id);
}

// `has_one :page, -> { roots }`
async function rootPage(productId: bigint): Promise<{ custom_html: string | null; updated_at: Date } | null> {
  const [page] = await selectRows<{ custom_html: string | null; updated_at: Date }>(
    Prisma.sql`SELECT ${column("pages", "custom_html")}, ${column("pages", "updated_at")} FROM ${table("pages")} WHERE ${column("pages", "pageable_type")} = 'Link' AND ${column("pages", "pageable_id")} = ${productId} AND ${column("pages", "slug")} IS NULL ORDER BY ${column("pages", "id")} ASC LIMIT 1`,
  );
  return page ?? null;
}

// product_custom_html_visible?
async function customHtmlVisible(
  product: LinkRow,
  page: { custom_html: string | null } | null,
  previewing: boolean,
): Promise<boolean> {
  if (!(await isFeatureEnabled("custom_html_pages", userActor(product.user_id!)))) return false;
  if (!present(page?.custom_html)) return false;
  // Product#alive?
  const alive = product.purchase_disabled_at === null && product.banned_at === null && product.deleted_at === null;
  return alive || previewing;
}

async function landingIframeContent(input: MutationInput): Promise<ActionResult> {
  const product = await landingProduct(input);
  const page = await rootPage(product.id);
  if (!(await customHtmlVisible(product, page, await canPreview(input, product)))) return headNotFound("text/html");
  throw new HandBackToRails("the sandboxed document of a custom HTML page");
}

export async function landingVersion(input: MutationInput): Promise<ActionResult> {
  const product = await landingProduct(input);
  if (!(await canPreview(input, product))) return json({ present: false, version: null });
  const page = await rootPage(product.id);
  const visible = await customHtmlVisible(product, page, true);
  return json({ present: visible, version: visible ? Math.floor(page!.updated_at.getTime() / 1000) : null });
}

// ----- the actions that stay in Rails, behind their guards

// `fetch_product_and_enforce_access`, `authorize`, then Rails. `publish` skips RequireAccountEmail.
function guardedAction(authorization: "update" | "create", options?: { requireAccountEmail: boolean }) {
  return async (input: MutationInput): Promise<ActionResult> => {
    const found = await find(
      input,
      "access",
      (context, product, collaborating) => {
        if (authorization === "update") authorize((c, p) => linkPolicy.update(c, p, collaborating), context, product);
        else authorize(linkPolicy.create, context);
      },
      options,
    );
    if (found.halt) return found.halt;
    throw new HandBackToRails("the product save pipeline, publishing, a preorder release or the product files");
  };
}

// `Product::DisableDownloadsForAllFiles`, after `authorize @product`; a flip it cannot prove is a NotPortedError before any write.
async function disableDownloadsForAllFiles(input: MutationInput): Promise<ActionResult> {
  const found = await find(input, "access", (context, product, collaborating) =>
    authorize((c, p) => linkPolicy.update(c, p, collaborating), context, product),
  );
  if (found.halt) return found.halt;
  const result = await disableDownloads(found.product.get("id"));
  return json({
    success: true,
    disabled_count: result.disabled_file_ids.length,
    disabled_file_ids: result.disabled_file_ids,
    already_disabled_count: result.already_disabled_count,
    ineligible_count: result.ineligible_count,
  });
}

type ProductRow = { id: bigint; user_id: bigint | null; flags: bigint; price_currency_type: string | null };

// FetchProductByUniquePermalink: `Link.find_by(unique_permalink:) || e404`, deleted products included.
async function fetchByUniquePermalink(input: MutationInput): Promise<ProductRow> {
  const permalink = input.routeParams.id;
  const [row] = present(permalink)
    ? await selectRows<ProductRow>(
        Prisma.sql`SELECT ${column("links", "id")}, ${column("links", "user_id")}, ${column("links", "flags")}, ${column("links", "price_currency_type")} FROM ${table("links")} WHERE ${column("links", "unique_permalink")} = ${permalink} LIMIT 1`,
      )
    : [];
  if (!row) throw new RoutingError("Not Found");
  return row;
}

// RequireAccountEmail, fetch_product_by_unique_permalink and `authorize @product, :edit?|:update?`.
async function uniquePermalinkGuard(
  input: MutationInput,
  query: "edit" | "update",
): Promise<{ halt: ActionResult } | { halt: null; product: ProductRow }> {
  const emailRequired = accountEmailRequired(input);
  if (emailRequired) return { halt: emailRequired };
  const product = await fetchByUniquePermalink(input);
  const context = await loadSellerContext(input.context);
  const collaborating = await collaboratingProductIds(context, [product.id]);
  const denied = await authorizeJson(input, () =>
    authorize((c, p) => linkPolicy[query](c, p, collaborating), context, product),
  );
  return denied ? { halt: denied } : { halt: null, product };
}

async function priceCheck(input: MutationInput): Promise<ActionResult> {
  const guard = await uniquePermalinkGuard(input, "edit");
  if (guard.halt) return guard.halt;
  if (!(await isFeatureEnabled("price_checker", userActor(guard.product.user_id!))))
    return headNotFound("application/json");
  throw new HandBackToRails("PriceCheckerService asks an LLM");
}

// `strip_tags(custom_message).present?` is decidable without the sanitizer only for plain printable ASCII.
const PLAIN_MESSAGE = /^[\x20-\x7e\n\t]*$/u;
const MARKUP_CHARACTERS = /[<>&]/u;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;

function isoDate(value: string): string | null {
  const match = ISO_DATE.exec(value);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toISOString().slice(0, 10) === value ? value : null;
}

async function sendSamplePriceChangeEmail(input: MutationInput): Promise<ActionResult> {
  const guard = await uniquePermalinkGuard(input, "update");
  if (guard.halt) return guard.halt;
  // `params.require(:tier_id)` answers 400 for a missing, blank or structured value; only the missing one is recorded.
  const tierId = input.params.tier_id;
  if (tierId === undefined) throw new ParameterMissing();
  if (typeof tierId !== "string" || !present(tierId))
    throw new HandBackToRails("a tier_id that params.require rejects");
  const id = decrypt(tierId);
  // `@product.tiers.find_by_external_id`: Variants of the alive "Tier" categories.
  const [tier] =
    id === null
      ? []
      : await selectRows<{ subscription_price_change_effective_date: Date | null }>(
          Prisma.sql`SELECT ${column("base_variants", "subscription_price_change_effective_date")} FROM ${table("base_variants")} INNER JOIN ${table("variant_categories")} ON ${column("variant_categories", "id")} = ${column("base_variants", "variant_category_id")} WHERE ${column("base_variants", "type")} = 'Variant' AND ${column("base_variants", "id")} = ${id} AND ${column("variant_categories", "link_id")} = ${guard.product.id} AND ${column("variant_categories", "deleted_at")} IS NULL AND ${column("variant_categories", "title")} = 'Tier' LIMIT 1`,
        );
  if (!tier || id === null) return notFoundJson();

  const { amount, recurrence, effective_date: effectiveParam, custom_message: messageParam } = input.params;
  if (amount === undefined) throw new ParameterMissing();
  if (typeof amount !== "string" || !present(amount))
    throw new HandBackToRails("an amount that params.require rejects");
  const price = priceCentsFromUnits(amount, guard.product.price_currency_type);
  if (price === "unsupported") throw new HandBackToRails("an amount the port cannot price");
  if (price === null) return json({ success: false, error: "Invalid amount" }, UNPROCESSABLE_ENTITY);

  // Date.parse and the remaining params.require run after the amount, inside the mailer call.
  let effectiveDate: string | null;
  if (effectiveParam === undefined || effectiveParam === null || effectiveParam === "") {
    const stored = tier.subscription_price_change_effective_date;
    effectiveDate = stored === null ? null : stored.toISOString().slice(0, 10);
  } else if (typeof effectiveParam === "string" && present(effectiveParam)) {
    effectiveDate = isoDate(effectiveParam);
    if (effectiveDate === null) throw new HandBackToRails("an effective_date Date.parse reads differently");
  } else {
    throw new HandBackToRails("an effective_date that is not an ISO date");
  }
  if (typeof recurrence !== "string" || !present(recurrence))
    throw new HandBackToRails("a recurrence that params.require rejects");
  let customMessage: string | null = null;
  if (messageParam !== undefined && messageParam !== null) {
    if (typeof messageParam !== "string" || !PLAIN_MESSAGE.test(messageParam) || MARKUP_CHARACTERS.test(messageParam))
      throw new HandBackToRails("a custom message strip_tags would rewrite");
    customMessage = present(messageParam) ? messageParam : null;
  }
  const user = railsLoggedInUser(input.context);
  if (user === null) throw new HandBackToRails("a visitor who is not signed in");

  await deliverLater(
    currentJobsRuntime(),
    {
      mailer: "CustomerLowPriorityMailer",
      method: "sample_subscription_price_change_notification",
      args: [
        keywordArgs({
          user: record("User", user.id),
          tier: record("Variant", id),
          effective_date: effectiveDate === null ? null : rubyDate(effectiveDate),
          recurrence,
          new_price: price,
          custom_message: customMessage,
        }),
      ],
    },
    mailRoute("CustomerLowPriorityMailer", "sample_subscription_price_change_notification"),
  );
  return json({ success: true });
}

// ----- LinksController#search: the answers that need no Elasticsearch

const EMPTY_SEARCH = { total: 0, filetypes_data: [], tags_data: [], taxonomy_attributes_data: [], products: [] };

export async function search(input: MutationInput): Promise<ActionResult> {
  const { user_id: userId, section_id: sectionId, ids } = input.params;
  if (userId === undefined || userId === null || userId === "")
    throw new HandBackToRails("a search that is not scoped to a profile");
  if (
    typeof userId !== "string" ||
    (sectionId !== undefined && typeof sectionId !== "string") ||
    (ids !== undefined && ids !== "")
  ) {
    throw new HandBackToRails("a profile search the port cannot narrow to the empty answer");
  }
  // `User.find_by_external_id`: users carry a random `external_id` column, not an encrypted id.
  const [seller] = await selectRows<{ id: bigint }>(
    Prisma.sql`SELECT ${column("users", "id")} FROM ${table("users")} WHERE ${column("users", "external_id")} = ${userId} LIMIT 1`,
  );
  if (!seller) return json(EMPTY_SEARCH);
  if (sectionId === DEFAULT_PRODUCTS_SECTION_ID) throw new HandBackToRails("the virtual default products section");
  const id = typeof sectionId === "string" ? decrypt(sectionId) : null;
  const [section] =
    id === null
      ? []
      : await selectRows(
          Prisma.sql`SELECT 1 FROM ${table("seller_profile_sections")} WHERE ${column("seller_profile_sections", "id")} = ${id} AND ${column("seller_profile_sections", "seller_id")} = ${seller.id} AND ${column("seller_profile_sections", "type")} = 'SellerProfileProductsSection' LIMIT 1`,
        );
  if (section) throw new HandBackToRails("a products section to search");
  return json(EMPTY_SEARCH);
}

// ----- LinksController#card: routed, but the controller has no such action, so Rails answers its 404.

export async function card(): Promise<ActionResult> {
  throw new RoutingError("Not Found");
}

registerMutations(
  { method: "GET", pattern: "/l/:id/landing/embed", skipForgeryProtection: true, run: landingIframeContent },
  { method: "GET", pattern: "/l/:id/landing/version", skipForgeryProtection: true, run: landingVersion },
  { method: "GET", pattern: "/products/search", skipForgeryProtection: true, run: search },
  { method: "GET", pattern: "/products/:id/card", skipForgeryProtection: true, run: card },
  { method: "POST", pattern: "/links/:id", json: true, run: guardedAction("update") },
  {
    method: "POST",
    pattern: "/links/:id/publish",
    json: true,
    run: guardedAction("create", { requireAccountEmail: false }),
  },
  {
    method: "POST",
    pattern: "/links/:id/disable_downloads_for_all_files",
    json: true,
    run: disableDownloadsForAllFiles,
  },
  { method: "POST", pattern: "/products/:id/release_preorder", json: true, run: guardedAction("create") },
  { method: "POST", pattern: "/products/:id/price_check", json: true, run: priceCheck },
  { method: "POST", pattern: "/links/:id/send_sample_price_change_email", json: true, run: sendSamplePriceChangeEmail },
);
