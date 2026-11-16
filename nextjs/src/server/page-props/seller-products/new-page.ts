// ProductPresenter.new_page_props for LinksController#new.
import { Prisma, type User } from "@prisma/client";

import zones from "../../models/concerns/time-zones.generated.json" with { type: "json" };
import { InvalidTimeZoneError } from "../../models/concerns/rails-time-zone.ts";
import { NATIVE_TYPES, LinkFlags } from "../../models/link.ts";
import { column, selectRows, table } from "../../models/sql.ts";
import { RISK_STATES, UserFlags } from "../../models/user.ts";
import { salesCentsTotal } from "../../search/purchase-sales.ts";
import { hasCompletedPayment, madeSaleWithConnectOrPaypalAccount } from "../signed-in/reads.ts";

// Link::SERVICE_TYPES, Link::LEGACY_TYPES
const SERVICE_TYPES = ["commission", "call", "coffee"];
const LEGACY_TYPES = ["podcast", "newsletter", "audiobook"];
const DAY_MS = 86_400_000;
// User::MIN_AGE_FOR_SERVICE_PRODUCTS, MIN_ACCOUNT_AGE_FOR_PHYSICAL_PRODUCTS, MIN_SALES_CENTS_VALUE_FOR_PHYSICAL_PRODUCTS,
// MIN_SALES_CENTS_VALUE_FOR_AI_PRODUCT_GENERATION
const MIN_AGE_FOR_SERVICE_PRODUCTS_MS = 30 * DAY_MS;
const MIN_ACCOUNT_AGE_FOR_PHYSICAL_PRODUCTS_MS = 90 * DAY_MS;
const MIN_SALES_CENTS_VALUE_FOR_PHYSICAL_PRODUCTS = 100_000;
const MIN_SALES_CENTS_VALUE_FOR_AI_PRODUCT_GENERATION = 10_000;

const isSuspended = (user: User) => (RISK_STATES.SUSPENDED as readonly (string | null)[]).includes(user.user_risk_state);
const hasCompletedPayouts = async (userId: bigint) => (await hasCompletedPayment(userId)) || (await madeSaleWithConnectOrPaypalAccount(userId));

// User#sells_physical_products?
async function sellsPhysicalProducts(userId: bigint): Promise<boolean> {
  const rows = await selectRows(
    Prisma.sql`SELECT 1 FROM ${table("links")} WHERE ${column("links", "user_id")} = ${userId} AND ${column("links", "deleted_at")} IS NULL AND ${column("links", "banned_at")} IS NULL AND ${LinkFlags.condition("is_physical", true)} LIMIT 1`,
  );
  return rows.length > 0;
}

// User#can_create_physical_products?
async function canCreatePhysicalProducts(user: User, now: Date): Promise<boolean> {
  if (user.confirmed_at === null || isSuspended(user)) return false;
  if (UserFlags.isSet(user.flags, "DEPRECATED_can_create_physical_products")) return true;
  if (await sellsPhysicalProducts(user.id)) return true;
  if ((user.created_at?.getTime() ?? 0) > now.getTime() - MIN_ACCOUNT_AGE_FOR_PHYSICAL_PRODUCTS_MS) return false;
  if (!(await hasCompletedPayouts(user.id))) return false;
  return (await salesCentsTotal(user.id)) >= MIN_SALES_CENTS_VALUE_FOR_PHYSICAL_PRODUCTS;
}

// User#eligible_for_ai_product_generation?
export async function eligibleForAiProductGeneration(user: User): Promise<boolean> {
  if (user.confirmed_at === null || isSuspended(user)) return false;
  if ((await salesCentsTotal(user.id)) < MIN_SALES_CENTS_VALUE_FOR_AI_PRODUCT_GENERATION) return false;
  return hasCompletedPayouts(user.id);
}

// `1.month.from_now`: Time#advance(months: 1) clamps the day to the end of the shorter month.
export function oneMonthFrom(now: Date): Date {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(now.getUTCDate(), lastDay), now.getUTCHours(), now.getUTCMinutes(), now.getUTCSeconds()));
}

// displayable_release_at_date: `Time::DATE_FORMATS[:formatted_date_full_month]` ("%B %-d, %Y") in the seller's zone
export function displayableReleaseAtDate(releaseAt: Date, sellerTimezone: string): string {
  const identifier = (zones as Record<string, string>)[sellerTimezone];
  if (identifier === undefined) throw new InvalidTimeZoneError(sellerTimezone);
  return new Intl.DateTimeFormat("en-US", { timeZone: identifier, year: "numeric", month: "long", day: "numeric" }).format(releaseAt);
}

export async function newPageProps(seller: User, now: Date = new Date()) {
  const physical = await canCreatePhysicalProducts(seller, now);
  const nativeProductTypes = NATIVE_TYPES.filter((type) => !LEGACY_TYPES.includes(type) && !SERVICE_TYPES.includes(type) && (physical || type !== "physical"));
  const [visible] = await selectRows(Prisma.sql`SELECT 1 FROM ${table("links")} WHERE ${column("links", "user_id")} = ${seller.id} AND ${column("links", "deleted_at")} IS NULL LIMIT 1`);
  return {
    current_seller_currency_code: seller.currency_type,
    native_product_types: nativeProductTypes,
    service_product_types: SERVICE_TYPES,
    release_at_date: displayableReleaseAtDate(oneMonthFrom(now), seller.timezone ?? "UTC"),
    show_orientation_text: visible === undefined,
    eligible_for_service_products: now.getTime() - (seller.created_at?.getTime() ?? 0) > MIN_AGE_FOR_SERVICE_PRODUCTS_MS,
    ai_generation_enabled: await eligibleForAiProductGeneration(seller),
    ai_promo_dismissed: UserFlags.isSet(seller.flags, "dismissed_create_products_with_ai_promo_alert"),
  };
}
