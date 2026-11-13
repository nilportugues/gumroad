// Products::PublishSchedulesController (app/controllers/products/publish_schedules_controller.rb): scheduling and cancelling the
// publication of a never-published draft, on `/links/:link_id/publish_schedule`.
//
// Recorded from Rails by spec/requests/products_publish_schedules_parity_spec.rb. Handed to Rails before any write, each one on
// purpose: a time that has every character strptime needs but not the editor's spelling (Ruby's strptime accepts `2031-6-5T9:30`), a
// seller in a time zone whose abbreviation `%Z` is not recorded or outside the mapping, a physical product that has a shipping
// destination (`shippable_country_codes` and the supported-country list), and the paid-publish experiment or a payout method other
// than an address, whose refusals `Link#publish_precheck_error` words from data Node does not read (the seller plan and payouts).
import { Prisma, type Link, type User } from "@prisma/client";

import { railsLoggedInUser } from "../auth/resolve.ts";
import { isFeatureEnabled, userActor } from "../infra/flipper.ts";
import { EMAIL_CONFIRMATION_MESSAGE, UNPUBLISHED_BY_ADMIN_MESSAGE } from "../models/link-publish.ts";
import { LinkFlags } from "../models/link.ts";
import { transaction } from "../models/runtime/transaction.ts";
import { castRow, column, execute, selectRows, table } from "../models/sql.ts";
import { authorize } from "../policies/authorize.ts";
import { linkPolicy } from "../policies/link.ts";
import { offsetMinutesAt, timezoneId, TimeZoneNotPortedError } from "../search/civil-time.ts";

import { HandBackToRails, type ActionResult } from "./application-controller.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";
import { accountEmailRequired, authorizeJson, json, notFoundJson, UNPROCESSABLE_ENTITY } from "./seller-json.ts";

const FEATURE_FLAG = "scheduled_product_publishing";
const MIN_LEAD_TIME_MS = 5 * 60_000;
const NO_SCHEDULE = "There is no schedule to cancel.";
const NOT_AVAILABLE = "Scheduled publishing isn't available for your account yet.";
const INVALID_TIME = "Enter a valid date and time.";
const MIN_LEAD_TIME = "Choose a time at least 5 minutes from now.";
const ALREADY_SCHEDULED = "This product already has a schedule. Cancel it first.";
const NEVER_PUBLISHED_ONLY = "Only products that have never been published can be scheduled.";
const CANNOT_SCHEDULE = "This product can't be scheduled.";
const NO_PREORDERS = "Pre-orders can't be scheduled.";
const SUSPENDED = "Your account can't publish products right now.";
const EMAIL_REQUIRED = "To publish a product, we need you to have an email.";
// A strptime("%Y-%m-%dT%H:%M") spelling, within the years the zone offsets below are read for.
const LOCAL_TIME = /^(20\d{2})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/u;
// Zones whose `%Z` abbreviation Intl prints as tzinfo does (recorded: Pacific, Eastern, UTC).
const INTL_ABBREVIATED_ZONES = new Set(["America/Los_Angeles", "America/New_York", "Etc/UTC"]);
// tzinfo's abbreviation by UTC offset in minutes, for the zones Intl would print as "GMT+1" (recorded in winter and summer).
const TZINFO_ABBREVIATIONS: Record<string, Record<number, string>> = {
  "Europe/London": { 0: "GMT", 60: "BST" },
  "Europe/Paris": { 60: "CET", 120: "CEST" },
  "America/Chicago": { [-360]: "CST", [-300]: "CDT" },
  "Australia/Sydney": { 600: "AEST", 660: "AEDT" },
  "Asia/Tokyo": { 540: "JST" },
  "Asia/Kolkata": { 330: "IST" },
};
const NO_SHIPPING_DESTINATION = "The product needs to be shippable to at least one destination.";
const SUSPENDED_STATES = new Set(["suspended_for_fraud", "suspended_for_tos_violation"]);
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

class Invalid extends Error {}

type Product = Link;
type Seller = User;

const readProduct = async (where: Prisma.Sql, lock = false): Promise<Product | null> => {
  const [row] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`links`.*")} FROM ${table("links")} WHERE ${where} LIMIT 1${lock ? Prisma.raw(" FOR UPDATE") : Prisma.empty}`,
  );
  return row === undefined ? null : castRow<Link>("Link", row);
};

// `Link.visible.find_by(unique_permalink:)`, then `@product.user != current_seller` (e404_json) and `authorize @product, :publish?`.
async function fetchProduct(input: MutationInput): Promise<{ halt: ActionResult } | { halt: null; product: Product }> {
  const halted = accountEmailRequired(input);
  if (halted) return { halt: halted };
  const permalink = input.routeParams.link_id;
  const product = await readProduct(
    Prisma.sql`${column("links", "deleted_at")} IS NULL AND ${column("links", "unique_permalink")} = ${permalink}`,
  );
  if (product === null || product.user_id !== input.context.currentSeller!.id)
    return { halt: { ...notFoundJson(), rescued: true } };
  const denied = await authorizeJson(input, (context) => authorize(linkPolicy.create, context));
  return denied === null ? { halt: null, product } : { halt: denied };
}

