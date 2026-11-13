// Products::PublishSchedulesController (app/controllers/products/publish_schedules_controller.rb): scheduling and cancelling the
// publication of a never-published draft, on `/links/:link_id/publish_schedule`.
//
// Recorded from Rails by spec/requests/products_publish_schedules_parity_spec.rb. Handed to Rails before any write: a time that is
// not `YYYY-MM-DDTHH:MM` (Ruby's strptime accepts other spellings), a seller in a time zone whose abbreviation `%Z` is not proven, a
// physical product (its shipping destinations), and the paid-publish experiment or a payout method other than an address, whose
// refusals `Link#publish_precheck_error` words from data Node does not read.
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
const ABBREVIATED_ZONES = new Set(["America/Los_Angeles", "America/New_York", "Etc/UTC"]);
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
function parseLocalTime(value: unknown, zone: string): number {
  if (value !== undefined && value !== null && typeof value !== "string")
    throw new HandBackToRails("a local_time that is not text");
  if (value === undefined || value === null || value === "") throw new Invalid(INVALID_TIME);
  const match = LOCAL_TIME.exec(value.slice(0, 16).replace(" ", "T"));
  if (match === null) throw new HandBackToRails("a local_time that is not YYYY-MM-DDTHH:MM");
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
function localTimeLabel(publishAt: number, zone: string): string {
  if (!ABBREVIATED_ZONES.has(zone)) throw new HandBackToRails("a time zone whose abbreviation is not proven");
  const local = new Date(publishAt + offsetMinutesAt(publishAt, zone) * 60_000);
  const abbreviation =
    zone === "Etc/UTC"
      ? "UTC"
      : new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "short" })
          .formatToParts(new Date(publishAt))
          .find((part) => part.type === "timeZoneName")!.value;
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
  if (LinkFlags.isSet(product.flags, "is_physical"))
    throw new HandBackToRails("a physical product, whose shipping destinations are read");
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