// ProductPublishSchedule.parse_local_time for the zone's offset rules: the UTC instant of a wall-clock time, or the refusal.
export function parseLocalTime(value: unknown, zone: string): number {
  // `local_time.to_s[0, 16]` of a number, boolean, list or object never reads as `%Y-%m-%dT%H:%M` (recorded for each).
  if (typeof value !== "string") throw new Invalid(INVALID_TIME);
  if (value === "") throw new Invalid(INVALID_TIME);
  const sliced = value.slice(0, 16).replace(" ", "T");
  const match = LOCAL_TIME.exec(sliced);
  if (match === null) {
    // The format's literals: a string without them cannot parse, whatever else strptime tolerates.
    if (!sliced.includes("T") || !sliced.includes(":") || !sliced.includes("-")) throw new Invalid(INVALID_TIME);
    throw new HandBackToRails("a local_time that is not YYYY-MM-DDTHH:MM but has its separators");
  }
  const [year, month, day, hour, minute] = match.slice(1).map(Number) as [number, number, number, number, number];
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const date = new Date(wall);
  // strptime rejects what Time.utc would roll over: February 30, an hour of 24.
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day || hour > 23 || minute > 59)
    throw new Invalid(INVALID_TIME);
  const day_ms = 86_400_000;
  const candidates = new Set([offsetMinutesAt(wall - day_ms, zone), offsetMinutesAt(wall + day_ms, zone)]);
  const valid = [...candidates].filter((offset) => offsetMinutesAt(wall - offset * 60_000, zone) === offset);
  if (valid.length === 0)
    throw new Invalid(`That time doesn't exist in ${zone} because clocks skip forward. Choose a different time.`);
  if (valid.length > 1)
    throw new Invalid(`That time happens twice in ${zone} because clocks go back. Choose a different time.`);
  return wall - valid[0]! * 60_000;
}

// ProductPublishSchedule#local_time_label: "%B %-d, %Y at %-l:%M %p %Z".
export function localTimeLabel(publishAt: number, zone: string): string {
  const offset = offsetMinutesAt(publishAt, zone);
  const tzinfo = TZINFO_ABBREVIATIONS[zone]?.[offset];
  if (tzinfo === undefined && !INTL_ABBREVIATED_ZONES.has(zone))
    throw new HandBackToRails("a time zone whose abbreviation is not proven");
  const local = new Date(publishAt + offset * 60_000);
  const abbreviation =
    tzinfo ??
    (zone === "Etc/UTC"
      ? "UTC"
      : new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "short" })
          .formatToParts(new Date(publishAt))
          .find((part) => part.type === "timeZoneName")!.value);
  const hour = local.getUTCHours() % 12 === 0 ? 12 : local.getUTCHours() % 12;
  const minute = String(local.getUTCMinutes()).padStart(2, "0");
  return `${MONTHS[local.getUTCMonth()]} ${local.getUTCDate()}, ${local.getUTCFullYear()} at ${hour}:${minute} ${local.getUTCHours() < 12 ? "AM" : "PM"} ${abbreviation}`;
}

const exists = async (sql: Prisma.Sql) => {
  const [row] = await selectRows<{ found: number | bigint }>(sql);
  return Number(row?.found ?? 0) > 0;
};

// Link#publish_precheck_error up to what Node reads: the first refusal in Rails' order, or null when the publish gates pass.
async function precheckError(product: Product, seller: Seller): Promise<string | null> {
  if (seller.email === null || seller.email.trim() === "") return EMAIL_REQUIRED;
  if (LinkFlags.isSet(product.flags, "is_unpublished_by_admin")) return UNPUBLISHED_BY_ADMIN_MESSAGE;
  const held = await exists(
    Prisma.sql`SELECT EXISTS (SELECT 1 FROM ${table("product_sales_holds")} WHERE ${column("product_sales_holds", "product_id")} = ${product.id} AND ${column("product_sales_holds", "released_at")} IS NULL) AS found`,
  );
  if (held) return UNPUBLISHED_BY_ADMIN_MESSAGE;
  if (LinkFlags.isSet(product.flags, "is_physical")) {
    // enforce_shipping_destinations_presence!: with no destination row at all, `shippable_country_codes` is empty and the message
    // needs no supported-country check. Any alive destination decides by country lists Node does not read here.
    const destinations = await exists(
      Prisma.sql`SELECT EXISTS (SELECT 1 FROM ${table("shipping_destinations")} WHERE ${column("shipping_destinations", "link_id")} = ${product.id} AND ${column("shipping_destinations", "deleted_at")} IS NULL) AS found`,
    );
    if (destinations) throw new HandBackToRails("a physical product with a shipping destination");
    return NO_SHIPPING_DESTINATION;
  }
  if (seller.confirmed_at === null) return EMAIL_CONFIRMATION_MESSAGE;
  if (product.draft && (await isFeatureEnabled("seller_plan_gate", userActor(seller.id))))
    throw new HandBackToRails("a first publish in the seller plan experiment");
  if (seller.payment_address === null || seller.payment_address.trim() === "")
    throw new HandBackToRails("a seller whose payout method is not a payment address");
  return null;
}

// ProductPublishSchedule.ineligibility_reason
async function ineligibilityReason(product: Product, seller: Seller): Promise<string | null> {
  if (!(product.draft && product.first_published_at === null)) return NEVER_PUBLISHED_ONLY;
  if (product.deleted_at !== null || product.banned_at !== null || LinkFlags.isSet(product.flags, "archived"))
    return CANNOT_SCHEDULE;
  if (LinkFlags.isSet(product.flags, "is_in_preorder_state")) return NO_PREORDERS;
  if (seller.user_risk_state !== null && SUSPENDED_STATES.has(seller.user_risk_state)) return SUSPENDED;
  return precheckError(product, seller);
}

const refusal = (message: string): ActionResult =>
  json({ success: false, error_message: message }, UNPROCESSABLE_ENTITY);

async function readSeller(id: bigint): Promise<Seller> {
  const [row] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`users`.*")} FROM ${table("users")} WHERE ${column("users", "id")} = ${id} LIMIT 1`,
  );
  return castRow<User>("User", row!);
}

// POST /links/:link_id/publish_schedule
async function createSchedule(input: MutationInput): Promise<ActionResult> {
  const found = await fetchProduct(input);
  if (found.halt) return found.halt;
  const seller = await readSeller(input.context.currentSeller!.id);
  const scheduledBy = railsLoggedInUser(input.context)!;
  const now = new Date();
  try {
    if (!(await isFeatureEnabled(FEATURE_FLAG, userActor(seller.id)))) throw new Invalid(NOT_AVAILABLE);
    let zone: string;
    try {
      zone = timezoneId(seller.timezone);
    } catch (error) {
      if (error instanceof TimeZoneNotPortedError) throw new HandBackToRails("a time zone outside the mapping");
      throw error;
    }
    const publishAt = parseLocalTime(input.params.local_time, zone);
    if (publishAt < now.getTime() + MIN_LEAD_TIME_MS) throw new Invalid(MIN_LEAD_TIME);
    const label = localTimeLabel(publishAt, zone);
    // Nothing above wrote. `product.lock!` serializes concurrent requests for the product and reloads it.
    return await transaction(async () => {
      const locked = await readProduct(Prisma.sql`${column("links", "id")} = ${found.product.id}`, true);
      const reason = await ineligibilityReason(locked!, await readSeller(seller.id));
      if (reason !== null) throw new Invalid(reason);
      const schedules = "product_publish_schedules";
      await execute(
        Prisma.sql`DELETE FROM ${table(schedules)} WHERE ${column(schedules, "product_id")} = ${locked!.id} AND ${column(schedules, "status")} = 'failed'`,
      );
      if (
        await exists(
          Prisma.sql`SELECT EXISTS (SELECT 1 FROM ${table(schedules)} WHERE ${column(schedules, "product_id")} = ${locked!.id}) AS found`,
        )
      )
        throw new Invalid(ALREADY_SCHEDULED);
      await execute(
        Prisma.sql`INSERT INTO ${table(schedules)} (${Prisma.raw("`product_id`, `scheduled_by_id`, `publish_at`, `status`, `created_at`, `updated_at`")}) VALUES (${locked!.id}, ${scheduledBy.id}, ${new Date(publishAt)}, 'scheduled', ${now}, ${now})`,
      );
      return json({ success: true, publish_schedule: { status: "scheduled", label, failure_message: null } });
    });
  } catch (error) {
    if (error instanceof Invalid) return refusal(error.message);
    throw error;
  }
}

// DELETE /links/:link_id/publish_schedule: cancels a pending schedule or dismisses a saved failure, never a claimed one.
async function destroySchedule(input: MutationInput): Promise<ActionResult> {
  const found = await fetchProduct(input);
  if (found.halt) return found.halt;
  const schedules = "product_publish_schedules";
  const removed = await execute(
    Prisma.sql`DELETE FROM ${table(schedules)} WHERE ${column(schedules, "product_id")} = ${found.product.id} AND ${column(schedules, "status")} IN ('scheduled', 'failed')`,
  );
  return removed === 0 ? refusal(NO_SCHEDULE) : json({ success: true });
}

registerMutations(
  { method: "POST", pattern: "/links/:link_id/publish_schedule", json: true, run: createSchedule },
  { method: "DELETE", pattern: "/links/:link_id/publish_schedule", json: true, run: destroySchedule },
);
